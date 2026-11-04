// Pure pixel math on RGBA Uint8ClampedArray buffers. No DOM access, so this module
// runs both on the main thread and inside filter-worker.js (and in node for tests).
// Every filter has the shape fn(data, w, h, params, info) and returns the result
// buffer (often `data` itself, modified in place). `info` = { x, y, W, H }: offset of
// this region inside the full document and the document size, for position-aware filters.

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------- helpers ----------

function applyLUT(data, lr, lg = lr, lb = lr) {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lr[data[i]];
    data[i + 1] = lg[data[i + 1]];
    data[i + 2] = lb[data[i + 2]];
  }
  return data;
}

function makeLUT(fn) {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(fn(i));
  return lut;
}

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

export function hslToRgb(h, s, l) {
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// Deterministic PRNG so live previews of noise do not flicker between runs.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.round(clamp255(v)).toString(16).padStart(2, '0')).join('');
}

// ---------- tone & color adjustments ----------

export function brightnessContrast(data, w, h, { brightness = 0, contrast = 0 }) {
  const c = contrast * 2.55;
  const f = (259 * (c + 255)) / (255 * (259 - c));
  const b = brightness * 1.5;
  return applyLUT(data, makeLUT((v) => f * (v + b - 128) + 128));
}

const toLinear = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const toSrgb = (v) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

export function exposure(data, w, h, { exposure: ev = 0, gamma = 1 }) {
  const k = Math.pow(2, ev);
  return applyLUT(data, makeLUT((v) => toSrgb(clamp01(Math.pow(toLinear(v) * k, 1 / gamma)))));
}

export function hueSaturation(data, w, h, { hue = 0, saturation = 0, lightness = 0 }) {
  const dh = hue / 360, ks = saturation / 100, kl = lightness / 100;
  for (let i = 0; i < data.length; i += 4) {
    let [hh, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    hh = (hh + dh + 1) % 1;
    s = clamp01(s * (1 + ks));
    let [r, g, b] = hslToRgb(hh, s, l);
    if (kl > 0) { r += (255 - r) * kl; g += (255 - g) * kl; b += (255 - b) * kl; }
    else if (kl < 0) { r *= 1 + kl; g *= 1 + kl; b *= 1 + kl; }
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }
  return data;
}

export function vibrance(data, w, h, { vibrance: vib = 0, saturation = 0 }) {
  const kv = vib / 100, ks = saturation / 100;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = (mx - mn) / 255;
    const k = 1 + ks + kv * (1 - sat) * (kv > 0 ? 1 : sat + 1);
    const L = luma(r, g, b);
    data[i] = L + (r - L) * k; data[i + 1] = L + (g - L) * k; data[i + 2] = L + (b - L) * k;
  }
  return data;
}

export function colorBalance(data, w, h, { cyanRed = 0, magentaGreen = 0, yellowBlue = 0, tone = 'midtones', preserve = true }) {
  const dr = cyanRed * 0.6, dg = magentaGreen * 0.6, db = yellowBlue * 0.6;
  const weight = makeLUTf((L) => (tone === 'shadows' ? (1 - L) * (1 - L) : tone === 'highlights' ? L * L : 1 - (2 * L - 1) * (2 * L - 1)));
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const L0 = luma(r, g, b);
    const wgt = weight[Math.round(L0)];
    let nr = r + dr * wgt, ng = g + dg * wgt, nb = b + db * wgt;
    if (preserve) {
      const d = L0 - luma(clamp255(nr), clamp255(ng), clamp255(nb));
      nr += d; ng += d; nb += d;
    }
    data[i] = nr; data[i + 1] = ng; data[i + 2] = nb;
  }
  return data;
}

function makeLUTf(fn) {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = fn(i / 255);
  return lut;
}

export function levelsLUT({ inBlack = 0, inWhite = 255, gamma = 1, outBlack = 0, outWhite = 255 }) {
  const span = Math.max(1, inWhite - inBlack);
  return makeLUT((v) => outBlack + Math.pow(clamp01((v - inBlack) / span), 1 / gamma) * (outWhite - outBlack));
}

