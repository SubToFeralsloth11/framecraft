// Adjustments & filters: definitions, Web Worker runner, live-preview sessions and the panel UI.
import { el, toast, slider } from '../ui.js';
import { requirePro } from '../license.js';
import { runFilter, histogram, PRESETS, rgbToHex } from './pixels.js';
import { clampRect } from './canvas.js';
import { curveEditor, defaultCurve } from './curves.js';

// ---------- definitions ----------
// params: [key, label, min, max, default, step?] for sliders, or objects for other control types.
const R = (key, label, min, max, value, step = 1) => ({ key, label, type: 'range', min, max, value, step });

export const ADJUSTMENTS = [
  { op: 'brightnessContrast', name: 'Brightness / Contrast', params: [R('brightness', 'Brightness', -100, 100, 0), R('contrast', 'Contrast', -100, 100, 0)] },
  { op: 'exposure', name: 'Exposure', params: [R('exposure', 'Exposure', -3, 3, 0, 0.05), R('gamma', 'Gamma', 0.2, 3, 1, 0.01)] },
  { op: 'hueSaturation', name: 'Hue / Saturation', params: [R('hue', 'Hue', -180, 180, 0), R('saturation', 'Saturation', -100, 100, 0), R('lightness', 'Lightness', -100, 100, 0)] },
  { op: 'vibrance', name: 'Vibrance', params: [R('vibrance', 'Vibrance', -100, 100, 0), R('saturation', 'Saturation', -100, 100, 0)] },
  { op: 'colorBalance', name: 'Color balance', params: [
    { key: 'tone', label: 'Tones', type: 'select', value: 'midtones', options: [['shadows', 'Shadows'], ['midtones', 'Midtones'], ['highlights', 'Highlights']] },
    R('cyanRed', 'Cyan ↔ Red', -100, 100, 0), R('magentaGreen', 'Magenta ↔ Green', -100, 100, 0), R('yellowBlue', 'Yellow ↔ Blue', -100, 100, 0),
    { key: 'preserve', label: 'Preserve luminosity', type: 'check', value: true }] },
  { op: 'levels', name: 'Levels', histogram: true, params: [R('inBlack', 'Input black', 0, 254, 0), R('gamma', 'Midtones', 0.1, 5, 1, 0.01), R('inWhite', 'Input white', 1, 255, 255), R('outBlack', 'Output black', 0, 255, 0), R('outWhite', 'Output white', 0, 255, 255)] },
  { op: 'curves', name: 'Curves', pro: true, params: [{ key: 'curve', type: 'curve', value: defaultCurve }] },
  { op: 'temperatureTint', name: 'Temperature / Tint', params: [R('temperature', 'Temperature', -100, 100, 0), R('tint', 'Tint', -100, 100, 0)] },
  { op: 'grayscale', name: 'Grayscale', params: [] },
  { op: 'sepia', name: 'Sepia', params: [R('amount', 'Amount', 0, 100, 100)] },
  { op: 'invert', name: 'Invert', params: [] },
  { op: 'threshold', name: 'Threshold', params: [R('level', 'Level', 0, 255, 128)] },
  { op: 'posterize', name: 'Posterize', params: [R('levels', 'Levels', 2, 32, 4)] },
];

