// Frame compositor: draws every video track bottom-up for a timeline time, including transforms,
// keyframes, fades, crop, blend modes, colour grading, effects, chroma key and transitions.
import { propAt, fadeAt, textAnimAt, trackStateAt, videoTracks, clamp } from './model.js';
import { gradeOf, cssString, processPixels, CSS_FILTER } from './looks.js';
import { textSource, solidSource, shapeSource } from './gen.js';

const NONE = {};

export class Compositor {
  // mediaSource(clip) → { img, w, h } when a frame is ready, null when loading, 'offline' when missing.
  constructor(mediaSource) {
    this.mediaSource = mediaSource;
    this.layer = document.createElement('canvas');
    this.lctx = this.layer.getContext('2d', { willReadFrequently: true });
    this.small = document.createElement('canvas');
  }

  source(c, t, W, H) {
    if (c.kind === 'text') return textSource(c, W, H, textAnimAt(c, t).chars);
    if (c.kind === 'solid') return solidSource(c, W, H);
    if (c.kind === 'shape') return shapeSource(c, W, H);
    return this.mediaSource(c);
  }

  // Where a clip lands in the frame (also used for hit testing and the selection box).
  geometry(c, t, W, H, src) {
    const lt = t - c.start;
    let scale = propAt(c, 'scale', lt), alpha = propAt(c, 'opacity', lt) * fadeAt(c, t);
    const px = propAt(c, 'x', lt) * W;
    let py = propAt(c, 'y', lt) * H;
    if (c.kind === 'text') { const a = textAnimAt(c, t); alpha *= a.alpha; scale *= a.scale; py += a.dy * H; }
    const sw = src?.w || W, sh = src?.h || H;
    const fit = src?.native ? 1 : Math.min(W / sw, H / sh);
    const fw = sw * fit * scale, fh = sh * fit * scale, cr = c.crop;
    return {
      px, py, rot: (propAt(c, 'rotation', lt) * Math.PI) / 180, alpha: clamp(alpha, 0, 1),
      dx: -fw / 2 + cr.l * fw, dy: -fh / 2 + cr.t * fh, dw: fw * (1 - cr.l - cr.r), dh: fh * (1 - cr.t - cr.b),
      sx: cr.l * sw, sy: cr.t * sh, sw: sw * (1 - cr.l - cr.r), sh: sh * (1 - cr.t - cr.b),
    };
  }

