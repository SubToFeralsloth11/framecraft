// Pure timeline model and math for the video editor. No DOM access, so it can be tested in node.
// Times are seconds. A clip occupies [start, start + duration) on its track and reads its source
// from `in` at `speed`x. `srcDur` is the source length for video/audio (null = unlimited).

export const FPS = 30;
export const EPS = 1e-4;
export const MIN_DUR = 1 / FPS;

let seq = 0;
export const uid = (p = 'c') => p + Date.now().toString(36).slice(-6) + (seq++).toString(36) + Math.random().toString(36).slice(2, 5);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const clone = (o) => JSON.parse(JSON.stringify(o));

export const ASPECTS = { '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1], '4:5': [4, 5] };

// Output size for an aspect where `short` is the length of the short side (1080 → 1920x1080 / 1080x1920).
export function frameSize(aspect, short) {
  const [a, b] = ASPECTS[aspect] || ASPECTS['16:9'];
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  return a >= b ? { w: even((short * a) / b), h: even(short) } : { w: even(short), h: even((short * b) / a) };
}

export const COLOR_DEFAULT = { brightness: 100, contrast: 100, saturation: 100, hue: 0, temperature: 0, blur: 0, vignette: 0 };
export const TEXT_DEFAULT = {
  content: 'Your title', font: 'system', size: 96, color: '#ffffff', bold: true, italic: false, align: 'center', lineHeight: 1.15,
  stroke: false, strokeColor: '#000000', strokeWidth: 4,
  shadow: true, shadowColor: '#000000', shadowBlur: 14,
  box: false, boxColor: '#000000', boxOpacity: 0.6, boxPad: 24,
  anim: 'fade', animDur: 0.6,
};
export const KEY_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity'];
export const TRANSITIONS = { crossfade: 'Crossfade', dip: 'Dip to black', wipe: 'Wipe', slide: 'Slide', zoom: 'Zoom' };
export const TEXT_ANIMS = { none: 'None', fade: 'Fade in', slideUp: 'Slide up', typewriter: 'Typewriter', pop: 'Pop' };

const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function createClip(kind, props = {}) {
  const c = {
    id: uid(), kind, trackId: null, mediaId: null, srcDur: null, name: kind, start: 0, duration: 5, in: 0, speed: 1,
    x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1,
    crop: { l: 0, t: 0, r: 0, b: 0 }, blend: 'source-over',
    volume: 1, muted: false, fadeIn: 0, fadeOut: 0,
    color: { ...COLOR_DEFAULT }, look: 'none', effects: [],
    chroma: { on: false, color: '#00ff00', tol: 35, soft: 15 },
    keyframes: {}, keyEase: 'linear', trans: null,
  };
  if (kind === 'text') c.text = { ...TEXT_DEFAULT };
  if (kind === 'solid') c.fill = { mode: 'linear', c1: '#1d2b64', c2: '#6c3cff', angle: 135 };
  if (kind === 'shape') c.shape = { type: 'rect', fill: '#6c8cff', stroke: '#ffffff', strokeWidth: 0, w: 0.4, h: 0.25, radius: 0.15 };
  for (const [k, v] of Object.entries(props)) c[k] = isPlain(v) && isPlain(c[k]) ? { ...c[k], ...v } : v;
  return c;
}

export function newProject() {
  return {
    version: 1, aspect: '16:9',
    tracks: [
      { id: uid('t'), kind: 'video', muted: false, hidden: false },
      { id: uid('t'), kind: 'video', muted: false, hidden: false },
      { id: uid('t'), kind: 'audio', muted: false, hidden: false },
    ],
    clips: [],
  };
}

// ---------- basic queries ----------
export const clipEnd = (c) => c.start + c.duration;
export const sourceTime = (c, t) => c.in + (t - c.start) * c.speed;
export const srcLimit = (c) => (c.srcDur == null ? Infinity : c.srcDur);
export const trackOf = (p, c) => p.tracks.find((t) => t.id === c.trackId);
export const canHold = (track, c) => (track.kind === 'video' ? c.kind !== 'audio' : c.kind === 'audio' || c.kind === 'video');
export const trackClips = (p, trackId) => p.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
export const projectDuration = (p) => p.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
export const videoTracks = (p) => p.tracks.filter((t) => t.kind === 'video'); // bottom → top
export const audioTracks = (p) => p.tracks.filter((t) => t.kind === 'audio');
// Timeline display order: highest video track first, then audio tracks.
export const displayTracks = (p) => [...videoTracks(p).reverse(), ...audioTracks(p)];
export function trackLabel(p, tr) {
  const same = p.tracks.filter((t) => t.kind === tr.kind);
  return (tr.kind === 'video' ? 'V' : 'A') + (same.indexOf(tr) + 1);
}

export function isFree(p, trackId, s, e, except = new Set()) {
  return !p.clips.some((c) => c.trackId === trackId && !except.has(c.id) && c.start < e - EPS && clipEnd(c) > s + EPS);
}

// Earliest time >= from where a clip of `dur` fits on the track without overlapping.
export function findFreeSpot(p, trackId, from, dur, except = new Set()) {
  let t = Math.max(0, from);
  for (const c of trackClips(p, trackId)) {
    if (except.has(c.id) || clipEnd(c) <= t + EPS) continue;
    if (c.start >= t + dur - EPS) break;
    t = clipEnd(c);
  }
  return t;
}

// ---------- keyframes ----------
export const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

// Property value at clip-local time lt (seconds since clip start), honouring keyframes.
export function propAt(c, prop, lt) {
  const ks = c.keyframes?.[prop];
  if (!ks || !ks.length) return c[prop];
  if (lt <= ks[0].t) return ks[0].v;
  const last = ks[ks.length - 1];
  if (lt >= last.t) return last.v;
  let i = 0;
  while (i < ks.length - 2 && ks[i + 1].t <= lt) i++;
  const a = ks[i], b = ks[i + 1];
  let u = (lt - a.t) / (b.t - a.t || 1);
  if (a.ease === 'ease') u = easeInOut(u);
  return a.v + (b.v - a.v) * u;
}

const KEY_TOL = 0.5 / FPS;
export const keyIndex = (c, prop, lt) => (c.keyframes?.[prop] || []).findIndex((k) => Math.abs(k.t - lt) < KEY_TOL);

export function setKey(c, prop, lt, v, ease = c.keyEase || 'linear') {
  c.keyframes ||= {};
  const ks = (c.keyframes[prop] ||= []);
  const i = keyIndex(c, prop, lt);
  if (i >= 0) ks[i].v = v;
  else { ks.push({ t: lt, v, ease }); ks.sort((a, b) => a.t - b.t); }
}

export function removeKey(c, prop, lt) {
  const i = keyIndex(c, prop, lt);
  if (i < 0) return false;
  const ks = c.keyframes[prop];
  if (ks.length === 1) c[prop] = ks[0].v; // keep the last value as the static value
  ks.splice(i, 1);
  if (!ks.length) delete c.keyframes[prop];
  return true;
}

export function shiftKeyframes(c, dt) {
  for (const ks of Object.values(c.keyframes || {})) for (const k of ks) k.t += dt;
}

// ---------- fades / text animation ----------
export function fadeAt(c, t) {
  let f = 1;
  if (c.fadeIn > 0) f = Math.min(f, (t - c.start) / c.fadeIn);
  if (c.fadeOut > 0) f = Math.min(f, (clipEnd(c) - t) / c.fadeOut);
  return clamp(f, 0, 1);
}

const backOut = (u) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2); };