export function levels(data, w, h, p) {
  return applyLUT(data, levelsLUT(p));
}

// Monotone cubic (Fritsch–Carlson) interpolation through control points [[x,y],...] in 0..255.
export function curveLUT(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const lut = new Uint8ClampedArray(256);
  if (pts.length === 0) { for (let i = 0; i < 256; i++) lut[i] = i; return lut; }
  if (pts.length === 1) { lut.fill(pts[0][1]); return lut; }
  const n = pts.length;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const dx = [], m = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = Math.max(1e-6, xs[i + 1] - xs[i]); m[i] = (ys[i + 1] - ys[i]) / dx[i]; }
  const t = new Array(n);
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  for (let x = 0; x < 256; x++) {
    let y;
    if (x <= xs[0]) y = ys[0];
    else if (x >= xs[n - 1]) y = ys[n - 1];
    else {
      let i = 0;
      while (x > xs[i + 1]) i++;
      const hh = dx[i], u = (x - xs[i]) / hh, u2 = u * u, u3 = u2 * u;
      y = (2 * u3 - 3 * u2 + 1) * ys[i] + (u3 - 2 * u2 + u) * hh * t[i] + (-2 * u3 + 3 * u2) * ys[i + 1] + (u3 - u2) * hh * t[i + 1];
    }
    lut[x] = Math.round(y);
  }
  return lut;
}

export function curves(data, w, h, { curve }) {
  const master = curveLUT(curve.rgb);
  const [lr, lg, lb] = [curve.r, curve.g, curve.b].map((pts) => curveLUT(pts));
  const cr = new Uint8ClampedArray(256), cg = new Uint8ClampedArray(256), cb = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) { cr[i] = master[lr[i]]; cg[i] = master[lg[i]]; cb[i] = master[lb[i]]; }
  return applyLUT(data, cr, cg, cb);
}

export function temperatureTint(data, w, h, { temperature = 0, tint = 0 }) {
  const t = temperature / 100, n = tint / 100;
  const rg = 1 + t * 0.25, bg = 1 - t * 0.25, gg = 1 - n * 0.2;
  return applyLUT(data, makeLUT((v) => v * rg), makeLUT((v) => v * gg), makeLUT((v) => v * bg));
}

export function grayscale(data) {
  for (let i = 0; i < data.length; i += 4) {
    const L = luma(data[i], data[i + 1], data[i + 2]);
    data[i] = data[i + 1] = data[i + 2] = L;
  }
  return data;
}

export function sepia(data, w, h, { amount = 100 } = {}) {
  const a = amount / 100;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const sr = 0.393 * r + 0.769 * g + 0.189 * b;
    const sg = 0.349 * r + 0.686 * g + 0.168 * b;
    const sb = 0.272 * r + 0.534 * g + 0.131 * b;
    data[i] = r + (sr - r) * a; data[i + 1] = g + (sg - g) * a; data[i + 2] = b + (sb - b) * a;
  }
  return data;
}

export function invert(data) {
  for (let i = 0; i < data.length; i += 4) { data[i] = 255 - data[i]; data[i + 1] = 255 - data[i + 1]; data[i + 2] = 255 - data[i + 2]; }
  return data;
}

export function threshold(data, w, h, { level = 128 }) {
  for (let i = 0; i < data.length; i += 4) {
    const v = luma(data[i], data[i + 1], data[i + 2]) >= level ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = v;
  }
  return data;
}

export function posterize(data, w, h, { levels: n = 4 }) {
  const k = Math.max(2, n) - 1;
  return applyLUT(data, makeLUT((v) => (Math.round((v / 255) * k) * 255) / k));
}

// ---------- blur family ----------

function hasTransparency(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
  return false;
}

function premultiply(data) {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    data[i] *= a; data[i + 1] *= a; data[i + 2] *= a;
  }
}

function unpremultiply(data) {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a && a !== 255) { const k = 255 / a; data[i] *= k; data[i + 1] *= k; data[i + 2] *= k; }
  }
}

// Box sizes for a 3-pass box blur approximating a gaussian of the given sigma.
export function boxesForGauss(sigma, n = 3) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

