// Selection tools (marquees, lasso, magic wand), Move and Crop.
import { toast } from '../ui.js';
import { iconEl } from '../icons.js';
import { floodMask } from './pixels.js';
import { rectFrom } from './canvas.js';
import { optRange, optCheck, optSelect, selModeSeg, modeFromEvent, hint, optButton } from './opts.js';

function selectionButtons(ed) {
  return [
    optButton('Select all', () => ed.cmd('selectAll'), { title: 'Ctrl/Cmd+A' }),
    optButton('Deselect', () => ed.cmd('deselect'), { title: 'Ctrl/Cmd+D' }),
    optButton('Invert', () => ed.cmd('invertSelection'), { title: 'Shift+Ctrl/Cmd+I' }),
  ];
}

// Constrain a drag from a to b: square (shift) and/or centered on a (alt).
function dragRect(a, b, square, centered) {
  let dx = b.x - a.x, dy = b.y - a.y;
  if (square) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m; }
  return centered ? { x: a.x - Math.abs(dx), y: a.y - Math.abs(dy), w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 } : rectFrom(a, { x: a.x + dx, y: a.y + dy });
}

function strokeOverlayPath(ctx, view, build) {
  ctx.save();
  ctx.translate(view.panX, view.panY);
  ctx.scale(view.zoom, view.zoom);
  ctx.beginPath();
  build(ctx);
  ctx.restore();
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#000';
  ctx.stroke();
  ctx.lineDashOffset = 4;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.restore();
}

function marquee(id, name, key, icon, ellipse) {
  return {
    id, name, key, icon, cursor: 'crosshair', defaults: { mode: 'replace' },
    options: (ed) => [selModeSeg(ed, id), ...selectionButtons(ed), hint('Shift: square · Alt: from center · Shift/Alt on click: add/subtract')],
    down(ed, e, p) { this.a = p; this.r = null; this.mode = modeFromEvent(e, ed.opts[id].mode); },
    abort() { this.a = null; this.r = null; },
    move(ed, e, p) { if (this.a) { this.r = dragRect(this.a, p, e.shiftKey, e.altKey); ed.render(); } },
    up(ed) {
      const sel = ed.doc.selection, r = this.r;
      this.a = null; this.r = null;
      if (!r || (r.w < 1 && r.h < 1)) { if (this.mode === 'replace') sel.clear(); ed.render(); return; }
      if (ellipse) sel.ellipse(this.mode, r.x, r.y, r.w, r.h); else sel.rect(this.mode, Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
      ed.render();
    },
    overlay(ctx, view) {
      const r = this.r;
      if (!r) return;
      strokeOverlayPath(ctx, view, (c) => (ellipse ? c.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2) : c.rect(r.x, r.y, r.w, r.h)));
    },
  };
}

export const marqueeRect = marquee('marquee', 'Rectangular marquee', 'M', 'marquee', false);
export const marqueeEllipse = marquee('ellipse', 'Elliptical marquee', 'M', 'ellipse', true);

export const lasso = {
  id: 'lasso', name: 'Lasso', key: 'L', icon: 'lasso', cursor: 'crosshair', defaults: { mode: 'replace' },
  options: (ed) => [selModeSeg(ed, 'lasso'), ...selectionButtons(ed), hint('Drag a freehand outline; release to close it')],
  down(ed, e, p) { this.pts = [[p.x, p.y]]; this.mode = modeFromEvent(e, ed.opts.lasso.mode); },
  abort() { this.pts = null; },
  move(ed, e, p) {
    if (!this.pts) return;
    const [lx, ly] = this.pts[this.pts.length - 1];
    if (Math.hypot(p.x - lx, p.y - ly) * ed.view.zoom >= 2) { this.pts.push([p.x, p.y]); ed.render(); }
  },
  up(ed) {
    const pts = this.pts;
    this.pts = null;
    if (!pts) return;
    if (pts.length < 3) { if (this.mode === 'replace') ed.doc.selection.clear(); }
    else ed.doc.selection.polygon(this.mode, pts);
    ed.render();
  },
  overlay(ctx, view) {
    if (!this.pts) return;
    strokeOverlayPath(ctx, view, (c) => this.pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))));
  },
};

export const wand = {
  id: 'wand', name: 'Magic wand', key: 'W', icon: 'wand', cursor: 'crosshair',
  defaults: { mode: 'replace', tolerance: 32, contiguous: true, sampleAll: false },
  options: (ed) => [
    selModeSeg(ed, 'wand'),
    optRange(ed, 'wand', 'tolerance', 'Tolerance', { min: 0, max: 255 }),
    optCheck(ed, 'wand', 'contiguous', 'Contiguous'),
    optCheck(ed, 'wand', 'sampleAll', 'Sample all layers'),
    ...selectionButtons(ed),
  ],
  down(ed, e, p) {
    const d = ed.doc, o = ed.opts.wand;
    if (p.x < 0 || p.y < 0 || p.x >= d.width || p.y >= d.height) return;
    const src = o.sampleAll ? d.composite() : d.layer.canvas;
    const data = src.getContext('2d').getImageData(0, 0, d.width, d.height).data;
    const mask = floodMask(data, d.width, d.height, p.x, p.y, o.tolerance, o.contiguous);
    d.selection.fromMask(modeFromEvent(e, o.mode), mask);
    ed.render();
  },
};