export const FILTER_DEFS = [
  { op: 'gaussianBlur', name: 'Gaussian blur', params: [R('radius', 'Radius', 0.5, 100, 4, 0.5)], pad: (p) => Math.ceil(p.radius * 3) + 2 },
  { op: 'motionBlur', name: 'Motion blur', pro: true, params: [R('angle', 'Angle', -180, 180, 0), R('distance', 'Distance', 1, 200, 20)], pad: (p) => Math.ceil(p.distance / 2) + 2 },
  { op: 'unsharpMask', name: 'Sharpen (unsharp mask)', params: [R('amount', 'Amount %', 0, 500, 100), R('radius', 'Radius', 0.5, 50, 2, 0.5), R('threshold', 'Threshold', 0, 255, 0)], pad: (p) => Math.ceil(p.radius * 3) + 2 },
  { op: 'addNoise', name: 'Add noise', params: [R('amount', 'Amount', 0, 100, 12), { key: 'mono', label: 'Monochromatic', type: 'check', value: true }] },
  { op: 'median', name: 'Denoise (median)', pro: true, params: [R('radius', 'Radius', 1, 5, 1)], pad: (p) => p.radius + 1 },
  { op: 'pixelate', name: 'Pixelate', params: [R('size', 'Cell size', 2, 200, 12)], pad: (p) => p.size },
  { op: 'emboss', name: 'Emboss', params: [R('amount', 'Amount', 0, 100, 100), R('angle', 'Angle', -180, 180, 135)], pad: () => 2 },
  { op: 'edgeDetect', name: 'Edge detect', params: [R('strength', 'Strength', 10, 400, 100), { key: 'invert', label: 'Dark lines on white', type: 'check', value: false }], pad: () => 2 },
  { op: 'vignette', name: 'Vignette', params: [R('amount', 'Amount', -100, 100, 50), R('size', 'Size', 0, 100, 50), R('softness', 'Softness', 0, 100, 50)] },
  { op: 'chromaKey', name: 'Remove color (chroma key)', pro: true, pick: 'color', params: [
    { key: 'color', label: 'Key color', type: 'color', value: '#00ff00' },
    R('tolerance', 'Tolerance', 0, 100, 20), R('softness', 'Softness', 0, 100, 10),
    { key: 'despill', label: 'Remove color spill', type: 'check', value: true }] },
];

const defaults = (def) => Object.fromEntries(def.params.map((p) => [p.key, typeof p.value === 'function' ? p.value() : p.value]));

// ---------- worker runner ----------

class Runner {
  constructor() {
    this.jobs = new Map();
    this.seq = 0;
    try {
      this.worker = new Worker(new URL('./filter-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => {
        const job = this.jobs.get(data.id);
        if (!job) return;
        this.jobs.delete(data.id);
        data.error ? job.reject(new Error(data.error)) : job.resolve(data.data);
      };
      this.worker.onerror = (e) => {
        e.preventDefault?.();
        // Worker unavailable (e.g. opened from file://): fall back to the main thread.
        this.worker = null;
        const pending = [...this.jobs.values()];
        this.jobs.clear();
        for (const j of pending) this.local(j.args).then(j.resolve, j.reject);
      };
    } catch {
      this.worker = null;
    }
  }

  async local([op, data, w, h, params, info, mask]) {
    await new Promise((r) => setTimeout(r, 16));
    return runFilter(op, data, w, h, params, info, mask);
  }

  run(op, data, w, h, params, info, mask = null) {
    const args = [op, data, w, h, params, info, mask];
    if (!this.worker) return this.local(args);
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      // Keep a copy so the job can be re-run locally if the worker dies before answering.
      this.jobs.set(id, { resolve, reject, args: [op, data.slice(), w, h, params, info, mask && mask.slice()] });
      const transfer = [data.buffer];
      if (mask) transfer.push(mask.buffer);
      this.worker.postMessage({ id, op, data, w, h, params, info, mask }, transfer);
    });
  }
}

export const runner = new Runner();

function extract(img, r) {
  const { width: W } = img;
  if (r.x === 0 && r.y === 0 && r.w === img.width && r.h === img.height) return img.data.slice();
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) out.set(img.data.subarray(((r.y + y) * W + r.x) * 4, ((r.y + y) * W + r.x + r.w) * 4), y * r.w * 4);
  return out;
}

const contains = (a, b) => b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;

// ---------- live preview session ----------

export class AdjustSession {
  constructor(ed, def, params) {
    this.ed = ed;
    this.def = def;
    this.doc = ed.doc;
    this.layer = ed.doc.layer;
    this.params = params || defaults(def);
    const { width: W, height: H } = this.doc;
    this.orig = this.layer.ctx.getImageData(0, 0, W, H);
    const b = this.doc.selection.active ? this.doc.selection.bounds() : null;
    this.bounds = b || { x: 0, y: 0, w: W, h: H };
    this.preview = true;
    this.last = null;
    this.running = false;
    this.queued = false;
    this.version = 0;
    this.done = 0;
  }