// Entrance animation state: alpha multiplier, dy (fraction of frame height), scale, visible chars.
export function textAnimAt(c, t) {
  const tx = c.text || {};
  const u = clamp((t - c.start) / Math.max(0.05, tx.animDur || 0.6), 0, 1);
  const out = (1 - Math.pow(1 - u, 3));
  switch (tx.anim) {
    case 'fade': return { alpha: out, dy: 0, scale: 1, chars: Infinity };
    case 'slideUp': return { alpha: out, dy: (1 - out) * 0.08, scale: 1, chars: Infinity };
    case 'typewriter': return { alpha: 1, dy: 0, scale: 1, chars: Math.floor(u * (tx.content || '').length + 1e-9) };
    case 'pop': return { alpha: Math.min(1, u * 4), dy: 0, scale: Math.max(0, backOut(u)), chars: Infinity };
    default: return { alpha: 1, dy: 0, scale: 1, chars: Infinity };
  }
}

// ---------- edits (all mutate) ----------
export function trimStart(c, newStart, minStart = 0) {
  const end = clipEnd(c);
  let s = Math.max(newStart, minStart, 0);
  if (c.srcDur != null) s = Math.max(s, c.start - c.in / c.speed);
  s = Math.min(s, end - MIN_DUR);
  const d = s - c.start;
  if (c.srcDur != null) c.in = Math.max(0, c.in + d * c.speed);
  c.start = s;
  c.duration = end - s;
  shiftKeyframes(c, -d);
  return c;
}

