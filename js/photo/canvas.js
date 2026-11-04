// Small canvas helpers shared by the photo editor modules.

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function copyCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

// Integer rect clamped to [0,0,W,H]; returns null when empty.
export function clampRect(x, y, w, h, W, H) {
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(W, Math.ceil(x + w)), y1 = Math.min(H, Math.ceil(y + h));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export function unionRect(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

// Normalized rect from two points.
export function rectFrom(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

// High quality downscale (halving steps) so big reductions don't alias.
export function resample(src, w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  let cur = src, cw = src.width, ch = src.height;
  while (cw / 2 >= w && ch / 2 >= h) {
    const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
    const step = makeCanvas(nw, nh), sc = step.getContext('2d');
    sc.imageSmoothingQuality = 'high';
    sc.drawImage(cur, 0, 0, nw, nh);
    cur = step; cw = nw; ch = nh;
  }
  const out = makeCanvas(w, h), oc = out.getContext('2d');
  oc.imageSmoothingQuality = 'high';
  oc.drawImage(cur, 0, 0, w, h);
  return out;
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image'));
    img.src = src;
  });
}

export async function fileToImage(file) {
  const url = URL.createObjectURL(file);
  try { return await loadImage(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Export failed'))), type, quality));
}
