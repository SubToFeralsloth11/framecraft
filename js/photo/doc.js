// Document model: ordered layers (bottom → top), selection and snapshot history.
import { CONFIG } from '../config.js';
import { requirePro } from '../license.js';
import { Selection } from './selection.js';
import { makeCanvas, copyCanvas } from './canvas.js';

export const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];
export const gco = (mode) => (mode === 'normal' ? 'source-over' : mode);

let nextId = 1;
let nextRev = 1;

export class Layer {
  constructor(w, h, name = 'Layer') {
    this.id = nextId++;
    this.name = name;
    this.canvas = makeCanvas(w, h);
    this.ctx = this.canvas.getContext('2d');
    this.visible = true;
    this.opacity = 1;
    this.blend = 'normal';
    this.locked = false;
    this.rev = nextRev++;
    this.snap = null; // { rev, canvas } — last history copy, shared while unchanged
  }
  touch() { this.rev = nextRev++; }
  meta() { return { id: this.id, name: this.name, visible: this.visible, opacity: this.opacity, blend: this.blend, locked: this.locked }; }
}

export class Doc {
  // notify(kind): 'pixels' | 'layers' | 'history' | 'size' | 'selection'
  constructor(w, h, notify = () => {}) {
    this.width = w;
    this.height = h;
    this.notify = notify;
    this.layers = [];
    this.active = 0;
    this.selection = new Selection(w, h);
    this.selection.onChange = () => notify('selection');
    this.comp = makeCanvas(w, h);
    this.compDirty = true;
    this.history = new History(this);
    this.dirty = false;
  }

  get layer() { return this.layers[this.active]; }

  // Free plan layer cap. Opens the upgrade dialog when exceeded.
  canAddLayer() {
    return this.layers.length < CONFIG.free.photoMaxLayers || requirePro(`More than ${CONFIG.free.photoMaxLayers} layers`);
  }

  addLayer(name, index = this.active + 1, { force = false } = {}) {
    if (!force && !this.canAddLayer()) return null;
    const l = new Layer(this.width, this.height, name || `Layer ${this.layers.length + 1}`);
    index = Math.max(0, Math.min(this.layers.length, index));
    this.layers.splice(index, 0, l);
    this.active = index;
    this.changed('layers');
    return l;
  }

  duplicateLayer() {
    const src = this.layer;
    if (!src || !this.canAddLayer()) return null;
    const l = new Layer(this.width, this.height, `${src.name} copy`);
    l.ctx.drawImage(src.canvas, 0, 0);
    Object.assign(l, { visible: src.visible, opacity: src.opacity, blend: src.blend });
    this.layers.splice(this.active + 1, 0, l);
    this.active++;
    this.changed('layers');
    return l;
  }

  deleteLayer() {
    if (this.layers.length <= 1) return false;
    this.layers.splice(this.active, 1);
    this.active = Math.min(this.active, this.layers.length - 1);
    this.changed('layers');
    return true;
  }

  mergeDown() {
    const i = this.active;
    if (i <= 0) return false;
    const top = this.layers[i], below = this.layers[i - 1];
    if (top.visible) {
      const c = below.ctx;
      c.save();
      c.globalAlpha = top.opacity;
      c.globalCompositeOperation = gco(top.blend);
      c.drawImage(top.canvas, 0, 0);
      c.restore();
      below.touch();
    }
    this.layers.splice(i, 1);
    this.active = i - 1;
    this.changed('layers');
    return true;
  }

  moveLayer(from, to) {
    to = Math.max(0, Math.min(this.layers.length - 1, to));
    if (from === to) return false;
    const [l] = this.layers.splice(from, 1);
    this.layers.splice(to, 0, l);
    this.active = to;
    this.changed('layers');
    return true;
  }

  changed(kind = 'pixels') {
    this.compDirty = true;
    this.dirty = true;
    this.notify(kind);
  }

  // Draw all visible layers (with blend modes) into ctx.
  drawLayers(ctx) {
    for (const l of this.layers) {
      if (!l.visible || l.opacity <= 0) continue;
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = gco(l.blend);
      ctx.drawImage(l.canvas, 0, 0);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  composite() {
    if (this.compDirty) {
      const c = this.comp.getContext('2d');
      c.clearRect(0, 0, this.width, this.height);
      this.drawLayers(c);
      this.compDirty = false;
    }
    return this.comp;
  }

  flatten() { return copyCanvas(this.composite()); }

  // Rebuild every layer at a new size. draw(ctx, oldCanvas) paints the old content into the new canvas.
  transform(w, h, draw) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    for (const l of this.layers) {
      const c = makeCanvas(w, h), x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      draw(x, l.canvas);
      l.canvas = c; l.ctx = x;
      l.touch();
    }
    this.setSize(w, h);
  }

  setSize(w, h) {
    if (w !== this.width || h !== this.height) {
      this.width = w; this.height = h;
      this.comp = makeCanvas(w, h);
      this.selection.reset(w, h);
      this.notify('size');
    }
    this.changed('layers');
  }

  // Mark the active layer's pixels as edited and record a history step.
  commit(label, layer = this.layer) {
    layer?.touch();
    this.changed('pixels');
    this.history.push(label);
  }
}

// Snapshot history. Each entry stores per-layer canvases; unchanged layers share the
// same snapshot canvas across entries, so memory grows only with what actually changed.
export class History {
  constructor(doc, max = 30) {
    this.doc = doc;
    this.max = max;
    this.entries = [];
    this.index = -1;
  }

  snapOf(l) {
    if (!l.snap || l.snap.rev !== l.rev) l.snap = { rev: l.rev, canvas: copyCanvas(l.canvas) };
    return l.snap.canvas;
  }

  push(label) {
    const d = this.doc;
    const state = {
      label, width: d.width, height: d.height, active: d.active,
      layers: d.layers.map((l) => ({ ...l.meta(), rev: l.rev, canvas: this.snapOf(l) })),
    };
    this.entries.length = this.index + 1;
    this.entries.push(state);
    if (this.entries.length > this.max) this.entries.shift();
    this.index = this.entries.length - 1;
    d.notify('history');
  }

  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.entries.length - 1; }
  undo() { if (this.canUndo) this.go(this.index - 1); }
  redo() { if (this.canRedo) this.go(this.index + 1); }

  go(i) {
    const s = this.entries[i];
    if (!s) return;
    const d = this.doc;
    this.index = i;
    const old = new Map(d.layers.map((l) => [l.id, l]));
    const sizeChanged = s.width !== d.width || s.height !== d.height;
    d.layers = s.layers.map((m) => {
      let l = old.get(m.id);
      if (!l || l.rev !== m.rev || sizeChanged) {
        l = l || Object.create(Layer.prototype);
        l.canvas = copyCanvas(m.canvas);
        l.ctx = l.canvas.getContext('2d');
        l.rev = m.rev;
        l.snap = { rev: m.rev, canvas: m.canvas };
      }
      Object.assign(l, { id: m.id, name: m.name, visible: m.visible, opacity: m.opacity, blend: m.blend, locked: m.locked });
      return l;
    });
    d.active = Math.min(s.active, d.layers.length - 1);
    if (sizeChanged) d.setSize(s.width, s.height);
    d.changed('layers');
    d.notify('history');
  }
}
