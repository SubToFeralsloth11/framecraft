// Colour grading, preset looks, drop-on effects and the per-pixel stage (temperature, split toning,
// chroma key, grain, posterize). CSS-style adjustments go through ctx.filter when the browser has
// it; otherwise they are folded into one affine colour matrix and applied per pixel.

export const CSS_FILTER = typeof document !== 'undefined' && (() => {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!('filter' in ctx)) return false;
  ctx.filter = 'blur(2px)';
  return ctx.filter === 'blur(2px)';
})();

export const BLEND_MODES = {
  'source-over': 'Normal', multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', darken: 'Darken', lighten: 'Lighten',
  'color-dodge': 'Color dodge', 'color-burn': 'Color burn', 'hard-light': 'Hard light', 'soft-light': 'Soft light',
  difference: 'Difference', exclusion: 'Exclusion', hue: 'Hue', saturation: 'Saturation', color: 'Color', luminosity: 'Luminosity', lighter: 'Add',
};

// css: multiplied into the clip's own adjustments. tone: split toning (shadow/highlight RGB shift).
export const LOOKS = {
  none: { name: 'None' },
  cinematic: { name: 'Cinematic', css: { contrast: 1.12, saturate: 0.85, brightness: 0.97 }, tone: { sh: [-0.02, 0.03, 0.08], hi: [0.06, 0.03, -0.02] }, vignette: 0.25 },
  noir: { name: 'Noir', css: { grayscale: 1, contrast: 1.45, brightness: 0.95 }, vignette: 0.35 },
  vintage: { name: 'Vintage', css: { sepia: 0.45, contrast: 0.9, saturate: 0.85, brightness: 1.04 }, fade: 0.08, temp: 0.2, vignette: 0.3 },
  tealorange: { name: 'Teal & Orange', css: { contrast: 1.1, saturate: 1.15 }, tone: { sh: [-0.07, 0.04, 0.11], hi: [0.11, 0.04, -0.08] } },
  warm: { name: 'Warm Sun', css: { saturate: 1.1, brightness: 1.03 }, temp: 0.45 },
  cool: { name: 'Cold Blue', css: { saturate: 0.9 }, temp: -0.45 },
  vivid: { name: 'Vivid', css: { saturate: 1.45, contrast: 1.08 } },
  faded: { name: 'Faded Film', css: { contrast: 0.85, saturate: 0.75 }, fade: 0.12, tone: { sh: [0.02, 0, 0.05], hi: [0.04, 0.02, 0] } },
};

// amount: 0–100 (default `def`); `fixed` effects have no amount slider. `icon` is a js/icons.js name.
export const EFFECTS = {
  bw: { name: 'Black & White', icon: 'contrast', def: 100 },
  sepia: { name: 'Sepia', icon: 'sepia', def: 80 },
  invert: { name: 'Invert', icon: 'invert', def: 100 },
  blur: { name: 'Gaussian Blur', icon: 'blur', def: 30 },
  pixelate: { name: 'Pixelate', icon: 'pixelate', def: 40 },
  mirror: { name: 'Mirror (flip)', icon: 'mirror', fixed: true },
  grain: { name: 'Film Grain', icon: 'grain', def: 35 },
  posterize: { name: 'Posterize', icon: 'posterize', def: 50 },
  glow: { name: 'Glow', icon: 'glow', def: 50 },
};

const MULT = new Set(['brightness', 'contrast', 'saturate']);

