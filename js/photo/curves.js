// Interactive curves editor widget. value = { rgb, r, g, b } each a list of [x, y] points (0..255).
import { el } from '../ui.js';
import { curveLUT } from './pixels.js';

const COLORS = { rgb: '#e7e9ee', r: '#ff6b6b', g: '#5fd38d', b: '#6c9cff' };

export function defaultCurve() {
  const line = () => [[0, 0], [255, 255]];
  return { rgb: line(), r: line(), g: line(), b: line() };
}

export function curveEditor(value, onChange, hist) {
  let channel = 'rgb';
  let drag = -1;
  const S = 256;
  const canvas = el('canvas', { class: 'pe-curve', width: S * 2, height: S * 2 });
  const ctx = canvas.getContext('2d');
  const chSel = el('select', { onchange: () => { channel = chSel.value; draw(); } },
    [['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']].map(([v, t]) => el('option', { value: v }, t)));
  const readout = el('span', { class: 'muted' }, '');

  const pts = () => value[channel];
  const toLocal = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 255, y: 255 - ((e.clientY - r.top) / r.height) * 255 };
  };

  function draw() {
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = '#16181d';
    ctx.fillRect(0, 0, S, S);
    const h = hist && (channel === 'rgb' ? hist.l : hist[channel]);
    if (h) {
      let max = 0;
      for (let i = 0; i < 256; i++) max = Math.max(max, h[i]);
      ctx.fillStyle = '#ffffff1c';
      for (let i = 0; i < 256; i++) { const v = max ? Math.sqrt(h[i] / max) * S : 0; ctx.fillRect(i, S - v, 1, v); }
    }
    ctx.strokeStyle = '#ffffff14';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i++) { const g = (S * i) / 4; ctx.moveTo(g, 0); ctx.lineTo(g, S); ctx.moveTo(0, g); ctx.lineTo(S, g); }
    ctx.moveTo(0, S); ctx.lineTo(S, 0);
    ctx.stroke();
    // other channels faintly
    for (const ch of ['r', 'g', 'b', 'rgb']) {
      if (ch === channel) continue;
      const p = value[ch];
      if (p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 255 && p[1][1] === 255) continue;
      drawCurve(ch, 0.35);
    }
    drawCurve(channel, 1);
    for (const [x, y] of pts()) {
      ctx.fillStyle = COLORS[channel];
      ctx.beginPath(); ctx.arc(x, 255 - y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#000'; ctx.stroke();
    }
  }

  function drawCurve(ch, alpha) {
    const lut = curveLUT(value[ch]);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = COLORS[ch];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x < 256; x++) (x ? ctx.lineTo(x, 255 - lut[x]) : ctx.moveTo(x, 255 - lut[x]));
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  const changed = () => { draw(); onChange(value); };

  // Hit radius in curve units (0..255); fingers need a bigger target than a mouse.
  const reach = (e) => (e.pointerType === 'touch' ? 22 : 10);
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = toLocal(e), list = pts();
    drag = list.findIndex(([x, y]) => Math.hypot(x - p.x, y - p.y) < reach(e));
    if (drag < 0) {
      list.push([Math.round(p.x), Math.round(p.y)]);
      list.sort((a, b) => a[0] - b[0]);
      drag = list.findIndex(([x, y]) => x === Math.round(p.x) && y === Math.round(p.y));
      changed();
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = toLocal(e);
    readout.textContent = `${Math.round(Math.max(0, Math.min(255, p.x)))} → ${curveLUT(pts())[Math.round(Math.max(0, Math.min(255, p.x)))]}`;
    if (drag < 0) return;
    const list = pts();
    const last = list.length - 1;
    const outside = p.y < -30 || p.y > 285 || p.x < -30 || p.x > 285;
    if (outside && drag > 0 && drag < last) { list.splice(drag, 1); drag = -1; changed(); return; }
    const lo = drag > 0 ? list[drag - 1][0] + 1 : 0, hi = drag < last ? list[drag + 1][0] - 1 : 255;
    list[drag] = [Math.round(Math.max(lo, Math.min(hi, p.x))), Math.round(Math.max(0, Math.min(255, p.y)))];
    changed();
  });
  const end = () => { drag = -1; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', (e) => {
    const p = toLocal(e), list = pts();
    const i = list.findIndex(([x, y]) => Math.hypot(x - p.x, y - p.y) < 10);
    if (i > 0 && i < list.length - 1) { list.splice(i, 1); changed(); }
  });

  draw();
  return el('div', { class: 'pe-curves' },
    el('div', { class: 'row' }, el('span', { class: 'muted' }, 'Channel'), chSel, el('div', { class: 'spacer' }), readout),
    canvas,
    el('div', { class: 'muted pe-small' }, 'Click or tap to add a point, drag to shape, double-click or drag it off the graph to remove.'));
}
