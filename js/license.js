// Offline Pro licensing. Keys look like FC1.<base64url payload>.<base64url ECDSA P-256 signature>
// and are produced by tools/license.mjs. Verification needs no server.
import { CONFIG } from './config.js';

const STORE = 'fc.license';
const listeners = new Set();
let state = null; // { email, expires (ms, 0 = lifetime) } when Pro

const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function check(key) {
  const [ver, body, sig] = String(key).trim().split('.');
  if (ver !== 'FC1' || !body || !sig) return { ok: false, error: 'That is not a FrameCraft key.' };
  try {
    const pub = await crypto.subtle.importKey('jwk', CONFIG.publicKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64u(sig), new TextEncoder().encode(body));
    if (!valid) return { ok: false, error: 'Key signature is invalid.' };
    const p = JSON.parse(new TextDecoder().decode(fromB64u(body)));
    if (p.p !== 'pro') return { ok: false, error: 'Key is not a Pro key.' };
    if (p.x && p.x < Date.now()) return { ok: false, error: `Key expired on ${new Date(p.x).toLocaleDateString()}. Renew to keep Pro.` };
    return { ok: true, info: { email: p.e, expires: p.x || 0 } };
  } catch {
    return { ok: false, error: 'Key is damaged. Copy the whole key and try again.' };
  }
}

function emit() { listeners.forEach((cb) => cb(state)); }

export const License = {
  async init() {
    const saved = localStorage.getItem(STORE);
    if (saved) {
      const r = await check(saved);
      state = r.ok ? r.info : null;
      if (!r.ok) localStorage.removeItem(STORE);
    }
    emit();
  },
  isPro: () => !!state,
  info: () => state,
  async activate(key) {
    const r = await check(key);
    if (r.ok) { localStorage.setItem(STORE, key.trim()); state = r.info; emit(); }
    return r;
  },
  deactivate() { localStorage.removeItem(STORE); state = null; emit(); },
  onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
};

// Returns true when Pro; otherwise opens the upgrade dialog and returns false.
export function requirePro(feature) {
  if (state) return true;
  window.dispatchEvent(new CustomEvent('fc:upgrade', { detail: { feature } }));
  return false;
}

// Free-tier export watermark, bottom-right.
export function drawWatermark(ctx, w, h) {
  if (state) return;
  const size = Math.max(14, Math.round(Math.min(w, h) * 0.035));
  ctx.save();
  ctx.font = `700 ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  const text = `Made with ${CONFIG.appName}`;
  const pad = size * 0.8;
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = '#000';
  ctx.fillText(text, w - pad + 2, h - pad + 2);
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = '#fff';
  ctx.fillText(text, w - pad, h - pad);
  ctx.restore();
}
