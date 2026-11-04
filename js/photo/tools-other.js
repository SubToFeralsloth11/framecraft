// Fill & draw tools (bucket, gradient, shapes, text), eyedropper, hand and zoom.
import { el, toast } from '../ui.js';
import { iconEl } from '../icons.js';
import { License } from '../license.js';
import { CONFIG } from '../config.js';
import { floodMask, hexToRgb, rgbToHex } from './pixels.js';
import { StrokeSession } from './tools-paint.js';
import { optRange, optCheck, optSelect, optSeg, optColor, optButton, hint } from './opts.js';

// ---------- Paint bucket ----------

export const bucket = {
  id: 'bucket', name: 'Paint bucket', key: 'G', icon: 'bucket', cursor: 'crosshair',
  defaults: { tolerance: 32, contiguous: true, opacity: 100, sampleAll: false },
  options: (ed) => [
    optRange(ed, 'bucket', 'tolerance', 'Tolerance', { min: 0, max: 255 }),
    optRange(ed, 'bucket', 'opacity', 'Opacity', { min: 1, max: 100, unit: '%' }),
    optCheck(ed, 'bucket', 'contiguous', 'Contiguous'),
    optCheck(ed, 'bucket', 'sampleAll', 'Sample all layers'),
    hint('Alt+Backspace fills the selection with the foreground color'),
  ],
  down(ed, e, p) {
    const layer = ed.editableLayer();
    if (!layer) return;
    const d = ed.doc, o = ed.opts.bucket, W = d.width, H = d.height;
    if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H || !d.selection.contains(p.x, p.y)) return;
    const src = o.sampleAll ? d.composite() : layer.canvas;
    const mask = floodMask(src.getContext('2d').getImageData(0, 0, W, H).data, W, H, p.x, p.y, o.tolerance, o.contiguous);
    const selMask = d.selection.active ? d.selection.maskRegion(0, 0, W, H) : null;
    const [r, g, b] = hexToRgb(ed.fg);
    const fill = new ImageData(W, H), fd = fill.data;
    for (let q = 0, i = 0; q < mask.length; q++, i += 4) {
      const a = selMask ? (mask[q] * selMask[q]) / 255 : mask[q];
      if (!a) continue;
      fd[i] = r; fd[i + 1] = g; fd[i + 2] = b; fd[i + 3] = a;
    }
    const tmp = ed.scratch('tmp');
    tmp.ctx.putImageData(fill, 0, 0);
    layer.ctx.save();
    layer.ctx.globalAlpha = o.opacity / 100;
    layer.ctx.drawImage(tmp.canvas, 0, 0);
    layer.ctx.restore();
    d.commit('Paint bucket');
  },
};

// ---------- Gradient ----------

function snapAngle(a, b) {
  const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(b.x - a.x, b.y - a.y);
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}

