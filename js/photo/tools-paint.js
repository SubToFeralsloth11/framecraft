// Painting tools: brush, pencil, eraser, clone stamp, blur/sharpen, dodge/burn, smudge.
import { toast } from '../ui.js';
import { requirePro } from '../license.js';
import { makeCanvas, clampRect, unionRect, copyCanvas } from './canvas.js';
import { hexToRgb } from './pixels.js';
import { optRange, optSeg, optCheck, hint } from './opts.js';

// ---------- stroke compositing ----------

// Paints into a scratch "stroke" canvas, then rebuilds the touched area of the layer as
// backup + stroke (masked by the selection) at the tool opacity. Overlapping dabs inside one
// stroke therefore never stack opacity, like Photoshop.
export class StrokeSession {
  constructor(ed, { mode = 'source-over', opacity = 1 } = {}) {
    this.ed = ed;
    this.doc = ed.doc;
    this.layer = ed.doc.layer;
    this.mode = mode;
    this.opacity = opacity;
    this.backup = ed.scratch('backup');
    this.backup.ctx.drawImage(this.layer.canvas, 0, 0);
    this.stroke = ed.scratch('stroke');
    this.tmp = ed.scratch('tmp');
    this.dirty = null;
    this.touched = null;
  }

  get ctx() { return this.stroke.ctx; }

  mark(x, y, w, h) {
    const r = clampRect(x - 1, y - 1, w + 2, h + 2, this.doc.width, this.doc.height);
    this.dirty = unionRect(this.dirty, r);
  }