  region(p) {
    const pad = this.def.pad ? this.def.pad(p) : 0, b = this.bounds;
    return clampRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2, this.doc.width, this.doc.height);
  }

  async compute(p) {
    const r = this.region(p);
    const { width: W, height: H } = this.doc;
    const data = extract(this.orig, r);
    const mask = this.doc.selection.active ? this.doc.selection.maskRegion(r.x, r.y, r.w, r.h) : null;
    const out = await runner.run(this.def.op, data, r.w, r.h, p, { x: r.x, y: r.y, W, H }, mask);
    if (this.closed) return;
    const ctx = this.layer.ctx;
    if (this.last && !contains(r, this.last)) ctx.putImageData(this.orig, 0, 0, this.last.x, this.last.y, this.last.w, this.last.h);
    ctx.putImageData(new ImageData(out, r.w, r.h), r.x, r.y);
    this.last = r;
    this.doc.changed('pixels');
  }

  // Latest-wins scheduling: while one job runs, only the newest params are queued.
  update() {
    this.version++;
    if (!this.preview) return Promise.resolve();
    return this.pump();
  }

  async pump() {
    if (this.running) { this.queued = true; return this.wait; }
    this.running = true;
    this.ed.busy(true, this.def.name);
    this.wait = (async () => {
      try {
        do {
          this.queued = false;
          const v = this.version;
          await this.compute(structuredClone(this.params));
          this.done = v;
        } while (this.queued && !this.closed);
      } catch (err) {
        toast(`${this.def.name} failed: ${err.message}`, 'err', 4000);
      } finally {
        this.running = false;
        this.ed.busy(false);
      }
    })();
    return this.wait;
  }

  setPreview(on) {
    this.preview = on;
    if (on) { this.done = -1; this.pump(); return; }
    if (this.last) { this.layer.ctx.putImageData(this.orig, 0, 0, this.last.x, this.last.y, this.last.w, this.last.h); this.last = null; this.doc.changed('pixels'); }
  }

  async apply() {
    if (this.running) await this.wait;
    if (!this.preview || this.done !== this.version || !this.last) {
      this.preview = true;
      await this.pump();
    }
    this.closed = true;
    this.doc.commit(this.def.name, this.layer);
  }

  cancel() {
    this.closed = true;
    this.layer.ctx.putImageData(this.orig, 0, 0);
    this.doc.changed('pixels');
  }

  pickColor(p) {
    const x = Math.floor(p.x), y = Math.floor(p.y), { width: W, height: H } = this.doc;
    if (x < 0 || y < 0 || x >= W || y >= H) return null;
    const i = (y * W + x) * 4, d = this.orig.data;
    return rgbToHex(d[i], d[i + 1], d[i + 2]);
  }
}

// ---------- panel UI ----------