export const gradient = {
  id: 'gradient', name: 'Gradient', key: 'G', icon: 'gradient', cursor: 'crosshair',
  defaults: { type: 'linear', colors: 'fgbg', opacity: 100, reverse: false },
  options: (ed) => [
    optSeg(ed, 'gradient', 'type', [['linear', 'Linear'], ['radial', 'Radial']]),
    optSelect(ed, 'gradient', 'colors', '', [['fgbg', 'Foreground → Background'], ['fgclear', 'Foreground → Transparent']]),
    optRange(ed, 'gradient', 'opacity', 'Opacity', { min: 1, max: 100, unit: '%' }),
    optCheck(ed, 'gradient', 'reverse', 'Reverse'),
    hint('Drag to draw · Shift snaps to 45°'),
  ],
  down(ed, e, p) {
    if (!ed.editableLayer()) return;
    this.s = new StrokeSession(ed, { opacity: ed.opts.gradient.opacity / 100 });
    this.a = p; this.b = p;
  },
  abort() { if (this.s) { this.s.cancel(); this.s = null; } },
  move(ed, e, p) {
    if (!this.s) return;
    this.b = e.shiftKey ? snapAngle(this.a, p) : p;
    this.draw(ed);
  },
  draw(ed) {
    const o = ed.opts.gradient, { a, b } = this, d = ed.doc;
    const [r, g, bl] = hexToRgb(ed.fg);
    let c0 = ed.fg, c1 = o.colors === 'fgbg' ? ed.bg : `rgba(${r},${g},${bl},0)`;
    if (o.reverse) [c0, c1] = [c1, c0];
    this.s.redraw((ctx) => {
      const grad = o.type === 'radial'
        ? ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)))
        : ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      grad.addColorStop(0, c0);
      grad.addColorStop(1, c1);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, d.width, d.height);
    });
  },
  up(ed) {
    if (!this.s) return;
    const s = this.s;
    this.s = null;
    if (Math.hypot(this.b.x - this.a.x, this.b.y - this.a.y) < 1) { s.cancel(); return; }
    ed.doc.commit('Gradient');
  },
  overlay(ctx, view) {
    if (!this.s) return;
    const a = view.toScreen(this.a.x, this.a.y), b = view.toScreen(this.b.x, this.b.y);
    ctx.save();
    ctx.strokeStyle = '#fff'; ctx.shadowColor = '#000'; ctx.shadowBlur = 3; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    for (const q of [a, b]) { ctx.beginPath(); ctx.arc(q.x, q.y, 4, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
  },
};

// ---------- Shapes ----------

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export const shape = {
  id: 'shape', name: 'Shapes', key: 'U', icon: 'shapes', cursor: 'crosshair',
  defaults: { shape: 'rect', fill: true, stroke: false, strokeColor: '#000000', strokeWidth: 4, radius: 0, opacity: 100, newLayer: false },
  options: (ed) => [
    optSeg(ed, 'shape', 'shape', [['rect', [iconEl('rect', 15), 'Rect']], ['ellipse', [iconEl('circle', 15), 'Ellipse']], ['line', [iconEl('line', 15), 'Line']]]),
    optCheck(ed, 'shape', 'fill', 'Fill (foreground)'),
    optCheck(ed, 'shape', 'stroke', 'Stroke'),
    optColor(ed, 'shape', 'strokeColor', ''),
    optRange(ed, 'shape', 'strokeWidth', 'Width', { min: 1, max: 200, unit: 'px' }),
    optRange(ed, 'shape', 'radius', 'Radius', { min: 0, max: 500, unit: 'px' }),
    optRange(ed, 'shape', 'opacity', 'Opacity', { min: 1, max: 100, unit: '%' }),
    optCheck(ed, 'shape', 'newLayer', 'New layer'),
    hint('Shift: square / 45° · Alt: from center'),
  ],
  down(ed, e, p) {
    const o = ed.opts.shape;
    if (o.newLayer && !ed.doc.addLayer(o.shape === 'line' ? 'Line' : o.shape === 'rect' ? 'Rectangle' : 'Ellipse')) return;
    if (!ed.editableLayer()) return;
    this.s = new StrokeSession(ed, { opacity: o.opacity / 100 });
    this.added = o.newLayer;
    this.a = p; this.b = p; this.e = e;
  },
  abort(ed) {
    if (!this.s) return;
    this.s.cancel();
    this.s = null;
    if (this.added) ed.doc.deleteLayer();
  },
  move(ed, e, p) {
    if (!this.s) return;
    this.b = p; this.e = e;
    this.draw(ed);
  },
  geometry(ed) {
    const { a, e } = this;
    let b = this.b;
    if (ed.opts.shape.shape === 'line') return { line: [a, e.shiftKey ? snapAngle(a, b) : b] };
    let dx = b.x - a.x, dy = b.y - a.y;
    if (e.shiftKey) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m; }
    if (e.altKey) return { x: a.x - Math.abs(dx), y: a.y - Math.abs(dy), w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 };
    return { x: Math.min(a.x, a.x + dx), y: Math.min(a.y, a.y + dy), w: Math.abs(dx), h: Math.abs(dy) };
  },
  draw(ed) {
    const o = ed.opts.shape, g = this.geometry(ed);
    this.s.redraw((ctx) => {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      if (g.line) {
        ctx.moveTo(g.line[0].x, g.line[0].y); ctx.lineTo(g.line[1].x, g.line[1].y);
        ctx.strokeStyle = o.stroke ? o.strokeColor : ed.fg;
        ctx.lineWidth = o.strokeWidth;
        ctx.stroke();
        return;
      }
      if (o.shape === 'ellipse') ctx.ellipse(g.x + g.w / 2, g.y + g.h / 2, g.w / 2, g.h / 2, 0, 0, Math.PI * 2);
      else roundRectPath(ctx, g.x, g.y, g.w, g.h, o.radius);
      if (o.fill) { ctx.fillStyle = ed.fg; ctx.fill(); }
      if (o.stroke) { ctx.strokeStyle = o.strokeColor; ctx.lineWidth = o.strokeWidth; ctx.stroke(); }
    });
  },
  up(ed) {
    if (!this.s) return;
    const s = this.s, o = ed.opts.shape;
    this.s = null;
    if (Math.hypot(this.b.x - this.a.x, this.b.y - this.a.y) < 1 || (!o.fill && !o.stroke && o.shape !== 'line')) {
      s.cancel();
      if (!o.fill && !o.stroke) toast('Turn on Fill or Stroke', 'warn');
      return;
    }
    ed.doc.commit(o.shape === 'line' ? 'Line' : o.shape === 'rect' ? 'Rectangle' : 'Ellipse');
  },
};