// Horizontal running-sum box blur of radius r from src into dst (RGBA interleaved, edge clamped).
function boxH(src, dst, w, h, r) {
  const div = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let c = 0; c < 4; c++) {
      const first = src[row + c], last = src[row + (w - 1) * 4 + c];
      let acc = (r + 1) * first;
      for (let j = 0; j < r; j++) acc += src[row + Math.min(j, w - 1) * 4 + c];
      for (let x = 0; x < w; x++) {
        acc += x + r < w ? src[row + (x + r) * 4 + c] : last;
        acc -= x - r - 1 >= 0 ? src[row + (x - r - 1) * 4 + c] : first;
        dst[row + x * 4 + c] = acc / div;
      }
    }
  }
}

function boxV(src, dst, w, h, r) {
  const div = 2 * r + 1, stride = w * 4;
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) {
      const col = x * 4 + c;
      const first = src[col], last = src[(h - 1) * stride + col];
      let acc = (r + 1) * first;
      for (let j = 0; j < r; j++) acc += src[Math.min(j, h - 1) * stride + col];
      for (let y = 0; y < h; y++) {
        acc += y + r < h ? src[(y + r) * stride + col] : last;
        acc -= y - r - 1 >= 0 ? src[(y - r - 1) * stride + col] : first;
        dst[y * stride + col] = acc / div;
      }
    }
  }
}

export function gaussianBlur(data, w, h, { radius = 4 }) {
  if (radius <= 0) return data;
  const alpha = hasTransparency(data);
  if (alpha) premultiply(data);
  const tmp = new Uint8ClampedArray(data.length);
  for (const size of boxesForGauss(radius, 3)) {
    const r = (size - 1) >> 1;
    if (r < 1) continue;
    boxH(data, tmp, w, h, r);
    boxV(tmp, data, w, h, r);
  }
  if (alpha) unpremultiply(data);
  return data;
}

export function motionBlur(data, w, h, { angle = 0, distance = 20 }) {
  if (distance < 1) return data;
  const src = data.slice();
  const rad = (angle * Math.PI) / 180;
  const n = Math.max(2, Math.min(64, Math.round(distance)));
  const ox = new Int32Array(n), oy = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    const t = (k / (n - 1) - 0.5) * distance;
    ox[k] = Math.round(Math.cos(rad) * t);
    oy[k] = Math.round(-Math.sin(rad) * t);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < n; k++) {
        let sx = x + ox[k], sy = y + oy[k];
        sx = sx < 0 ? 0 : sx >= w ? w - 1 : sx;
        sy = sy < 0 ? 0 : sy >= h ? h - 1 : sy;
        const j = (sy * w + sx) * 4, sa = src[j + 3];
        r += src[j] * sa; g += src[j + 1] * sa; b += src[j + 2] * sa; a += sa;
      }
      const i = (y * w + x) * 4;
      if (a > 0) { data[i] = r / a; data[i + 1] = g / a; data[i + 2] = b / a; }
      data[i + 3] = a / n;
    }
  }
  return data;
}

export function unsharpMask(data, w, h, { amount = 100, radius = 2, threshold: th = 0 }) {
  const blurred = gaussianBlur(data.slice(), w, h, { radius });
  const k = amount / 100;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = data[i + c] - blurred[i + c];
      if (Math.abs(d) >= th) data[i + c] = data[i + c] + d * k;
    }
  }
  return data;
}

export function addNoise(data, w, h, { amount = 10, mono = false, seed = 1 }) {
  const rnd = mulberry32(seed);
  const a = amount * 2.55;
  for (let i = 0; i < data.length; i += 4) {
    if (mono) {
      const n = (rnd() + rnd() - 1) * a;
      data[i] += n; data[i + 1] += n; data[i + 2] += n;
    } else {
      data[i] += (rnd() + rnd() - 1) * a;
      data[i + 1] += (rnd() + rnd() - 1) * a;
      data[i + 2] += (rnd() + rnd() - 1) * a;
    }
  }
  return data;
}