// Resolves a clip's colour settings, look and effects into one render plan.
export function gradeOf(c) {
  const col = c.color, look = LOOKS[c.look] || LOOKS.none;
  const css = { brightness: col.brightness / 100, contrast: col.contrast / 100, saturate: col.saturation / 100, hue: col.hue, grayscale: 0, sepia: 0, invert: 0, blur: col.blur };
  for (const [k, v] of Object.entries(look.css || {})) css[k] = MULT.has(k) ? css[k] * v : Math.max(css[k], v);
  const g = { css, vignette: Math.max(col.vignette / 100, look.vignette || 0), mirror: false, pixelate: 0, glow: 0, grain: 0, posterize: 0 };
  for (const fx of c.effects || []) {
    const a = (fx.amount ?? 100) / 100;
    if (fx.type === 'bw') css.grayscale = Math.max(css.grayscale, a);
    else if (fx.type === 'sepia') css.sepia = Math.max(css.sepia, a);
    else if (fx.type === 'invert') css.invert = Math.max(css.invert, a);
    else if (fx.type === 'blur') css.blur += a * 24;
    else if (fx.type === 'pixelate') g.pixelate = Math.max(g.pixelate, 4 + a * 44);
    else if (fx.type === 'mirror') g.mirror = !g.mirror;
    else if (fx.type === 'grain') g.grain = Math.max(g.grain, a);
    else if (fx.type === 'posterize') g.posterize = Math.max(g.posterize, a);
    else if (fx.type === 'glow') g.glow = Math.max(g.glow, a);
  }
  const temp = col.temperature / 100 + (look.temp || 0);
  // Per-pixel affine part: temperature + fade, plus the CSS chain when ctx.filter is missing.
  let m = identity();
  if (temp) m = mul(diag(1 + 0.16 * temp, 1 + 0.03 * temp, 1 - 0.16 * temp), m);
  if (look.fade) m = mul(affineScalar(1 - look.fade, 255 * look.fade), m);
  if (!CSS_FILTER) m = mul(cssMatrix(css), m);
  const chroma = c.chroma?.on ? c.chroma : null;
  g.pixel = (isIdentity(m) && !look.tone && !chroma && !g.grain && !g.posterize) ? null
    : { m: isIdentity(m) ? null : m, tone: look.tone || null, chroma, grain: g.grain, posterize: g.posterize };
  g.needsLayer = !!(g.pixel || g.vignette > 0 || g.pixelate || (!CSS_FILTER && css.blur > 0));
  return g;
}

export function cssString(css, k = 1, extraBlur = 0) {
  const f = [];
  if (Math.abs(css.brightness - 1) > 1e-3) f.push(`brightness(${css.brightness})`);
  if (Math.abs(css.contrast - 1) > 1e-3) f.push(`contrast(${css.contrast})`);
  if (Math.abs(css.saturate - 1) > 1e-3) f.push(`saturate(${css.saturate})`);
  if (css.hue) f.push(`hue-rotate(${css.hue}deg)`);
  if (css.grayscale > 0) f.push(`grayscale(${css.grayscale})`);
  if (css.sepia > 0) f.push(`sepia(${css.sepia})`);
  if (css.invert > 0) f.push(`invert(${css.invert})`);
  const b = css.blur * k + extraBlur;
  if (b > 0.05) f.push(`blur(${b.toFixed(2)}px)`);
  return f.length ? f.join(' ') : 'none';
}

// ---------- 3x4 affine colour matrices (rows r,g,b; last column = offset in 0–255) ----------
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const diag = (r, g, b) => [r, 0, 0, 0, 0, g, 0, 0, 0, 0, b, 0];
const affineScalar = (s, o) => [s, 0, 0, o, 0, s, 0, o, 0, 0, s, o];
const lin = (a) => [a[0], a[1], a[2], 0, a[3], a[4], a[5], 0, a[6], a[7], a[8], 0];
const isIdentity = (m) => m.every((v, i) => Math.abs(v - identity()[i]) < 1e-6);
// a ∘ b (apply b first)
function mul(a, b) {
  const o = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c];
    o[r * 4 + 3] = a[r * 4] * b[3] + a[r * 4 + 1] * b[7] + a[r * 4 + 2] * b[11] + a[r * 4 + 3];
  }
  return o;
}