// ---------- Text ----------

const COARSE = matchMedia('(pointer: coarse)');

export const FONTS = ['system-ui', 'Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Trebuchet MS', 'Impact', 'Palatino', 'Futura', 'Avenir', 'Comic Sans MS', 'serif', 'sans-serif', 'monospace', 'cursive'];

export const text = {
  id: 'text', name: 'Text', key: 'T', icon: 'text', cursor: 'text',
  defaults: { font: 'system-ui', size: 72, bold: false, italic: false, align: 'left', lineHeight: 1.2 },
  options: (ed) => [
    optSelect(ed, 'text', 'font', 'Font', FONTS.map((f) => [f, f])),
    optRange(ed, 'text', 'size', 'Size', { min: 4, max: 1000, unit: 'px' }),
    optCheck(ed, 'text', 'bold', 'Bold'),
    optCheck(ed, 'text', 'italic', 'Italic'),
    optSeg(ed, 'text', 'align', [['left', iconEl('alignLeft', 15), 'Align left'], ['center', iconEl('alignCenter', 15), 'Align center'], ['right', iconEl('alignRight', 15), 'Align right']]),
    optButton([iconEl('check', 16), 'Commit'], () => text.commit(ed), { class: 'btn primary', title: 'Ctrl/Cmd+Enter' }),
    optButton('Cancel', () => text.cancel(ed), { title: 'Esc' }),
    hint('Click or tap to type · color = foreground'),
  ],
  init(ed) {
    const restyle = () => this.edit && this.style(ed);
    ed.on('view', restyle);
    ed.on('opts', restyle);
    ed.on('colors', restyle);
  },
  font(o, size) { return `${o.italic ? 'italic ' : ''}${o.bold ? '700' : '400'} ${size}px ${/\s/.test(o.font) ? `"${o.font}"` : o.font}`; },
  down(ed, e, p) {
    if (this.edit) { this.commit(ed); return; }
    this.edit = { x: p.x, y: p.y };
    const ta = el('textarea', { class: 'pe-text-edit', spellcheck: false, wrap: 'off', autocapitalize: 'sentences', 'aria-label': 'Text' });
    ta.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') { ev.preventDefault(); this.cancel(ed); }
      else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); this.commit(ed); }
    });
    ta.addEventListener('input', () => this.style(ed));
    this.edit.ta = ta;
    ed.view.host.append(ta);
    this.style(ed);
    // Focus synchronously so touch browsers open the on-screen keyboard (this runs inside the tap),
    // and again after the mouse default action, which moves focus off the canvas on desktop.
    ta.focus({ preventScroll: true });
    setTimeout(() => ta.focus({ preventScroll: true }), 0);
  },
  style(ed) {
    const { ta, x, y } = this.edit, o = ed.opts.text, z = ed.view.zoom;
    const s = ed.view.toScreen(x, y);
    // iOS zooms the page when a focused field's font is under 16px: lay the box out at 16px and scale it down.
    const px = o.size * z, fontPx = COARSE.matches ? Math.max(16, px) : px, k = px / fontPx;
    Object.assign(ta.style, { font: this.font(o, fontPx), lineHeight: String(o.lineHeight), color: ed.fg, textAlign: o.align,
      transform: k === 1 ? '' : `scale(${k})`, transformOrigin: '0 0' });
    ta.style.height = '0px';
    ta.style.width = '0px';
    const w = Math.max(40 / k, ta.scrollWidth + 4), h = Math.max(fontPx * o.lineHeight, ta.scrollHeight);
    ta.style.width = `${w}px`;
    ta.style.height = `${h}px`;
    const vw = w * k;
    const left = o.align === 'center' ? s.x - vw / 2 : o.align === 'right' ? s.x - vw : s.x;
    ta.style.left = `${left}px`;
    ta.style.top = `${s.y}px`;
  },
  cancel(ed) {
    if (!this.edit) return;
    this.edit.ta.remove();
    this.edit = null;
    ed.render();
  },
  commit(ed) {
    if (!this.edit) return;
    const { ta, x, y } = this.edit;
    const value = ta.value.replace(/\s+$/, '');
    this.cancel(ed);
    if (!value.trim()) return;
    const d = ed.doc, o = ed.opts.text;
    const canNew = d.layers.length < CONFIG.free.photoMaxLayers || License.isPro();
    const layer = canNew ? d.addLayer(`Text: ${value.split('\n')[0].slice(0, 24)}`, d.active + 1, { force: true }) : ed.editableLayer();
    if (!layer) return;
    if (!canNew) toast('Layer limit reached: text drawn on the active layer', 'warn', 3500);
    const c = layer.ctx;
    c.save();
    c.font = this.font(o, o.size);
    c.fillStyle = ed.fg;
    c.textBaseline = 'top';
    c.textAlign = o.align;
    value.split('\n').forEach((line, i) => c.fillText(line, x, y + i * o.size * o.lineHeight + o.size * (o.lineHeight - 1) / 2));
    c.restore();
    d.commit('Text', layer);
  },
  deactivate(ed) { this.commit(ed); },
};