  render(ctx, W, H, t, p) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (CSS_FILTER) ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    for (const tr of videoTracks(p)) {
      if (tr.hidden) continue;
      const st = trackStateAt(p, tr.id, t);
      if (!st) continue;
      if (st.clip) this.drawClip(ctx, W, H, st.clip, t);
      else this.drawTransition(ctx, W, H, st, t);
    }
    ctx.restore();
  }

  drawTransition(ctx, W, H, { a, b, type, p }, t) {
    const ta = Math.min(t, a.start + a.duration - 1e-3), tb = Math.max(t, b.start); // hold edge frames
    switch (type) {
      case 'dip':
        if (p < 0.5) this.drawClip(ctx, W, H, a, ta);
        else this.drawClip(ctx, W, H, b, tb);
        ctx.save();
        ctx.globalAlpha = p < 0.5 ? p * 2 : (1 - p) * 2;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
        break;
      case 'wipe':
        this.drawClip(ctx, W, H, a, ta);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, W * p, H);
        ctx.clip();
        this.drawClip(ctx, W, H, b, tb);
        ctx.restore();
        break;
      case 'slide': {
        const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        this.drawClip(ctx, W, H, a, ta, { dx: -e * W });
        this.drawClip(ctx, W, H, b, tb, { dx: (1 - e) * W });
        break;
      }
      case 'zoom':
        this.drawClip(ctx, W, H, a, ta, { zoom: 1 + p * 0.6, alpha: 1 - p });
        this.drawClip(ctx, W, H, b, tb, { zoom: 0.7 + 0.3 * p, alpha: p });
        break;
      default: // crossfade
        this.drawClip(ctx, W, H, a, ta);
        this.drawClip(ctx, W, H, b, tb, { alpha: p });
    }
  }

  drawClip(ctx, W, H, c, t, x = NONE) {
    const src = this.source(c, t, W, H);
    if (!src) return;
    if (src === 'offline') return this.drawOffline(ctx, W, H, c);
    const g0 = this.geometry(c, t, W, H, src);
    const alpha = g0.alpha * (x.alpha ?? 1);
    if (alpha <= 0.002 || g0.sw < 1 || g0.sh < 1 || g0.dw < 0.5 || g0.dh < 0.5) return;
    const k = Math.min(W, H) / 1080;
    const g = gradeOf(c);
    let img = src.img, sx = g0.sx, sy = g0.sy, sw = g0.sw, sh = g0.sh, smooth = true;
    if (g.needsLayer) {
      const maxSide = Math.max(W, H);
      let f = Math.min(1, maxSide / Math.max(g0.dw, g0.dh));
      if (g.pixelate) { f = 1 / (g.pixelate * k); smooth = false; }
      else if (!CSS_FILTER && g.css.blur > 0) f /= 1 + (g.css.blur * k) / 3; // blur fallback: down/up-sample
      const lw = Math.max(1, Math.round(g0.dw * f)), lh = Math.max(1, Math.round(g0.dh * f));
      const L = this.layer, lc = this.lctx;
      if (L.width !== lw || L.height !== lh) { L.width = lw; L.height = lh; } else lc.clearRect(0, 0, lw, lh);
      lc.imageSmoothingEnabled = true;
      lc.drawImage(img, sx, sy, sw, sh, 0, 0, lw, lh);
      if (g.pixel) {
        const id = lc.getImageData(0, 0, lw, lh);
        processPixels(id.data, g.pixel);
        lc.putImageData(id, 0, 0);
      }
      if (g.vignette > 0) {
        const grad = lc.createRadialGradient(lw / 2, lh / 2, Math.min(lw, lh) * 0.25, lw / 2, lh / 2, Math.hypot(lw, lh) / 2);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, `rgba(0,0,0,${Math.min(1, g.vignette * 1.1)})`);
        lc.globalCompositeOperation = 'source-atop';
        lc.fillStyle = grad;
        lc.fillRect(0, 0, lw, lh);
        lc.globalCompositeOperation = 'source-over';
      }
      img = L; sx = 0; sy = 0; sw = lw; sh = lh;
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = c.blend || 'source-over';
    const filter = CSS_FILTER ? cssString(g.css, k) : 'none';
    if (CSS_FILTER) ctx.filter = filter;
    ctx.imageSmoothingEnabled = smooth;
    ctx.imageSmoothingQuality = 'high';
    if (x.dx || x.zoom) {
      ctx.translate(W / 2 + (x.dx || 0), H / 2);
      ctx.scale(x.zoom || 1, x.zoom || 1);
      ctx.translate(-W / 2, -H / 2);
    }
    ctx.translate(g0.px, g0.py);
    ctx.rotate(g0.rot);
    if (g.mirror) ctx.scale(-1, 1);
    ctx.drawImage(img, sx, sy, sw, sh, g0.dx, g0.dy, g0.dw, g0.dh);
    if (g.glow) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha * g.glow * 0.8;
      if (CSS_FILTER) ctx.filter = (filter === 'none' ? '' : filter + ' ') + `blur(${(18 * k).toFixed(1)}px)`;
      ctx.drawImage(img, sx, sy, sw, sh, g0.dx, g0.dy, g0.dw, g0.dh);
    }
    ctx.restore();
  }

  drawOffline(ctx, W, H, c) {
    ctx.save();
    ctx.fillStyle = '#4a1d24';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ffb3bd';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.round(Math.min(W, H) * 0.045)}px system-ui, sans-serif`;
    ctx.fillText('Media offline', W / 2, H / 2 - Math.min(W, H) * 0.03);
    ctx.font = `${Math.round(Math.min(W, H) * 0.03)}px system-ui, sans-serif`;
    ctx.fillText(c.name || '', W / 2, H / 2 + Math.min(W, H) * 0.035);
    ctx.restore();
  }

  // Corner points of the clip's box in frame pixels (for selection outline / hit tests).
  corners(c, t, W, H) {
    const src = this.source(c, t, W, H);
    const g = this.geometry(c, t, W, H, src && src !== 'offline' ? src : null);
    const cos = Math.cos(g.rot), sin = Math.sin(g.rot);
    return [[g.dx, g.dy], [g.dx + g.dw, g.dy], [g.dx + g.dw, g.dy + g.dh], [g.dx, g.dy + g.dh]]
      .map(([x, y]) => [g.px + x * cos - y * sin, g.py + x * sin + y * cos]);
  }
}

export function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