// Median filter (Huang's sliding histogram with running median tracking), RGB channels.
export function median(data, w, h, { radius = 1 }) {
  const r = Math.max(1, Math.round(radius));
  const src = data.slice();
  const half = ((2 * r + 1) * (2 * r + 1)) >> 1;
  const hist = new Int32Array(256);
  const cx = (x) => (x < 0 ? 0 : x >= w ? w - 1 : x);
  const cy = (y) => (y < 0 ? 0 : y >= h ? h - 1 : y);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      hist.fill(0);
      for (let dy = -r; dy <= r; dy++) {
        const row = cy(y + dy) * w;
        for (let dx = -r; dx <= r; dx++) hist[src[(row + cx(dx)) * 4 + c]]++;
      }
      let m = 0, ltm = 0;
      while (ltm + hist[m] <= half) { ltm += hist[m]; m++; }
      data[y * w * 4 + c] = m;
      for (let x = 1; x < w; x++) {
        const xo = cx(x - r - 1), xi = cx(x + r);
        for (let dy = -r; dy <= r; dy++) {
          const row = cy(y + dy) * w;
          const vo = src[(row + xo) * 4 + c];
          hist[vo]--; if (vo < m) ltm--;
          const vi = src[(row + xi) * 4 + c];
          hist[vi]++; if (vi < m) ltm++;
        }
        while (ltm > half) { m--; ltm -= hist[m]; }
        while (ltm + hist[m] <= half) { ltm += hist[m]; m++; }
        data[(y * w + x) * 4 + c] = m;
      }
    }
  }
  return data;
}

export function pixelate(data, w, h, { size = 10 }, info = { x: 0, y: 0 }) {
  const s = Math.max(1, Math.round(size));
  const x0 = -(((info.x % s) + s) % s), y0 = -(((info.y % s) + s) % s);
  for (let by = y0; by < h; by += s) {
    for (let bx = x0; bx < w; bx += s) {
      const xs = Math.max(0, bx), ys = Math.max(0, by), xe = Math.min(w, bx + s), ye = Math.min(h, by + s);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = ys; y < ye; y++) for (let x = xs; x < xe; x++) {
        const i = (y * w + x) * 4, al = data[i + 3];
        r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al; a += al; n++;
      }
      if (!n) continue;
      const cr = a ? r / a : 0, cg = a ? g / a : 0, cb = a ? b / a : 0, ca = a / n;
      for (let y = ys; y < ye; y++) for (let x = xs; x < xe; x++) {
        const i = (y * w + x) * 4;
        data[i] = cr; data[i + 1] = cg; data[i + 2] = cb; data[i + 3] = ca;
      }
    }
  }
  return data;
}

function lumaPlane(data, w, h) {
  const L = new Float32Array(w * h);
  for (let i = 0, j = 0; j < L.length; i += 4, j++) L[j] = luma(data[i], data[i + 1], data[i + 2]);
  return L;
}

export function emboss(data, w, h, { amount = 100, angle = 135 }) {
  const L = lumaPlane(data, w, h);
  const a = amount / 100, rad = (angle * Math.PI) / 180;
  const dx = Math.round(Math.cos(rad)), dy = Math.round(-Math.sin(rad));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x1 = Math.min(w - 1, Math.max(0, x + dx)), y1 = Math.min(h - 1, Math.max(0, y + dy));
      const x2 = Math.min(w - 1, Math.max(0, x - dx)), y2 = Math.min(h - 1, Math.max(0, y - dy));
      const v = 128 + (L[y1 * w + x1] - L[y2 * w + x2]) * 2;
      const i = (y * w + x) * 4;
      data[i] += (v - data[i]) * a; data[i + 1] += (v - data[i + 1]) * a; data[i + 2] += (v - data[i + 2]) * a;
    }
  }
  return data;
}

export function edgeDetect(data, w, h, { strength = 100, invert: inv = false }) {
  const L = lumaPlane(data, w, h);
  const k = strength / 100;
  const at = (x, y) => L[(y < 0 ? 0 : y >= h ? h - 1 : y) * w + (x < 0 ? 0 : x >= w ? w - 1 : x)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      let v = Math.min(255, Math.sqrt(gx * gx + gy * gy) * k);
      if (inv) v = 255 - v;
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
  }
  return data;
}