// ---------- Move ----------

export const move = {
  id: 'move', name: 'Move', key: 'V', icon: 'move', cursor: 'move', defaults: {},
  options: () => [hint('Drag to move the active layer, or the selected pixels when there is a selection. Arrow keys nudge (Shift = 10px).')],
  begin(ed) {
    const layer = ed.editableLayer();
    if (!layer) return false;
    const d = ed.doc, sel = d.selection;
    this.layer = layer;
    this.backup = ed.scratch('backup');
    this.backup.ctx.drawImage(layer.canvas, 0, 0);
    this.float = null;
    if (sel.active) {
      this.selBackup = sel.snapshot();
      this.float = ed.scratch('float');
      this.float.ctx.drawImage(layer.canvas, 0, 0);
      this.float.ctx.globalCompositeOperation = 'destination-in';
      this.float.ctx.drawImage(this.selBackup, 0, 0);
      this.float.ctx.globalCompositeOperation = 'source-over';
    }
    this.dx = this.dy = 0;
    return true;
  },
  shift(ed, dx, dy) {
    const d = ed.doc, L = this.layer.ctx;
    this.dx = dx; this.dy = dy;
    L.clearRect(0, 0, d.width, d.height);
    if (this.float) {
      L.drawImage(this.backup.canvas, 0, 0);
      L.globalCompositeOperation = 'destination-out';
      L.drawImage(this.selBackup, 0, 0);
      L.globalCompositeOperation = 'source-over';
      L.drawImage(this.float.canvas, dx, dy);
      ed.view.selOffset = { x: dx, y: dy };
    } else {
      L.drawImage(this.backup.canvas, dx, dy);
    }
    d.changed('pixels');
  },
  end(ed) {
    if (this.float) { ed.view.selOffset = null; ed.doc.selection.setFrom(this.selBackup, this.dx, this.dy); }
    this.layer = null;
    if (this.dx || this.dy) ed.doc.commit('Move');
    else ed.render();
  },
  down(ed, e, p) { if (this.begin(ed)) this.start = p; },
  move(ed, e, p) {
    if (!this.layer || !this.start) return;
    let dx = Math.round(p.x - this.start.x), dy = Math.round(p.y - this.start.y);
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    this.shift(ed, dx, dy);
  },
  up(ed) { if (this.layer) { this.start = null; this.end(ed); } },
  abort(ed) {
    if (!this.layer) return;
    const d = ed.doc, L = this.layer.ctx;
    L.clearRect(0, 0, d.width, d.height);
    L.drawImage(this.backup.canvas, 0, 0);
    ed.view.selOffset = null;
    this.layer = null;
    this.start = null;
    d.changed('pixels');
  },
  keydown(ed, e) {
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!dir || this.layer) return false;
    const step = e.shiftKey ? 10 : 1;
    if (this.begin(ed)) { this.shift(ed, dir[0] * step, dir[1] * step); this.end(ed); }
    return true;
  },
};

// ---------- Crop ----------

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const RATIOS = { free: 0, original: -1, '1:1': 1, '4:5': 4 / 5, '4:3': 4 / 3, '3:2': 3 / 2, '16:9': 16 / 9, '9:16': 9 / 16 };