// ---------- Eyedropper ----------

export function samplePixel(ed, x, y, size = 1, merged = true) {
  const d = ed.doc;
  const src = merged ? d.composite() : d.layer.canvas;
  const r = Math.floor(size / 2);
  const x0 = Math.max(0, Math.floor(x) - r), y0 = Math.max(0, Math.floor(y) - r);
  const w = Math.min(d.width, Math.floor(x) + r + 1) - x0, h = Math.min(d.height, Math.floor(y) + r + 1) - y0;
  if (w <= 0 || h <= 0) return null;
  const data = src.getContext('2d').getImageData(x0, y0, w, h).data;
  let R = 0, G = 0, B = 0, A = 0;
  for (let i = 0; i < data.length; i += 4) { const a = data[i + 3]; R += data[i] * a; G += data[i + 1] * a; B += data[i + 2] * a; A += a; }
  if (!A) return null;
  return rgbToHex(R / A, G / A, B / A);
}

export const eyedropper = {
  id: 'eyedropper', name: 'Eyedropper', key: 'I', icon: 'dropper', cursor: 'crosshair',
  defaults: { size: '1', merged: true },
  options: (ed) => [
    optSelect(ed, 'eyedropper', 'size', 'Sample', [['1', 'Point'], ['3', '3×3 average'], ['5', '5×5 average'], ['11', '11×11 average']]),
    optSeg(ed, 'eyedropper', 'merged', [[true, 'All layers'], [false, 'Current layer']]),
    hint('Click: foreground · Alt-click: background'),
  ],
  abort(ed) {
    if (!this.on) return;
    this.on = false;
    ed.fg = this.prev.fg; ed.bg = this.prev.bg;
    ed.emit('colors');
  },
  pick(ed, e, p) {
    const o = ed.opts.eyedropper;
    const c = samplePixel(ed, p.x, p.y, +o.size, o.merged === true || o.merged === 'true');
    if (c) ed.setColor(e.altKey ? 'bg' : 'fg', c);
  },
  down(ed, e, p) { this.on = true; this.prev = { fg: ed.fg, bg: ed.bg }; this.pick(ed, e, p); },
  move(ed, e, p) { if (this.on) this.pick(ed, e, p); },
  up() { this.on = false; },
};

// ---------- Hand & Zoom ----------

export const hand = {
  id: 'hand', name: 'Hand', key: 'H', icon: 'hand', cursor: 'grab', defaults: {},
  options: (ed) => [optButton('Fit on screen', () => ed.view.fit(), { title: 'Ctrl/Cmd+0' }), optButton('100%', () => ed.view.actual(), { title: 'Ctrl/Cmd+1' }), hint('Drag to pan · hold Space or use two fingers with any tool')],
};

export const zoom = {
  id: 'zoom', name: 'Zoom', key: 'Z', icon: 'zoom', cursor: 'zoom-in', defaults: {},
  options: (ed) => [
    optButton('Zoom in', () => ed.view.zoomStep(1), { title: '+' }),
    optButton('Zoom out', () => ed.view.zoomStep(-1), { title: '-' }),
    optButton('Fit', () => ed.view.fit()),
    optButton('100%', () => ed.view.actual()),
    hint('Click to zoom in · Alt/Option-click to zoom out · pinch on touch'),
  ],
  down(ed, e) {
    const r = ed.view.canvas.getBoundingClientRect();
    ed.view.zoomStep(e.altKey ? -1 : 1, e.clientX - r.left, e.clientY - r.top);
  },
  hover(ed, e) { ed.view.canvas.style.cursor = e.altKey ? 'zoom-out' : 'zoom-in'; },
};

export const otherTools = [bucket, gradient, shape, text, eyedropper, hand, zoom];
