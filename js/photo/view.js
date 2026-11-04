// Viewport: zoom / pan, composited rendering, marching ants, pointer routing.
import { el } from '../ui.js';

const ZOOM_STEPS = [0.02, 0.03, 0.05, 0.0667, 0.1, 0.125, 0.1667, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
// Click-once tools: on touch they run when the finger lifts, so a second finger can still turn the tap into a pinch.
const TAP_TOOLS = new Set(['bucket', 'wand', 'zoom', 'text']);
// On touch a stroke starts after TOUCH_DELAY ms or once the finger travels TOUCH_SLOP px, whichever comes first.
const TOUCH_DELAY = 90, TOUCH_SLOP = 6;

export class View {
  constructor(ed, host) {
    this.ed = ed;
    this.host = host;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.ants = 0;
    this.pointer = null; // last pointer position in document coords (for brush cursors)
    this.canvas = host.appendChild(el('canvas', { class: 'pe-canvas' }));
    this.ctx = this.canvas.getContext('2d');
    this.pending = false;
    this.spaceDown = false;
    this.drag = null;
    this.gesture = null;
    this.keepCenter = false; // compact layouts: keep the image centered when the viewport resizes (sheets, drawers)
    new ResizeObserver(() => this.resize()).observe(host);
    setInterval(() => {
      if (this.ed.doc?.selection.active && !this.ed.root.classList.contains('hidden')) { this.ants = (this.ants + 1) % 8; this.render(); }
    }, 120);
    this.bindPointer();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    const first = !this.cw;
    if (!first && this.keepCenter && this.ed.doc && (w !== this.cw || h !== this.ch)) {
      this.panX += (w - this.cw) / 2;
      this.panY += (h - this.ch) / 2;
      this.cw = w; this.ch = h;
      this.ed.emit('view');
    }
    this.cw = w; this.ch = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    if (first || this.fitPending) this.fit();
    this.draw();
  }

  fit() {
    const d = this.ed.doc;
    if (!d) return;
    if (!this.cw) { this.fitPending = true; return; }
    this.fitPending = false;
    const z = Math.min((this.cw - 48) / d.width, (this.ch - 48) / d.height, 16);
    this.setZoom(Math.max(0.01, z));
    this.center();
  }

  center() {
    const d = this.ed.doc;
    this.panX = Math.round((this.cw - d.width * this.zoom) / 2);
    this.panY = Math.round((this.ch - d.height * this.zoom) / 2);
    this.changed();
  }

  // Zoom keeping screen point (sx, sy) fixed (defaults to viewport center).
  setZoom(z, sx = this.cw / 2, sy = this.ch / 2) {
    z = Math.max(0.01, Math.min(32, z));
    const dx = (sx - this.panX) / this.zoom, dy = (sy - this.panY) / this.zoom;
    this.zoom = z;
    this.panX = sx - dx * z;
    this.panY = sy - dy * z;
    this.changed();
  }

  zoomStep(dir, sx, sy) {
    const z = this.zoom;
    const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z * 1.001) ?? 32 : [...ZOOM_STEPS].reverse().find((s) => s < z / 1.001) ?? 0.01;
    this.setZoom(next, sx, sy);
  }

  actual() { this.setZoom(1); this.center(); }

  changed() { this.ed.emit('view'); this.render(); }

  toDoc(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (clientX - r.left - this.panX) / this.zoom, y: (clientY - r.top - this.panY) / this.zoom };
  }

  toScreen(x, y) { return { x: x * this.zoom + this.panX, y: y * this.zoom + this.panY }; }

  render() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.draw(); });
  }

  checkerPattern() {
    if (!this._checker) {
      const c = document.createElement('canvas');
      c.width = c.height = 16;
      const x = c.getContext('2d');
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, 16, 16);
      x.fillStyle = '#d8dadf'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
      this._checker = this.ctx.createPattern(c, 'repeat');
    }
    return this._checker;
  }

  draw() {
    const { ctx, ed } = this;
    if (!this.cw) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cw, this.ch);
    const d = ed.doc;
    if (!d) return;
    const w = d.width * this.zoom, h = d.height * this.zoom;
    ctx.save();
    ctx.shadowColor = '#0009';
    ctx.shadowBlur = 18;
    ctx.fillStyle = this.checkerPattern();
    ctx.translate(this.panX, this.panY);
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    ctx.imageSmoothingEnabled = this.zoom < 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(d.composite(), this.panX, this.panY, w, h);
    ctx.imageSmoothingEnabled = true;
    if (d.selection.active) this.drawAnts(d.selection.outline());
    ed.toolObj?.overlay?.(ctx, this, ed);
  }

  // Marching ants for a Path2D in document coordinates.
  drawAnts(path) {
    const { ctx, zoom } = this;
    ctx.save();
    ctx.translate(this.panX + (this.selOffset?.x || 0) * zoom, this.panY + (this.selOffset?.y || 0) * zoom);
    ctx.scale(zoom, zoom);
    ctx.lineWidth = 1 / zoom;
    ctx.setLineDash([4 / zoom, 4 / zoom]);
    ctx.strokeStyle = '#000';
    ctx.lineDashOffset = -this.ants / zoom;
    ctx.stroke(path);
    ctx.strokeStyle = '#fff';
    ctx.lineDashOffset = (4 - this.ants) / zoom;
    ctx.stroke(path);
    ctx.restore();
  }

  bindPointer() {
    const cv = this.canvas;
    const touches = new Map(); // active touch points on the canvas: id -> { x, y }
    const local = (x, y) => { const r = cv.getBoundingClientRect(); return { x: x - r.left, y: y - r.top }; };

    // Start the deferred touch stroke: replay the original down and any queued moves.
    const flush = () => {
      const d = this.drag;
      if (!d?.pending) return;
      clearTimeout(d.timer);
      d.pending = false;
      this.ed.pointer('down', d.down, this.toDoc(d.down.clientX, d.down.clientY));
      for (const m of d.queue) this.ed.pointer('move', m, this.toDoc(m.clientX, m.clientY));
      d.queue = null;
    };

    // Two fingers: drop any one-finger action without side effects, then pinch / pan.
    const startGesture = () => {
      const d = this.drag;
      if (d) {
        clearTimeout(d.timer);
        if (!d.pan && !d.pending) this.ed.abortPointer();
        this.drag = null;
        this.host.classList.remove('panning');
      }
      const [a, b] = [...touches.values()];
      const m = local((a.x + b.x) / 2, (a.y + b.y) / 2);
      this.gesture = {
        dist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), zoom: this.zoom,
        anchor: { x: (m.x - this.panX) / this.zoom, y: (m.y - this.panY) / this.zoom },
      };
      this.pointer = null;
      this.render();
    };

    const moveGesture = () => {
      const g = this.gesture;
      const [a, b] = [...touches.values()];
      if (!g || !b) return;
      const m = local((a.x + b.x) / 2, (a.y + b.y) / 2);
      const z = Math.max(0.01, Math.min(32, g.zoom * (Math.hypot(b.x - a.x, b.y - a.y) / g.dist)));
      this.zoom = z;
      this.panX = m.x - g.anchor.x * z;
      this.panY = m.y - g.anchor.y * z;
      this.changed();
    };

    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      if (!this.ed.doc) return;
      const touch = e.pointerType === 'touch';
      if (touch) {
        e.preventDefault(); // no emulated mouse events, so an open text box keeps focus
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        cv.setPointerCapture(e.pointerId);
        if (touches.size >= 2) { startGesture(); return; }
        if (this.gesture) return;
      }
      if (this.drag) return;
      cv.setPointerCapture(e.pointerId);
      const panning = e.button === 1 || this.spaceDown || this.ed.tool === 'hand';
      if (panning) {
        this.drag = { pan: true, sx: e.clientX, sy: e.clientY, px: this.panX, py: this.panY, id: e.pointerId };
        this.host.classList.add('panning');
        return;
      }
      if (e.button !== 0) return;
      if (touch && !this.ed.session) {
        const tap = TAP_TOOLS.has(this.ed.tool);
        this.drag = { pan: false, id: e.pointerId, pending: true, tap, down: e, queue: [], touch: true };
        if (!tap) this.drag.timer = setTimeout(flush, TOUCH_DELAY);
        return;
      }
      this.drag = { pan: false, id: e.pointerId, touch };
      this.ed.pointer('down', e, this.toDoc(e.clientX, e.clientY));
    });
    cv.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.gesture) { moveGesture(); return; }
      }
      const p = this.toDoc(e.clientX, e.clientY);
      this.pointer = p;
      this.ed.emit('cursor', p);
      if (this.drag?.pan) {
        this.panX = this.drag.px + e.clientX - this.drag.sx;
        this.panY = this.drag.py + e.clientY - this.drag.sy;
        this.changed();
        return;
      }
      const d = this.drag;
      if (d?.pending) {
        if (d.tap) return;
        const events = e.getCoalescedEvents?.() || [];
        d.queue.push(...(events.length ? events : [e]));
        if (Math.hypot(e.clientX - d.down.clientX, e.clientY - d.down.clientY) >= TOUCH_SLOP) flush();
        return;
      }
      if (d) {
        const events = e.getCoalescedEvents?.() || [e];
        for (const ce of events.length ? events : [e]) this.ed.pointer('move', ce, this.toDoc(ce.clientX, ce.clientY));
      } else if (e.pointerType !== 'touch') {
        this.ed.pointer('hover', e, p);
      }
    });
    const end = (e) => {
      if (e.pointerType === 'touch' && touches.delete(e.pointerId) && this.gesture) {
        if (touches.size >= 2) startGesture();
        else if (!touches.size) this.gesture = null;
        return;
      }
      if (!this.drag || this.drag.id !== e.pointerId) return;
      const d = this.drag;
      this.drag = null;
      this.host.classList.remove('panning');
      if (d.pan) return;
      if (d.touch && e.type === 'pointercancel') {
        // The browser took the touch over: undo the partial stroke rather than committing it.
        clearTimeout(d.timer);
        if (!d.pending) this.ed.abortPointer();
      } else if (d.pending && d.tap) {
        const p = this.toDoc(d.down.clientX, d.down.clientY);
        this.ed.pointer('down', d.down, p);
        this.ed.pointer('up', d.down, p);
      } else {
        this.drag = d;
        flush();
        this.drag = null;
        this.ed.pointer('up', e, this.toDoc(e.clientX, e.clientY));
      }
      if (d.touch) { this.pointer = null; this.render(); }
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { if (!this.drag) { this.pointer = null; this.render(); } });
    cv.addEventListener('wheel', (e) => {
      if (!this.ed.doc) return;
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || e.altKey) {
        const f = Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 50 ? 0.01 : 0.0025));
        this.setZoom(this.zoom * f, e.clientX - r.left, e.clientY - r.top);
      } else {
        this.panX -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        this.panY -= e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        this.changed();
      }
    }, { passive: false });
  }
}
