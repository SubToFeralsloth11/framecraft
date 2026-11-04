// Viewport: zoom / pan, composited rendering, marching ants, pointer routing.
import { el } from '../ui.js';

const ZOOM_STEPS = [0.02, 0.03, 0.05, 0.0667, 0.1, 0.125, 0.1667, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];

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
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      if (!this.ed.doc || this.drag) return;
      cv.setPointerCapture(e.pointerId);
      const panning = e.button === 1 || this.spaceDown || this.ed.tool === 'hand';
      if (panning) {
        this.drag = { pan: true, sx: e.clientX, sy: e.clientY, px: this.panX, py: this.panY, id: e.pointerId };
        this.host.classList.add('panning');
        return;
      }
      if (e.button !== 0) return;
      this.drag = { pan: false, id: e.pointerId };
      this.ed.pointer('down', e, this.toDoc(e.clientX, e.clientY));
    });
    cv.addEventListener('pointermove', (e) => {
      const p = this.toDoc(e.clientX, e.clientY);
      this.pointer = p;
      this.ed.emit('cursor', p);
      if (this.drag?.pan) {
        this.panX = this.drag.px + e.clientX - this.drag.sx;
        this.panY = this.drag.py + e.clientY - this.drag.sy;
        this.changed();
        return;
      }
      if (this.drag) {
        const events = e.getCoalescedEvents?.() || [e];
        for (const ce of events.length ? events : [e]) this.ed.pointer('move', ce, this.toDoc(ce.clientX, ce.clientY));
      } else {
        this.ed.pointer('hover', e, p);
      }
    });
    const end = (e) => {
      if (!this.drag || this.drag.id !== e.pointerId) return;
      const d = this.drag;
      this.drag = null;
      this.host.classList.remove('panning');
      if (!d.pan) this.ed.pointer('up', e, this.toDoc(e.clientX, e.clientY));
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