export function trimEnd(c, newEnd, maxEnd = Infinity) {
  let e = Math.min(newEnd, maxEnd);
  if (c.srcDur != null) e = Math.min(e, c.start + (c.srcDur - c.in) / c.speed);
  e = Math.max(e, c.start + MIN_DUR);
  c.duration = e - c.start;
  return c;
}

// Splits c at timeline time t. c becomes the left part; returns the new right part (not added), or null.
export function splitClip(c, t) {
  if (t - c.start < MIN_DUR - EPS || clipEnd(c) - t < MIN_DUR - EPS) return null;
  const d = t - c.start;
  const right = clone(c);
  right.id = uid();
  right.start = t;
  right.duration = clipEnd(c) - t;
  if (c.srcDur != null) right.in = c.in + d * c.speed;
  shiftKeyframes(right, -d);
  right.trans = null;
  right.fadeIn = 0;
  if (right.text) right.text.anim = 'none';
  c.duration = d;
  c.fadeOut = 0;
  return right;
}

// Clears [s, e) on a track (Premiere-style overwrite): removes, trims or splits clips in the way.
export function overwriteRange(p, trackId, s, e, except = new Set()) {
  for (const c of [...p.clips]) {
    if (c.trackId !== trackId || except.has(c.id)) continue;
    const ce = clipEnd(c);
    if (ce <= s + EPS || c.start >= e - EPS) continue;
    const keepLeft = s - c.start >= MIN_DUR, keepRight = ce - e >= MIN_DUR;
    if (!keepLeft && !keepRight) { p.clips.splice(p.clips.indexOf(c), 1); continue; }
    if (keepLeft && keepRight) {
      const right = splitClip(c, e);
      if (right) p.clips.push(right);
      trimEnd(c, s);
    } else if (keepLeft) trimEnd(c, s);
    else { trimStart(c, e); c.trans = null; c.fadeIn = 0; }
  }
}

// Inserts clips (already positioned) overwriting whatever is under them.
export function insertClips(p, clips) {
  const ids = new Set(clips.map((c) => c.id));
  for (const c of clips) overwriteRange(p, c.trackId, c.start, clipEnd(c), ids);
  p.clips.push(...clips);
}

// moves: [{ id, start, trackId }]
export function moveClips(p, moves) {
  const ids = new Set(moves.map((m) => m.id));
  const moved = [];
  for (const m of moves) {
    const c = p.clips.find((x) => x.id === m.id);
    if (!c) continue;
    c.start = Math.max(0, m.start);
    c.trackId = m.trackId;
    moved.push(c);
  }
  for (const c of moved) overwriteRange(p, c.trackId, c.start, clipEnd(c), ids);
}

export function deleteClips(p, ids) {
  p.clips = p.clips.filter((c) => !ids.has(c.id));
}