export function createAdjustPanel(ed) {
  const body = el('div', { class: 'pe-adjust' });

  function canEdit() {
    if (!ed.doc) return false;
    if (ed.session) { toast('Apply or cancel the current adjustment first', 'warn'); return false; }
    return !!ed.editableLayer();
  }

  // Run immediately (no parameters) and commit.
  async function oneShot(def, params) {
    if (!canEdit()) return;
    if (def.pro && !requirePro(def.name)) return;
    const s = new AdjustSession(ed, def, params);
    ed.session = s;
    ed.emit('session');
    try { await s.update(); await s.apply(); }
    finally { ed.session = null; ed.emit('session'); }
  }

  function open(def) {
    if (!canEdit()) return;
    if (def.pro && !requirePro(def.name)) return;
    if (!def.params.length) { oneShot(def); return; }
    const s = new AdjustSession(ed, def);
    ed.session = s;
    ed.emit('session');
    renderEditor(s);
    // Effects that do nothing at their defaults stay unpreviewed until a control moves.
    if (['sepia', 'threshold', 'posterize', 'gaussianBlur', 'addNoise', 'median', 'pixelate', 'emboss', 'edgeDetect', 'vignette', 'chromaKey', 'unsharpMask', 'motionBlur'].includes(def.op)) s.update();
  }

  function close() {
    ed.session = null;
    ed.emit('session');
    renderList();
  }

  ed.applySession = async () => {
    const s = ed.session;
    if (!s) return;
    await s.apply();
    close();
  };
  ed.cancelSession = () => {
    const s = ed.session;
    if (!s) return;
    s.cancel();
    close();
  };

  function control(s, p) {
    const set = (v) => { s.params[p.key] = v; s.update(); };
    if (p.type === 'range') {
      const decimals = p.step < 1 ? (p.step < 0.1 ? 2 : 1) : 0;
      return slider(p.label, { min: p.min, max: p.max, step: p.step, value: s.params[p.key], onInput: set, format: (v) => (+v).toFixed(decimals) });
    }
    if (p.type === 'check') {
      const c = el('input', { type: 'checkbox', checked: !!s.params[p.key], onchange: () => set(c.checked) });
      return el('label', { class: 'field' }, el('span', {}, p.label), el('div', {}, c));
    }
    if (p.type === 'select') {
      const sel = el('select', { onchange: () => set(sel.value) }, p.options.map(([v, t]) => el('option', { value: v, selected: v === s.params[p.key] }, t)));
      return el('label', { class: 'field' }, el('span', {}, p.label), sel);
    }
    if (p.type === 'color') {
      const c = el('input', { type: 'color', value: s.params[p.key], oninput: () => set(c.value) });
      s.colorInput = c;
      return el('label', { class: 'field' }, el('span', {}, p.label), el('div', { class: 'row' }, c, el('small', { class: 'muted' }, 'or click the image')));
    }
    if (p.type === 'curve') {
      const b = s.bounds;
      return curveEditor(s.params[p.key], (v) => set(v), histogram(extract(s.orig, b)));
    }
    return null;
  }

  function histogramView(s) {
    const h = histogram(extract(s.orig, s.bounds)).l;
    const c = el('canvas', { class: 'pe-hist', width: 256, height: 64 });
    const x = c.getContext('2d');
    let max = 0;
    for (let i = 0; i < 256; i++) max = Math.max(max, h[i]);
    x.fillStyle = '#c9ccd6';
    for (let i = 0; i < 256; i++) { const v = max ? Math.sqrt(h[i] / max) * 64 : 0; x.fillRect(i, 64 - v, 1, v); }
    return c;
  }

  function renderEditor(s) {
    const def = s.def;
    if (def.pick) {
      // Default key color: top-left pixel of the layer (usual background).
      s.params[def.pick] = s.pickColor({ x: s.bounds.x, y: s.bounds.y }) || s.params[def.pick];
    }
    const prev = el('input', { type: 'checkbox', checked: true, onchange: () => s.setPreview(prev.checked) });
    body.replaceChildren(...[
      el('div', { class: 'pe-adjust-head' }, el('b', {}, def.name), def.pro ? el('span', { class: 'pro-badge' }, 'PRO') : null),
      def.histogram ? histogramView(s) : null,
      ...def.params.map((p) => control(s, p)),
      el('label', { class: 'pe-opt check pe-preview' }, prev, el('span', {}, 'Preview')),
      el('div', { class: 'row pe-adjust-actions' },
        el('button', { class: 'btn', onclick: () => { s.params = defaults(def); renderEditor(s); s.update(); } }, 'Reset'),
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn', onclick: () => ed.cancelSession() }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: () => ed.applySession() }, 'Apply')),
      el('div', { class: 'muted pe-small' }, ed.doc.selection.active ? 'Applies inside the selection.' : 'Applies to the active layer.'),
    ].filter(Boolean));
  }

  // Canvas click while a pick-color adjustment is open.
  ed.sessionPick = (p) => {
    const s = ed.session;
    if (!s?.def.pick) return false;
    const c = s.pickColor(p);
    if (c) { s.params[s.def.pick] = c; if (s.colorInput) s.colorInput.value = c; s.update(); }
    return true;
  };

  const btn = (def) => el('button', { class: 'pe-fx-btn', title: def.name, onclick: () => open(def) }, def.name, def.pro ? el('span', { class: 'pro-badge' }, 'PRO') : null);

  function renderList() {
    body.replaceChildren(
      el('div', { class: 'pe-sub' }, 'One-click looks'),
      el('div', { class: 'pe-presets' }, Object.keys(PRESETS).map((name) => el('button', { class: 'pe-preset', onclick: () => oneShot({ op: 'preset', name, params: [] }, { name }) }, name))),
      el('div', { class: 'pe-sub' }, 'Adjustments'),
      el('div', { class: 'pe-fx-grid' }, ADJUSTMENTS.map(btn)),
      el('div', { class: 'pe-sub' }, 'Filters'),
      el('div', { class: 'pe-fx-grid' }, FILTER_DEFS.map(btn)),
    );
  }

  renderList();
  return body;
}
