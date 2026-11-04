// Generated clip sources: titles, solid/gradient backgrounds and shapes, rendered to cached canvases
// at output resolution (sizes are defined relative to a 1080px short side).

export const FONTS = {
  system: { name: 'System', stack: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
  helvetica: { name: 'Helvetica / Arial', stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  impact: { name: 'Impact', stack: 'Impact, "Arial Black", "Helvetica Neue", sans-serif' },
  arialblack: { name: 'Arial Black', stack: '"Arial Black", "Helvetica Neue", Arial, sans-serif' },
  georgia: { name: 'Georgia', stack: 'Georgia, "Times New Roman", serif' },
  times: { name: 'Times', stack: '"Times New Roman", Times, serif' },
  trebuchet: { name: 'Trebuchet', stack: '"Trebuchet MS", Verdana, sans-serif' },
  verdana: { name: 'Verdana', stack: 'Verdana, Geneva, sans-serif' },
  courier: { name: 'Courier (mono)', stack: '"Courier New", Courier, monospace' },
  mono: { name: 'Code mono', stack: 'ui-monospace, Menlo, Consolas, monospace' },
  brush: { name: 'Brush Script', stack: '"Brush Script MT", "Segoe Script", cursive' },
  rounded: { name: 'Rounded', stack: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", system-ui, sans-serif' },
};
export const SHAPES = { rect: 'Rectangle', ellipse: 'Ellipse', triangle: 'Triangle', star: 'Star', heart: 'Heart' };

const cache = new Map(); // `${clipId}:${kind}` → { key, canvas }

function cached(id, key, w, h, draw) {
  const e = cache.get(id);
  if (e && e.key === key) return e.canvas;
  const canvas = e?.canvas || document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  draw(ctx);
  cache.set(id, { key, canvas });
  return canvas;
}
export const dropCached = (id) => cache.delete(id);

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;

export function textFont(tx, k) {
  return `${tx.italic ? 'italic ' : ''}${tx.bold ? 700 : 400} ${Math.max(1, tx.size * k)}px ${(FONTS[tx.font] || FONTS.system).stack}`;
}

// Returns a canvas with the text block; box size is measured on the full text so typewriter does not jump.
export function textSource(c, W, H, chars = Infinity) {
  const tx = c.text, k = Math.min(W, H) / 1080;
  const key = JSON.stringify(tx) + `|${W}x${H}|${chars}`;
  const font = textFont(tx, k);
  measureCtx.font = font;
  const all = String(tx.content ?? '').split('\n');
  const size = tx.size * k, lh = size * (tx.lineHeight || 1.15);
  const maxW = Math.max(1, ...all.map((l) => measureCtx.measureText(l).width));
  const pad = tx.box ? tx.boxPad * k : 0;
  const stroke = tx.stroke ? tx.strokeWidth * k : 0;
  const margin = Math.ceil(stroke + (tx.shadow ? tx.shadowBlur * k * 1.5 + 4 * k : 0) + 2);
  const bw = maxW + pad * 2, bh = all.length * lh + pad * 2;
  const cw = bw + margin * 2, ch = bh + margin * 2;
  const canvas = cached(c.id + ':text', key, cw, ch, (ctx) => {
    if (tx.box) {
      ctx.globalAlpha = tx.boxOpacity;
      ctx.fillStyle = tx.boxColor;
      roundRect(ctx, margin, margin, bw, bh, pad * 0.6);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    let left = chars;
    const lines = all.map((l) => { const s = l.slice(0, Math.max(0, left)); left -= l.length + 1; return s; });
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.textAlign = tx.align;
    const x = tx.align === 'left' ? margin + pad : tx.align === 'right' ? cw - margin - pad : cw / 2;
    const passes = (fn) => lines.forEach((l, i) => l && fn(l, x, margin + pad + lh * (i + 0.5)));
    if (tx.shadow) {
      ctx.shadowColor = tx.shadowColor;
      ctx.shadowBlur = tx.shadowBlur * k;
      ctx.shadowOffsetY = 3 * k;
    }
    if (stroke) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = stroke * 2;
      ctx.strokeStyle = tx.strokeColor;
      passes((l, px, py) => ctx.strokeText(l, px, py));
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = tx.color;
    passes((l, px, py) => ctx.fillText(l, px, py));
  });
  return { img: canvas, w: canvas.width, h: canvas.height, native: true };
}

export function solidSource(c, W, H) {
  const f = c.fill;
  const canvas = cached(c.id + ':solid', JSON.stringify(f) + `|${W}x${H}`, W, H, (ctx) => {
    if (f.mode === 'solid') ctx.fillStyle = f.c1;
    else if (f.mode === 'radial') {
      const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W, H) / 2);
      g.addColorStop(0, f.c1); g.addColorStop(1, f.c2);
      ctx.fillStyle = g;
    } else {
      const a = (f.angle * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a);
      const len = (Math.abs(W * dx) + Math.abs(H * dy)) / 2;
      const g = ctx.createLinearGradient(W / 2 - dx * len, H / 2 - dy * len, W / 2 + dx * len, H / 2 + dy * len);
      g.addColorStop(0, f.c1); g.addColorStop(1, f.c2);
      ctx.fillStyle = g;
    }
    ctx.fillRect(0, 0, W, H);
  });
  return { img: canvas, w: W, h: H, native: true };
}

export function shapeSource(c, W, H) {
  const s = c.shape, k = Math.min(W, H);
  const w = Math.max(2, s.w * k), h = Math.max(2, s.h * k), sw = s.strokeWidth * (k / 1080);
  const m = Math.ceil(sw + 2);
  const canvas = cached(c.id + ':shape', JSON.stringify(s) + `|${W}x${H}`, w + m * 2, h + m * 2, (ctx) => {
    ctx.translate(m, m);
    ctx.beginPath();
    if (s.type === 'ellipse') ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (s.type === 'triangle') { ctx.moveTo(w / 2, 0); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); }
    else if (s.type === 'star') {
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 0.42 : 1;
        ctx.lineTo(w / 2 + Math.cos(a) * r * w / 2, h / 2 + Math.sin(a) * r * h / 2 + h * 0.05);
      }
      ctx.closePath();
    } else if (s.type === 'heart') {
      ctx.moveTo(w / 2, h * 0.28);
      ctx.bezierCurveTo(w / 2, 0, 0, 0, 0, h * 0.32);
      ctx.bezierCurveTo(0, h * 0.62, w * 0.35, h * 0.8, w / 2, h);
      ctx.bezierCurveTo(w * 0.65, h * 0.8, w, h * 0.62, w, h * 0.32);
      ctx.bezierCurveTo(w, 0, w / 2, 0, w / 2, h * 0.28);
      ctx.closePath();
    } else roundRect(ctx, 0, 0, w, h, (s.radius * Math.min(w, h)) / 2);
    ctx.fillStyle = s.fill;
    ctx.fill();
    if (sw > 0) { ctx.lineWidth = sw; ctx.strokeStyle = s.stroke; ctx.lineJoin = 'round'; ctx.stroke(); }
  });
  return { img: canvas, w: canvas.width, h: canvas.height, native: true };
}