export function vignette(data, w, h, { amount = 50, size = 50, softness = 50 }, info = { x: 0, y: 0, W: w, H: h }) {
  const cx = info.W / 2, cy = info.H / 2;
  const start = 0.2 + (size / 100) * 1.0, soft = 0.05 + (softness / 100) * 1.2;
  const k = Math.abs(amount) / 100, darken = amount >= 0;
  for (let y = 0; y < h; y++) {
    const ny = (y + info.y + 0.5 - cy) / cy;
    for (let x = 0; x < w; x++) {
      const nx = (x + info.x + 0.5 - cx) / cx;
      const d = Math.sqrt(nx * nx + ny * ny);
      let t = clamp01((d - start) / soft);
      t = t * t * (3 - 2 * t) * k;
      if (!t) continue;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) data[i + c] = darken ? data[i + c] * (1 - t) : data[i + c] + (255 - data[i + c]) * t;
    }
  }
  return data;
}

export function chromaKey(data, w, h, { color = '#00ff00', tolerance = 25, softness = 10, despill = true }) {
  const [kr, kg, kb] = hexToRgb(color);
  const tol = (tolerance / 100) * 441.7, soft = Math.max(0.001, (softness / 100) * 441.7);
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - kr, dg = data[i + 1] - kg, db = data[i + 2] - kb;
    const d = Math.sqrt(dr * dr + dg * dg + db * db);
    if (d >= tol + soft) continue;
    const keep = d <= tol ? 0 : (d - tol) / soft;
    data[i + 3] *= keep;
    if (despill && keep > 0) {
      // Pull the key color out of semi-transparent edge pixels.
      const f = 1 - keep;
      data[i] -= kr * f * 0.5; data[i + 1] -= kg * f * 0.5; data[i + 2] -= kb * f * 0.5;
    }
  }
  return data;
}

// ---------- presets (one-click looks) ----------

export const PRESETS = {
  Vivid: [['vibrance', { vibrance: 45, saturation: 10 }], ['brightnessContrast', { brightness: 0, contrast: 15 }]],
  Noir: [['grayscale', {}], ['brightnessContrast', { brightness: -5, contrast: 40 }], ['vignette', { amount: 45, size: 40, softness: 60 }]],
  Vintage: [['sepia', { amount: 45 }], ['levels', { inBlack: 0, inWhite: 255, gamma: 1.05, outBlack: 30, outWhite: 240 }], ['temperatureTint', { temperature: 15, tint: 5 }], ['vignette', { amount: 35, size: 45, softness: 70 }]],
  Cool: [['temperatureTint', { temperature: -35, tint: 0 }], ['vibrance', { vibrance: 10, saturation: 0 }]],
  Warm: [['temperatureTint', { temperature: 35, tint: 5 }], ['vibrance', { vibrance: 10, saturation: 0 }]],
  Fade: [['levels', { inBlack: 0, inWhite: 255, gamma: 1.1, outBlack: 45, outWhite: 235 }], ['hueSaturation', { hue: 0, saturation: -25, lightness: 0 }]],
  Dramatic: [['brightnessContrast', { brightness: -5, contrast: 35 }], ['hueSaturation', { hue: 0, saturation: -20, lightness: 0 }], ['vignette', { amount: 30, size: 45, softness: 60 }]],
};

export function preset(data, w, h, { name }, info) {
  for (const [op, p] of PRESETS[name] || []) data = FILTERS[op](data, w, h, p, info);
  return data;
}

export const FILTERS = {
  brightnessContrast, exposure, hueSaturation, vibrance, colorBalance, levels, curves, temperatureTint,
  grayscale, sepia, invert, threshold, posterize, gaussianBlur, motionBlur, unsharpMask, addNoise, median,
  pixelate, emboss, edgeDetect, vignette, chromaKey, preset,
};