// Removes clips and closes the gap they leave on their track.
export function rippleDelete(p, ids) {
  const del = p.clips.filter((c) => ids.has(c.id)).sort((a, b) => b.start - a.start);
  for (const c of del) {
    p.clips.splice(p.clips.indexOf(c), 1);
    for (const o of p.clips) if (o.trackId === c.trackId && o.start >= clipEnd(c) - EPS) o.start = Math.max(0, o.start - c.duration);
  }
}

// Splits every clip (or only `ids`) under the playhead. Returns the new right parts.
export function splitAt(p, t, ids = null) {
  const out = [];
  for (const c of [...p.clips]) {
    if (ids && !ids.has(c.id)) continue;
    if (t <= c.start + EPS || t >= clipEnd(c) - EPS) continue;
    const r = splitClip(c, t);
    if (r) { p.clips.push(r); out.push(r); }
  }
  return out;
}

// Changes playback speed keeping the same source span; never grows into the next clip.
export function setSpeed(p, c, speed) {
  const span = c.duration * c.speed;
  c.speed = clamp(speed, 0.25, 4);
  let dur = span / c.speed;
  const next = trackClips(p, c.trackId).find((o) => o !== c && o.start >= clipEnd(c) - EPS);
  if (next) dur = Math.min(dur, next.start - c.start);
  c.duration = Math.max(MIN_DUR, dur);
  trimEnd(c, clipEnd(c));
}

// ---------- transitions ----------
export const prevAdjacent = (p, c) => p.clips.find((o) => o !== c && o.trackId === c.trackId && Math.abs(clipEnd(o) - c.start) < 1e-3) || null;
export const nextAdjacent = (p, c) => p.clips.find((o) => o !== c && o.trackId === c.trackId && Math.abs(o.start - clipEnd(c)) < 1e-3) || null;
// Transition on b (from a) is centred on the cut; each half never exceeds half of either clip.
export const transDur = (a, b) => Math.max(0, Math.min(b.trans?.dur || 0, a.duration, b.duration));

// What a track shows at time t: { clip } or { a, b, type, p, dur } during a transition, or null.
export function trackStateAt(p, trackId, t) {
  const cl = trackClips(p, trackId);
  for (let i = 1; i < cl.length; i++) {
    const b = cl[i], a = cl[i - 1];
    if (!b.trans || Math.abs(clipEnd(a) - b.start) >= 1e-3) continue;
    const d = transDur(a, b);
    if (d > 0 && t >= b.start - d / 2 && t < b.start + d / 2) return { a, b, type: b.trans.type, p: (t - (b.start - d / 2)) / d, dur: d };
  }
  const c = cl.find((x) => t >= x.start && t < clipEnd(x));
  return c ? { clip: c } : null;
}

// Removes stale transitions and clamps values after edits.
export function normalize(p) {
  const trackIds = new Set(p.tracks.map((t) => t.id));
  p.clips = p.clips.filter((c) => trackIds.has(c.trackId) && c.duration > EPS);
  for (const c of p.clips) {
    if (c.trans && !prevAdjacent(p, c)) c.trans = null;
    c.fadeIn = clamp(c.fadeIn || 0, 0, c.duration);
    c.fadeOut = clamp(c.fadeOut || 0, 0, c.duration);
  }
  return p;
}

// ---------- misc ----------
export function snapTime(t, targets, threshold) {
  let best = t, bd = threshold;
  for (const x of targets) { const d = Math.abs(x - t); if (d < bd) { bd = d; best = x; } }
  return best;
}

const pad2 = (n) => String(n).padStart(2, '0');
export function timecode(t) {
  const f = Math.floor(Math.max(0, t) * FPS + 1e-6);
  const s = Math.floor(f / FPS), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h ? pad2(h) + ':' : ''}${pad2(m)}:${pad2(s % 60)}:${pad2(f % FPS)}`;
}
export const frameRound = (t) => Math.round(t * FPS) / FPS;