// Same chain and order as cssString (Filter Effects spec matrices).
export function cssMatrix(css) {
  let m = identity();
  m = mul(diag(css.brightness, css.brightness, css.brightness), m);
  m = mul(affineScalar(css.contrast, 127.5 * (1 - css.contrast)), m);
  const s = css.saturate;
  m = mul(lin([0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s]), m);
  if (css.hue) {
    const a = (css.hue * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a);
    m = mul(lin([
      0.213 + co * 0.787 - si * 0.213, 0.715 - co * 0.715 - si * 0.715, 0.072 - co * 0.072 + si * 0.928,
      0.213 - co * 0.213 + si * 0.143, 0.715 + co * 0.285 + si * 0.140, 0.072 - co * 0.072 - si * 0.283,
      0.213 - co * 0.213 - si * 0.787, 0.715 - co * 0.715 + si * 0.715, 0.072 + co * 0.928 + si * 0.072]), m);
  }
  if (css.grayscale > 0) {
    const g = 1 - css.grayscale;
    m = mul(lin([0.2126 + 0.7874 * g, 0.7152 - 0.7152 * g, 0.0722 - 0.0722 * g, 0.2126 - 0.2126 * g, 0.7152 + 0.2848 * g, 0.0722 - 0.0722 * g, 0.2126 - 0.2126 * g, 0.7152 - 0.7152 * g, 0.0722 + 0.9278 * g]), m);
  }
  if (css.sepia > 0) {
    const g = 1 - css.sepia;
    m = mul(lin([0.393 + 0.607 * g, 0.769 - 0.769 * g, 0.189 - 0.189 * g, 0.349 - 0.349 * g, 0.686 + 0.314 * g, 0.168 - 0.168 * g, 0.272 - 0.272 * g, 0.534 - 0.534 * g, 0.131 + 0.869 * g]), m);
  }
  if (css.invert > 0) m = mul(affineScalar(1 - 2 * css.invert, 255 * css.invert), m);
  return m;
}

export const hexToRgb = (hex) => { const n = parseInt(String(hex).replace('#', ''), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

let seed = 1;
// Applies the per-pixel stage in place on RGBA data.
export function processPixels(d, px) {
  const m = px.m, tone = px.tone;
  let kcb = 0, kcr = 0, tol = 0, soft = 0, spill = -1;
  if (px.chroma) {
    const [r, g, b] = hexToRgb(px.chroma.color);
    kcb = (-0.168736 * r - 0.331264 * g + 0.5 * b) / 255;
    kcr = (0.5 * r - 0.418688 * g - 0.081312 * b) / 255;
    tol = (px.chroma.tol / 100) * 0.45;
    soft = Math.max(0.005, (px.chroma.soft / 100) * 0.3);
    spill = g >= r && g >= b ? 1 : b >= r ? 2 : 0;
  }
  const grain = px.grain * 60;
  const levels = px.posterize ? Math.round(2 + (1 - px.posterize) * 10) : 0;
  const step = levels ? 255 / (levels - 1) : 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    let r = d[i], g = d[i + 1], b = d[i + 2];
    if (px.chroma) {
      const cb = (-0.168736 * r - 0.331264 * g + 0.5 * b) / 255 - kcb;
      const cr = (0.5 * r - 0.418688 * g - 0.081312 * b) / 255 - kcr;
      const dist = Math.sqrt(cb * cb + cr * cr);
      if (dist < tol) { d[i + 3] = 0; continue; }
      if (dist < tol + soft) {
        d[i + 3] = d[i + 3] * ((dist - tol) / soft);
        // spill suppression on the keyed channel
        if (spill === 1) g = Math.min(g, Math.max(r, b));
        else if (spill === 2) b = Math.min(b, Math.max(r, g));
        else r = Math.min(r, Math.max(g, b));
      }
    }
    if (m) {
      const nr = m[0] * r + m[1] * g + m[2] * b + m[3];
      const ng = m[4] * r + m[5] * g + m[6] * b + m[7];
      const nb = m[8] * r + m[9] * g + m[10] * b + m[11];
      r = nr; g = ng; b = nb;
    }
    if (tone) {
      const l = Math.min(1, Math.max(0, (0.299 * r + 0.587 * g + 0.114 * b) / 255));
      const ws = (1 - l) * (1 - l) * 255, wh = l * l * 255;
      r += tone.sh[0] * ws + tone.hi[0] * wh;
      g += tone.sh[1] * ws + tone.hi[1] * wh;
      b += tone.sh[2] * ws + tone.hi[2] * wh;
    }
    if (levels) { r = Math.round(r / step) * step; g = Math.round(g / step) * step; b = Math.round(b / step) * step; }
    if (grain) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const n = ((seed >>> 8) / 16777216 - 0.5) * grain;
      r += n; g += n; b += n;
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = b; // Uint8ClampedArray clamps and rounds
  }
}