export const crop = {
  id: 'crop', name: 'Crop', key: 'C', icon: 'crop', cursor: 'crosshair', defaults: { ratio: 'free' },
  options: (ed) => [
    optSelect(ed, 'crop', 'ratio', 'Ratio', Object.keys(RATIOS).map((k) => [k, k === 'free' ? 'Free' : k === 'original' ? 'Original' : k])),
    optButton([iconEl('check', 16), 'Apply'], () => crop.apply(ed), { class: 'btn primary', title: 'Enter' }),
    optButton('Cancel', () => crop.reset(ed), { title: 'Esc' }),
    hint('Drag handles or draw a new box. Enter applies.'),
  ],
  activate(ed) { this.reset(ed); },
  deactivate() { this.rect = null; },
  reset(ed) { const d = ed.doc; this.rect = d ? { x: 0, y: 0, w: d.width, h: d.height } : null; ed.render(); },
  ratio(ed) { const r = RATIOS[ed.opts.crop.ratio]; return r === -1 ? ed.doc.width / ed.doc.height : r; },
  handlePos(r) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    return { nw: [r.x, r.y], n: [cx, r.y], ne: [r.x + r.w, r.y], e: [r.x + r.w, cy], se: [r.x + r.w, r.y + r.h], s: [cx, r.y + r.h], sw: [r.x, r.y + r.h], w: [r.x, cy] };
  },
  down(ed, e, p) {
    if (!this.rect) this.reset(ed);
    const r = this.rect, z = ed.view.zoom, hp = this.handlePos(r), reach = e.pointerType === 'touch' ? 24 : 9;
    this.prev = { ...r };
    const hit = HANDLES.find((h) => Math.hypot((hp[h][0] - p.x) * z, (hp[h][1] - p.y) * z) < reach);
    if (hit) this.drag = { type: 'resize', h: hit, r0: { ...r } };
    else if (p.x > r.x && p.y > r.y && p.x < r.x + r.w && p.y < r.y + r.h) this.drag = { type: 'move', p0: p, r0: { ...r } };
    else this.drag = { type: 'new', a: p };
  },
  move(ed, e, p) {
    const dr = this.drag;
    if (!dr) return;
    const ratio = this.ratio(ed);
    if (dr.type === 'move') {
      this.rect = { ...dr.r0, x: dr.r0.x + p.x - dr.p0.x, y: dr.r0.y + p.y - dr.p0.y };
    } else if (dr.type === 'new') {
      let r = rectFrom(dr.a, p);
      if (ratio) { r.h = r.w / ratio; if (p.y < dr.a.y) r.y = dr.a.y - r.h; }
      this.rect = r;
    } else {
      let { x, y, w, h } = dr.r0;
      let x2 = x + w, y2 = y + h;
      if (dr.h.includes('w')) x = p.x;
      if (dr.h.includes('e')) x2 = p.x;
      if (dr.h.includes('n')) y = p.y;
      if (dr.h.includes('s')) y2 = p.y;
      let r = rectFrom({ x, y }, { x: x2, y: y2 });
      if (ratio) {
        if (dr.h === 'n' || dr.h === 's') { const nw = r.h * ratio; r.x = r.x + (r.w - nw) / 2; r.w = nw; }
        else { const nh = r.w / ratio; if (dr.h.includes('n')) r.y = r.y + r.h - nh; else if (!dr.h.includes('s')) r.y = r.y + (r.h - nh) / 2; r.h = nh; }
      }
      this.rect = r;
    }
    ed.render();
  },
  up() { this.drag = null; },
  abort() { if (this.drag) { this.rect = this.prev; this.drag = null; } },
  hover(ed, e, p) {
    if (!this.rect) return;
    const z = ed.view.zoom, hp = this.handlePos(this.rect);
    const hit = HANDLES.find((h) => Math.hypot((hp[h][0] - p.x) * z, (hp[h][1] - p.y) * z) < 9);
    const r = this.rect;
    ed.view.canvas.style.cursor = hit ? `${hit}-resize` : p.x > r.x && p.y > r.y && p.x < r.x + r.w && p.y < r.y + r.h ? 'move' : 'crosshair';
  },
  keydown(ed, e) {
    if (e.key === 'Enter') { this.apply(ed); return true; }
    if (e.key === 'Escape') { this.reset(ed); return true; }
    return false;
  },
  apply(ed) {
    const r = this.rect, d = ed.doc;
    if (!r) return;
    const x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.w), h = Math.round(r.h);
    if (w < 1 || h < 1) { toast('Crop area is empty', 'warn'); return; }
    if (x === 0 && y === 0 && w === d.width && h === d.height) return;
    d.transform(w, h, (ctx, old) => ctx.drawImage(old, -x, -y));
    d.history.push('Crop');
    ed.view.fit();
    this.reset(ed);
  },
  overlay(ctx, view, ed) {
    const r = this.rect;
    if (!r || !ed.doc) return;
    const a = view.toScreen(r.x, r.y), b = view.toScreen(r.x + r.w, r.y + r.h);
    const W = view.cw, H = view.ch;
    ctx.save();
    ctx.fillStyle = '#000a';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x - 1, b.y - a.y - 1);
    ctx.strokeStyle = '#fff6';
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      const gx = a.x + ((b.x - a.x) * i) / 3, gy = a.y + ((b.y - a.y) * i) / 3;
      ctx.moveTo(gx, a.y); ctx.lineTo(gx, b.y); ctx.moveTo(a.x, gy); ctx.lineTo(b.x, gy);
    }
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    const hp = this.handlePos(r);
    for (const h of HANDLES) {
      const s = view.toScreen(hp[h][0], hp[h][1]);
      ctx.fillRect(s.x - 4, s.y - 4, 8, 8);
      ctx.strokeRect(s.x - 4, s.y - 4, 8, 8);
    }
    ctx.font = '11px system-ui, sans-serif';
    const label = `${Math.round(r.w)} × ${Math.round(r.h)}`;
    ctx.fillStyle = '#000c';
    ctx.fillRect(a.x, b.y + 6, ctx.measureText(label).width + 10, 18);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, a.x + 5, b.y + 19);
    ctx.restore();
  },
};

export const selectTools = [move, marqueeRect, marqueeEllipse, lasso, wand, crop];