  flush() {
    const r = this.dirty;
    if (!r) return;
    this.dirty = null;
    this.touched = unionRect(this.touched, r);
    const L = this.layer.ctx, sel = this.doc.selection;
    L.save();
    L.clearRect(r.x, r.y, r.w, r.h);
    L.drawImage(this.backup.canvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    let src = this.stroke.canvas;
    if (sel.active) {
      const t = this.tmp.ctx;
      t.clearRect(r.x, r.y, r.w, r.h);
      t.drawImage(src, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      t.globalCompositeOperation = 'destination-in';
      t.drawImage(sel.canvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      t.globalCompositeOperation = 'source-over';
      src = this.tmp.canvas;
    }
    L.globalAlpha = this.opacity;
    L.globalCompositeOperation = this.mode;
    L.drawImage(src, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    L.restore();
    this.doc.changed('pixels');
  }

  // Replace the whole stroke content (shapes, gradients) and refresh.
  redraw(draw) {
    const { width: W, height: H } = this.doc;
    this.ctx.clearRect(0, 0, W, H);
    this.ctx.save();
    draw(this.ctx);
    this.ctx.restore();
    this.dirty = { x: 0, y: 0, w: W, h: H };
    this.flush();
  }

  cancel() {
    const L = this.layer.ctx;
    L.clearRect(0, 0, this.doc.width, this.doc.height);
    L.drawImage(this.backup.canvas, 0, 0);
    this.doc.changed('pixels');
  }
}

// ---------- brush tips & stepping ----------

const tipCache = new Map();
export function makeTip(size, hardness, color, aliased = false) {
  const key = `${size}|${hardness}|${color}|${aliased}`;
  if (tipCache.has(key)) return tipCache.get(key);
  if (tipCache.size > 40) tipCache.clear();
  const d = aliased ? Math.max(1, Math.round(size)) : Math.ceil(size) + 2;
  const c = makeCanvas(d, d), x = c.getContext('2d');
  const [r, g, b] = hexToRgb(color);
  if (aliased) {
    const img = x.createImageData(d, d), rr = d / 2;
    for (let j = 0; j < d; j++) for (let i = 0; i < d; i++) {
      const dx = i + 0.5 - rr, dy = j + 0.5 - rr;
      if (d <= 2 || dx * dx + dy * dy <= rr * rr) { const k = (j * d + i) * 4; img.data.set([r, g, b, 255], k); }
    }
    x.putImageData(img, 0, 0);
  } else {
    const rad = Math.max(0.5, size / 2), h = Math.min(0.99, hardness);
    const grad = x.createRadialGradient(d / 2, d / 2, 0, d / 2, d / 2, rad);
    grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
    grad.addColorStop(h, `rgba(${r},${g},${b},1)`);
    if (h < 0.98) grad.addColorStop((h + 1) / 2, `rgba(${r},${g},${b},0.5)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    x.fillStyle = grad;
    x.beginPath();
    x.arc(d / 2, d / 2, rad, 0, Math.PI * 2);
    x.fill();
  }
  tipCache.set(key, c);
  return c;
}

// Emits evenly spaced dab positions along the pointer path.
export class Stepper {
  constructor(spacing, dab) { this.spacing = Math.max(0.5, spacing); this.dab = dab; this.last = null; this.rest = 0; }
  start(p) { this.last = { ...p }; this.rest = 0; this.dab(p.x, p.y); }
  to(p) {
    const a = this.last;
    if (!a) return this.start(p);
    const dx = p.x - a.x, dy = p.y - a.y, dist = Math.hypot(dx, dy);
    let t = this.spacing - this.rest;
    while (t <= dist) { this.dab(a.x + (dx * t) / dist, a.y + (dy * t) / dist); t += this.spacing; }
    this.rest = dist - (t - this.spacing);
    this.last = { ...p };
  }
}

// Lazy-mouse smoothing: the brush trails the pointer.
class Smoother {
  constructor(amount) { this.k = 1 - Math.min(0.95, amount / 100); this.p = null; }
  reset(p) { this.p = { ...p }; return this.p; }
  next(p) { this.p.x += (p.x - this.p.x) * this.k; this.p.y += (p.y - this.p.y) * this.k; return { ...this.p }; }
}

export function falloff(t, hardness) {
  if (t >= 1) return 0;
  if (t <= hardness) return 1;
  const u = (t - hardness) / (1 - hardness);
  return 1 - u * u * (3 - 2 * u);
}

export function drawBrushCursor(ctx, view, size, extra) {
  const p = view.pointer;
  if (!p) return;
  const s = view.toScreen(p.x, p.y), r = Math.max(1.5, (size / 2) * view.zoom);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#000a';
  ctx.beginPath(); ctx.arc(s.x, s.y, r + 0.5, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#fffd';
  ctx.beginPath(); ctx.arc(s.x, s.y, r - 0.5 > 0 ? r - 0.5 : r, 0, Math.PI * 2); ctx.stroke();
  if (r < 4) { ctx.beginPath(); ctx.moveTo(s.x - 6, s.y); ctx.lineTo(s.x + 6, s.y); ctx.moveTo(s.x, s.y - 6); ctx.lineTo(s.x, s.y + 6); ctx.stroke(); }
  extra?.(ctx);
  ctx.restore();
}

const sizeOpts = (ed, id) => optRange(ed, id, 'size', 'Size', { min: 1, max: 1000, unit: 'px' });

// ---------- brush / pencil / eraser ----------

function paintTool({ id, name, key, icon, mode = 'source-over', aliased = false, defaults, extraOptions }) {
  return {
    id, name, key, icon, cursor: 'crosshair', defaults,
    options: (ed) => [
      sizeOpts(ed, id),
      aliased ? null : optRange(ed, id, 'hardness', 'Hardness', { min: 0, max: 100, unit: '%' }),
      optRange(ed, id, 'opacity', 'Opacity', { min: 1, max: 100, unit: '%' }),
      aliased ? null : optRange(ed, id, 'smoothing', 'Smoothing', { min: 0, max: 90, unit: '%' }),
      ...(extraOptions?.(ed) || []),
      hint('Shift-click: straight line · [ ] size'),
    ],
    down(ed, e, p) {
      if (!ed.editableLayer()) return;
      const o = ed.opts[id];
      const size = o.size;
      const color = mode === 'destination-out' ? '#000000' : ed.fg;
      const tip = makeTip(size, (o.hardness ?? 100) / 100, color, aliased);
      this.s = new StrokeSession(ed, { mode, opacity: o.opacity / 100 });
      const ctx = this.s.ctx;
      const dab = aliased
        ? (x, y) => { const tx = Math.floor(x - tip.width / 2 + 0.5), ty = Math.floor(y - tip.height / 2 + 0.5); ctx.drawImage(tip, tx, ty); this.s.mark(tx, ty, tip.width, tip.height); }
        : (x, y) => { const tx = x - tip.width / 2, ty = y - tip.height / 2; ctx.drawImage(tip, tx, ty); this.s.mark(tx, ty, tip.width, tip.height); };
      this.step = new Stepper(aliased ? 1 : Math.max(1, size * 0.12), dab);
      this.smooth = aliased || !o.smoothing ? null : new Smoother(o.smoothing);
      const last = ed.lastPaint;
      if (e.shiftKey && last) { this.step.start(last); this.step.to(p); } else this.step.start(p);
      this.smooth?.reset(p);
      this.raw = p;
      this.s.flush();
    },
    move(ed, e, p) {
      if (!this.s) return;
      this.raw = p;
      this.step.to(this.smooth ? this.smooth.next(p) : p);
      this.s.flush();
    },
    up(ed) {
      if (!this.s) return;
      if (this.smooth) this.step.to(this.raw);
      this.s.flush();
      ed.lastPaint = { ...this.raw };
      this.s = null;
      ed.doc.commit(name);
    },
    overlay(ctx, view, ed) { drawBrushCursor(ctx, view, ed.opts[id].size); },
  };
}

export const brush = paintTool({ id: 'brush', name: 'Brush', key: 'B', icon: 'brush', defaults: { size: 24, hardness: 80, opacity: 100, smoothing: 30 } });
export const pencil = paintTool({ id: 'pencil', name: 'Pencil', key: 'B', icon: 'pencil', aliased: true, defaults: { size: 1, opacity: 100 } });
export const eraser = paintTool({ id: 'eraser', name: 'Eraser', key: 'E', icon: 'eraser', mode: 'destination-out', defaults: { size: 40, hardness: 60, opacity: 100, smoothing: 20 } });

// ---------- clone stamp (Pro) ----------

export const clone = {
  id: 'clone', name: 'Clone stamp', key: 'S', icon: 'stamp', pro: true, cursor: 'crosshair',
  defaults: { size: 40, hardness: 50, opacity: 100, aligned: true, sampleAll: false },
  options: (ed) => [
    sizeOpts(ed, 'clone'),
    optRange(ed, 'clone', 'hardness', 'Hardness', { min: 0, max: 100, unit: '%' }),
    optRange(ed, 'clone', 'opacity', 'Opacity', { min: 1, max: 100, unit: '%' }),
    optCheck(ed, 'clone', 'aligned', 'Aligned'),
    optCheck(ed, 'clone', 'sampleAll', 'Sample all layers'),
    hint('Alt/Option-click sets the source'),
  ],
  down(ed, e, p) {
    if (e.altKey) {
      ed.cloneSource = { x: p.x, y: p.y };
      this.offset = null;
      toast('Clone source set');
      ed.render();
      return;
    }
    if (!requirePro('Clone stamp') || !ed.editableLayer()) return;
    if (!ed.cloneSource) { toast('Alt/Option-click to set a clone source first', 'warn'); return; }
    const o = ed.opts.clone;
    if (!o.aligned || !this.offset) this.offset = { x: ed.cloneSource.x - p.x, y: ed.cloneSource.y - p.y };
    this.s = new StrokeSession(ed, { opacity: o.opacity / 100 });
    const source = o.sampleAll ? copyCanvas(ed.doc.composite()) : this.s.backup.canvas;
    const tip = makeTip(o.size, o.hardness / 100, '#000000');
    const dabC = makeCanvas(tip.width, tip.height), dc = dabC.getContext('2d');
    const { x: ox, y: oy } = this.offset;
    this.step = new Stepper(Math.max(1, o.size * 0.1), (x, y) => {
      const tx = x - tip.width / 2, ty = y - tip.height / 2;
      dc.globalCompositeOperation = 'copy';
      dc.drawImage(tip, 0, 0);
      dc.globalCompositeOperation = 'source-in';
      dc.drawImage(source, -(tx + ox), -(ty + oy));
      this.s.ctx.drawImage(dabC, tx, ty);
      this.s.mark(tx, ty, tip.width, tip.height);
    });
    this.step.start(p);
    this.s.flush();
  },
  move(ed, e, p) { if (this.s) { this.step.to(p); this.s.flush(); ed.render(); } },
  up(ed) { if (this.s) { this.s = null; ed.doc.commit('Clone stamp'); } },
  overlay(ctx, view, ed) {
    const o = ed.opts.clone, p = view.pointer;
    drawBrushCursor(ctx, view, o.size);
    let src = ed.cloneSource;
    if (p && this.offset && (this.s || o.aligned)) src = { x: p.x + this.offset.x, y: p.y + this.offset.y };
    if (!src) return;
    const s = view.toScreen(src.x, src.y);
    ctx.save();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    ctx.shadowColor = '#000'; ctx.shadowBlur = 2;
    ctx.beginPath(); ctx.moveTo(s.x - 8, s.y); ctx.lineTo(s.x + 8, s.y); ctx.moveTo(s.x, s.y - 8); ctx.lineTo(s.x, s.y + 8); ctx.stroke();
    ctx.restore();
  },
};

// ---------- per-pixel retouch brushes ----------

// Shared dab loop: reads the dab square from the layer, lets `process` modify it using
// per-pixel weights (falloff × strength × selection), and writes it back.
function retouchTool({ id, name, key, icon, defaults, options, label, process, begin }) {
  return {
    id, name, key, icon, cursor: 'crosshair', defaults,
    options: (ed) => [sizeOpts(ed, id), optRange(ed, id, 'hardness', 'Hardness', { min: 0, max: 100, unit: '%' }), ...options(ed)],
    down(ed, e, p) {
      const layer = ed.editableLayer();
      if (!layer) return;
      const o = ed.opts[id], d = ed.doc, size = Math.max(2, o.size), r = size / 2;
      const hard = o.hardness / 100;
      this.state = begin ? begin(o, size) : {};
      this.active = true;
      this.step = new Stepper(Math.max(1, size * 0.2), (x, y) => {
        const rect = clampRect(x - r, y - r, size, size, d.width, d.height);
        if (!rect) return;
        const img = layer.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
        const mask = d.selection.active ? d.selection.maskRegion(rect.x, rect.y, rect.w, rect.h) : null;
        const wts = new Float32Array(rect.w * rect.h);
        let any = false;
        for (let j = 0; j < rect.h; j++) for (let i = 0; i < rect.w; i++) {
          const dx = rect.x + i + 0.5 - x, dy = rect.y + j + 0.5 - y;
          let wgt = falloff(Math.sqrt(dx * dx + dy * dy) / r, hard);
          if (mask) wgt *= mask[j * rect.w + i] / 255;
          wts[j * rect.w + i] = wgt;
          if (wgt) any = true;
        }
        if (!any) return;
        process(img.data, rect.w, rect.h, wts, o, this.state, { x: rect.x - (x - r), y: rect.y - (y - r), size });
        layer.ctx.putImageData(img, rect.x, rect.y);
      });
      this.step.start(p);
      d.changed('pixels');
    },
    move(ed, e, p) { if (this.active) { this.step.to(p); ed.doc.changed('pixels'); } },
    up(ed) {
      if (!this.active) return;
      this.active = false;
      ed.doc.commit(typeof label === 'function' ? label(ed.opts[id]) : name);
    },
    overlay(ctx, view, ed) { drawBrushCursor(ctx, view, ed.opts[id].size); },
  };
}

function box3(data, w, h) {
  const out = new Float32Array(data.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i)), yy = Math.min(h - 1, Math.max(0, y + j));
        s += data[(yy * w + xx) * 4 + c];
      }
      out[(y * w + x) * 4 + c] = s / 9;
    }
  }
  return out;
}

export const blurSharpen = retouchTool({
  id: 'blur', name: 'Blur / Sharpen', key: 'R', icon: 'drop',
  defaults: { size: 40, hardness: 30, strength: 50, mode: 'blur' },
  label: (o) => (o.mode === 'blur' ? 'Blur brush' : 'Sharpen brush'),
  options: (ed) => [optSeg(ed, 'blur', 'mode', [['blur', 'Blur'], ['sharpen', 'Sharpen']]), optRange(ed, 'blur', 'strength', 'Strength', { min: 1, max: 100, unit: '%' })],
  process(data, w, h, wts, o) {
    const b = box3(data, w, h), k = o.strength / 100;
    for (let p = 0, i = 0; p < wts.length; p++, i += 4) {
      const wt = wts[p] * k;
      if (!wt) continue;
      if (o.mode === 'blur') for (let c = 0; c < 4; c++) data[i + c] += (b[i + c] - data[i + c]) * wt;
      else for (let c = 0; c < 3; c++) data[i + c] += (data[i + c] - b[i + c]) * wt * 1.5;
    }
  },
});

export const dodgeBurn = retouchTool({
  id: 'dodge', name: 'Dodge / Burn', key: 'O', icon: 'sun',
  defaults: { size: 60, hardness: 20, exposure: 30, mode: 'dodge', range: 'midtones' },
  label: (o) => (o.mode === 'dodge' ? 'Dodge' : 'Burn'),
  options: (ed) => [
    optSeg(ed, 'dodge', 'mode', [['dodge', 'Dodge'], ['burn', 'Burn']]),
    optSeg(ed, 'dodge', 'range', [['shadows', 'Shadows'], ['midtones', 'Midtones'], ['highlights', 'Highlights']], 'Range'),
    optRange(ed, 'dodge', 'exposure', 'Exposure', { min: 1, max: 100, unit: '%' }),
  ],
  process(data, w, h, wts, o) {
    const k = (o.exposure / 100) * 0.25;
    for (let p = 0, i = 0; p < wts.length; p++, i += 4) {
      if (!wts[p]) continue;
      const L = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      const tone = o.range === 'shadows' ? (1 - L) * (1 - L) : o.range === 'highlights' ? L * L : 1 - (2 * L - 1) * (2 * L - 1);
      const f = wts[p] * k * (0.25 + 0.75 * tone);
      for (let c = 0; c < 3; c++) data[i + c] = o.mode === 'dodge' ? data[i + c] + (255 - data[i + c]) * f : data[i + c] * (1 - f);
    }
  },
});

export const smudge = retouchTool({
  id: 'smudge', name: 'Smudge', key: 'J', icon: 'finger',
  defaults: { size: 30, hardness: 40, strength: 60 },
  options: (ed) => [optRange(ed, 'smudge', 'strength', 'Strength', { min: 1, max: 100, unit: '%' })],
  begin: (o, size) => ({ carry: null, n: Math.ceil(size) }),
  process(data, w, h, wts, o, st, off) {
    const n = st.n;
    if (!st.carry) { st.carry = new Float32Array(n * n * 4); st.valid = new Uint8Array(n * n); }
    const k = o.strength / 100;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const lx = Math.min(n - 1, Math.max(0, Math.round(i + off.x))), ly = Math.min(n - 1, Math.max(0, Math.round(j + off.y)));
      const q = ly * n + lx, ci = q * 4, di = (j * w + i) * 4;
      if (!st.valid[q]) { for (let c = 0; c < 4; c++) st.carry[ci + c] = data[di + c]; st.valid[q] = 1; continue; }
      const wt = wts[j * w + i] * k;
      for (let c = 0; c < 4; c++) {
        const v = data[di + c] + (st.carry[ci + c] - data[di + c]) * wt;
        data[di + c] = v;
        st.carry[ci + c] = v;
      }
    }
  },
});

export const paintTools = [brush, pencil, eraser, clone, blurSharpen, dodgeBurn, smudge];
