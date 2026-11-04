// Pixel selection stored as an alpha mask canvas (white = selected, alpha = strength).
import { maskBounds, maskOutline } from './pixels.js';
import { makeCanvas } from './canvas.js';

export class Selection {
  constructor(w, h) { this.reset(w, h); }

  reset(w, h) {
    this.w = w; this.h = h;
    this.canvas = makeCanvas(w, h);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.active = false;
    this.rev = 0;
    this._cache = null;
    this.onChange?.();
  }

  changed() {
    this.rev++;
    this._cache = null;
    const b = this.bounds();
    this.active = !!b;
    this.onChange?.();
  }

  clear() { this.ctx.clearRect(0, 0, this.w, this.h); this.changed(); }

  all() {
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.fillStyle = '#fff';
    this.ctx.fillRect(0, 0, this.w, this.h);
    this.changed();
  }

  invert() {
    if (!this.active) { this.all(); return; }
    const tmp = makeCanvas(this.w, this.h);
    tmp.getContext('2d').drawImage(this.canvas, 0, 0);
    const c = this.ctx;
    c.clearRect(0, 0, this.w, this.h);
    c.fillStyle = '#fff';
    c.fillRect(0, 0, this.w, this.h);
    c.globalCompositeOperation = 'destination-out';
    c.drawImage(tmp, 0, 0);
    c.globalCompositeOperation = 'source-over';
    this.changed();
  }

  // Combine a new shape (drawn by draw(ctx) in white) using mode replace|add|subtract|intersect.
  apply(mode, draw) {
    const c = this.ctx;
    if (!this.active && (mode === 'add' || mode === 'intersect')) mode = mode === 'add' ? 'replace' : 'empty';
    if (mode === 'empty') { this.clear(); return; }
    c.save();
    c.fillStyle = '#fff';
    c.strokeStyle = '#fff';
    if (mode === 'replace') { c.clearRect(0, 0, this.w, this.h); draw(c); }
    else if (mode === 'add') draw(c);
    else if (mode === 'subtract') { c.globalCompositeOperation = 'destination-out'; draw(c); }
    else if (mode === 'intersect') {
      const tmp = makeCanvas(this.w, this.h), t = tmp.getContext('2d');
      t.fillStyle = '#fff';
      draw(t);
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(tmp, 0, 0);
    }
    c.restore();
    this.changed();
  }

  rect(mode, x, y, w, h) { this.apply(mode, (c) => c.fillRect(x, y, w, h)); }

  ellipse(mode, x, y, w, h) {
    this.apply(mode, (c) => { c.beginPath(); c.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2); c.fill(); });
  }

  polygon(mode, pts) {
    if (pts.length < 3) return;
    this.apply(mode, (c) => { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.fill(); });
  }

  // mask: Uint8Array (w*h), 0..255.
  fromMask(mode, mask) {
    const img = new ImageData(this.w, this.h);
    for (let p = 0, i = 0; p < mask.length; p++, i += 4) { img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = mask[p]; }
    const tmp = makeCanvas(this.w, this.h);
    tmp.getContext('2d').putImageData(img, 0, 0);
    this.apply(mode, (c) => c.drawImage(tmp, 0, 0));
  }

  // Replace mask with `src` canvas drawn at an offset (used while moving selected pixels).
  setFrom(src, dx = 0, dy = 0) {
    this.ctx.clearRect(0, 0, this.w, this.h);
    this.ctx.drawImage(src, dx, dy);
    this.changed();
  }

  snapshot() {
    const c = makeCanvas(this.w, this.h);
    c.getContext('2d').drawImage(this.canvas, 0, 0);
    return c;
  }

  _data() {
    this._cache ??= {};
    this._cache.data ??= this.ctx.getImageData(0, 0, this.w, this.h).data;
    return this._cache.data;
  }

  // Selection strength per pixel for a region: Uint8Array(w*h).
  maskRegion(x, y, w, h) {
    const d = this.ctx.getImageData(x, y, w, h).data;
    const m = new Uint8Array(w * h);
    for (let p = 0, i = 3; p < m.length; p++, i += 4) m[p] = d[i];
    return m;
  }

  bounds() {
    this._cache ??= {};
    if (this._cache.bounds === undefined) this._cache.bounds = maskBounds(this._data(), this.w, this.h, 4, 3);
    return this._cache.bounds;
  }

  // Path2D outline (document pixel coordinates) for marching ants.
  outline() {
    this._cache ??= {};
    if (!this._cache.outline) {
      const b = this.bounds();
      const path = new Path2D();
      if (b) {
        // Scan only the bounding box (+1px border) to keep this fast on big documents.
        const x0 = Math.max(0, b.x - 1), y0 = Math.max(0, b.y - 1);
        const w = Math.min(this.w, b.x + b.w + 1) - x0, h = Math.min(this.h, b.y + b.h + 1) - y0;
        const d = this.ctx.getImageData(x0, y0, w, h).data;
        const segs = maskOutline(d, w, h, 4, 3);
        for (let i = 0; i < segs.length; i += 4) { path.moveTo(segs[i] + x0, segs[i + 1] + y0); path.lineTo(segs[i + 2] + x0, segs[i + 3] + y0); }
      }
      this._cache.outline = path;
    }
    return this._cache.outline;
  }

  contains(x, y) {
    if (!this.active) return true;
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    return this._data()[(y * this.w + x) * 4 + 3] >= 128;
  }
}