// Run filter `op` on a region and blend the result back by selection mask (0..255 per pixel, or null).
export function runFilter(op, data, w, h, params, info, mask) {
  const fn = FILTERS[op];
  if (!fn) throw new Error(`Unknown filter ${op}`);
  const orig = mask ? data.slice() : null;
  let out = fn(data, w, h, params, info || { x: 0, y: 0, W: w, H: h });
  if (mask) out = blendMask(orig, out, mask);
  return out;
}

export function blendMask(orig, res, mask) {
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    const m = mask[p];
    if (m === 255) continue;
    if (m === 0) { res[i] = orig[i]; res[i + 1] = orig[i + 1]; res[i + 2] = orig[i + 2]; res[i + 3] = orig[i + 3]; continue; }
    const k = m / 255;
    res[i] = orig[i] + (res[i] - orig[i]) * k;
    res[i + 1] = orig[i + 1] + (res[i + 1] - orig[i + 1]) * k;
    res[i + 2] = orig[i + 2] + (res[i + 2] - orig[i + 2]) * k;
    res[i + 3] = orig[i + 3] + (res[i + 3] - orig[i + 3]) * k;
  }
  return res;
}

// ---------- analysis & selection helpers ----------

export function histogram(data) {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    r[data[i]]++; g[data[i + 1]]++; b[data[i + 2]]++;
    l[Math.round(luma(data[i], data[i + 1], data[i + 2]))]++;
  }
  return { r, g, b, l };
}

// Magic wand / paint bucket region. Returns Uint8Array mask (0 / 255).
// tolerance: max per-channel difference (0..255) from the seed pixel, RGBA.
export function floodMask(data, w, h, sx, sy, tolerance, contiguous = true) {
  const mask = new Uint8Array(w * h);
  sx = Math.floor(sx); sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
  const s = (sy * w + sx) * 4;
  const r0 = data[s], g0 = data[s + 1], b0 = data[s + 2], a0 = data[s + 3];
  const t = tolerance;
  const match = (p) => {
    const i = p * 4;
    if (a0 === 0 && data[i + 3] <= t) return true;
    return Math.abs(data[i] - r0) <= t && Math.abs(data[i + 1] - g0) <= t && Math.abs(data[i + 2] - b0) <= t && Math.abs(data[i + 3] - a0) <= t;
  };
  if (!contiguous) {
    for (let p = 0; p < w * h; p++) if (match(p)) mask[p] = 255;
    return mask;
  }
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop(), x0 = stack.pop();
    let x = x0;
    const row = y * w;
    while (x >= 0 && !mask[row + x] && match(row + x)) x--;
    x++;
    let up = false, down = false;
    while (x < w && !mask[row + x] && match(row + x)) {
      mask[row + x] = 255;
      if (y > 0) {
        const m = !mask[row - w + x] && match(row - w + x);
        if (m && !up) { stack.push(x, y - 1); up = true; } else if (!m) up = false;
      }
      if (y < h - 1) {
        const m = !mask[row + w + x] && match(row + w + x);
        if (m && !down) { stack.push(x, y + 1); down = true; } else if (!m) down = false;
      }
      x++;
    }
  }
  return mask;
}

// Boundary of a mask (alpha >= 128 = inside) as merged line segments [x1,y1,x2,y2,...].
export function maskOutline(mask, w, h, stride = 1, offset = 0) {
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[(y * w + x) * stride + offset] >= 128;
  const segs = [];
  for (let y = 0; y <= h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const edge = x < w && inside(x, y - 1) !== inside(x, y);
      if (edge && start < 0) start = x;
      else if (!edge && start >= 0) { segs.push(start, y, x, y); start = -1; }
    }
  }
  for (let x = 0; x <= w; x++) {
    let start = -1;
    for (let y = 0; y <= h; y++) {
      const edge = y < h && inside(x - 1, y) !== inside(x, y);
      if (edge && start < 0) start = y;
      else if (!edge && start >= 0) { segs.push(x, start, x, y); start = -1; }
    }
  }
  return segs;
}

// Bounding box of mask pixels > 0: {x, y, w, h} or null.
export function maskBounds(mask, w, h, stride = 1, offset = 0) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[(row + x) * stride + offset]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
