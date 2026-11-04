// Playback engine: timeline clock, one hidden media element per media clip (lazily woken / put to
// sleep), Web Audio mixing (element → gain → master), and frame rendering to the preview or to an
// export canvas.
import { FPS, clamp, clipEnd, fadeAt, projectDuration, sourceTime, trackStateAt, videoTracks, audioTracks, trackClips } from './model.js';
import { Compositor } from './render.js';
import { drawWatermark } from '../license.js';

const LOOKAHEAD = 2.5; // seconds: prepare elements of upcoming clips
const SLEEP_DIST = 8; // seconds away from the playhead before an element releases its decoder

export class Engine {
  constructor({ store, media, canvas, host }) {
    this.store = store;
    this.media = media;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.host = host; // hidden container for media elements
    this.t = 0;
    this.playing = false;
    this.rate = 1;
    this.pool = new Map(); // clipId → { el, mediaId, node, gain, asleep }
    this.comp = new Compositor((c) => this.mediaSource(c));
    this.listeners = new Set();
    this.actx = null;
    this.master = null;
    this.raf = 0;
    this.last = 0;
    this.job = null; // export job
    this.overlay = null; // (ctx, W, H, t) → void, preview-only decorations
    this.tick = this.tick.bind(this);
  }

  on(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  emit(type) { this.listeners.forEach((cb) => cb(type, this)); }
  duration() { return projectDuration(this.store.p); }

  // ---------- audio ----------
  ensureAudio() {
    if (!this.actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.actx = new AC();
      this.master = this.actx.createGain();
      this.master.connect(this.actx.destination);
      for (const e of this.pool.values()) this.connect(e);
    }
    if (this.actx.state !== 'running') this.actx.resume().catch(() => {});
    return this.actx;
  }

  // Called from a user gesture (iOS needs the context created/resumed inside one). Also plays one
  // silent buffer, which is what finally unlocks Web Audio output on iOS Safari.
  unlockAudio() {
    const actx = this.ensureAudio();
    if (!this.unlocked) {
      this.unlocked = true;
      const src = actx.createBufferSource();
      src.buffer = actx.createBuffer(1, 1, 22050);
      src.connect(actx.destination);
      src.start(0);
    }
    for (const e of this.pool.values()) if (e.node && e.el.muted) e.el.muted = false;
  }

  connect(e) {
    if (!this.actx || e.node) return;
    e.node = this.actx.createMediaElementSource(e.el);
    e.gain = this.actx.createGain();
    e.gain.gain.value = 0;
    e.node.connect(e.gain).connect(this.master);
    e.el.muted = false;
  }

  // Smoothly moves a clip's gain; skips scheduling when the value has not changed.
  setGain(e, g, now = false) {
    if (!e.gain || e.lastGain === g) return;
    e.lastGain = g;
    const p = e.gain.gain, t = this.actx.currentTime;
    p.cancelScheduledValues(t);
    if (now) p.setValueAtTime(g, t);
    else p.setTargetAtTime(g, t, 0.012);
  }

  // Taps the master mix into a MediaStream (for export). Returns { stream, stop }.
  audioStream() {
    const actx = this.ensureAudio();
    const dest = actx.createMediaStreamDestination();
    this.master.connect(dest);
    return { stream: dest.stream, stop: () => { try { this.master.disconnect(dest); } catch { /* already gone */ } } };
  }

  // ---------- media elements ----------
  mediaSource(c) {
    const m = this.media.get(c.mediaId);
    if (!m) return 'offline';
    if (m.kind === 'image') return m.img ? { img: m.img, w: m.width, h: m.height } : null;
    const e = this.pool.get(c.id);
    if (!e || e.asleep || e.el.readyState < 2 || !e.el.videoWidth) return null;
    return { img: e.el, w: e.el.videoWidth, h: e.el.videoHeight };
  }

  ensureEl(c) {
    const m = this.media.get(c.mediaId);
    if (!m || m.kind === 'image') return null;
    let e = this.pool.get(c.id);
    if (e && e.mediaId !== c.mediaId) { this.dropEl(c.id); e = null; }
    if (!e) {
      const el = document.createElement(m.kind === 'video' ? 'video' : 'audio');
      el.preload = 'auto';
      el.playsInline = true;
      el.setAttribute('playsinline', '');
      el.setAttribute('webkit-playsinline', '');
      el.muted = true; // muted until routed through Web Audio (gain starts at 0), so iOS lets it play
      el.defaultMuted = true;
      const redraw = () => { if (!this.playing) this.invalidate(); };
      el.addEventListener('seeked', redraw);
      el.addEventListener('loadeddata', redraw);
      this.host.append(el);
      e = { el, mediaId: c.mediaId, node: null, gain: null, asleep: true };
      this.pool.set(c.id, e);
      this.connect(e);
    }
    if (e.asleep) { e.el.src = m.url; e.asleep = false; }
    return e;
  }

  sleepEl(e) {
    if (e.asleep) return;
    e.el.pause();
    e.el.removeAttribute('src');
    e.el.load();
    e.asleep = true;
  }

  dropEl(id) {
    const e = this.pool.get(id);
    if (!e) return;
    this.sleepEl(e);
    try { e.node?.disconnect(); e.gain?.disconnect(); } catch { /* ignore */ }
    e.el.remove();
    this.pool.delete(id);
  }

  // Media that must be active at time t: Map clipId → { c, tt (clamped time), gain multiplier, track }.
  needed(t) {
    const p = this.store.p, out = new Map();
    const want = (c, tt, mul, tr) => { if (c.mediaId && this.media.get(c.mediaId)?.kind !== 'image') out.set(c.id, { c, tt, mul, tr }); };
    for (const tr of videoTracks(p)) {
      const st = trackStateAt(p, tr.id, t);
      if (!st) continue;
      if (st.clip) want(st.clip, t, 1, tr);
      else {
        want(st.a, Math.min(t, clipEnd(st.a) - 1e-3), Math.max(0, 1 - 2 * st.p), tr);
        want(st.b, Math.max(t, st.b.start), Math.max(0, 2 * st.p - 1), tr);
      }
    }
    for (const tr of audioTracks(p)) {
      const c = trackClips(p, tr.id).find((x) => t >= x.start && t < clipEnd(x));
      if (c) want(c, t, 1, tr);
    }
    return out;
  }

  sync() {
    const p = this.store.p, t = this.t;
    const live = this.playing && this.rate > 0;
    const need = this.needed(t);
    const ids = new Set(p.clips.map((c) => c.id));
    for (const [id, e] of this.pool) {
      if (!ids.has(id)) { this.dropEl(id); continue; }
      if (need.has(id)) continue;
      if (!e.el.paused) e.el.pause();
      this.setGain(e, 0, true);
      const c = p.clips.find((x) => x.id === id);
      const upcoming = c.start > t && c.start - t <= LOOKAHEAD;
      if (upcoming && !e.asleep && !e.el.seeking && Math.abs(e.el.currentTime - c.in) > 0.05) e.el.currentTime = c.in;
      if (!upcoming && (c.start - t > SLEEP_DIST || t - clipEnd(c) > SLEEP_DIST)) this.sleepEl(e);
    }
    // Wake upcoming clips early so they start without a hitch.
    for (const c of p.clips) {
      if (c.start > t && c.start - t <= LOOKAHEAD && c.mediaId && !need.has(c.id) && this.media.get(c.mediaId)?.kind !== 'image' && !this.pool.get(c.id)?.el.src) {
        const e = this.ensureEl(c);
        if (e) e.el.currentTime = c.in;
      }
    }
    for (const { c, tt, mul, tr } of need.values()) {
      const e = this.ensureEl(c);
      if (!e) continue;
      const el = e.el;
      const end = Math.min(c.in + c.duration * c.speed, c.srcDur ?? Infinity) - 0.5 / FPS;
      const srcT = clamp(sourceTime(c, tt), c.in, Math.max(c.in, end));
      const running = live && tt === t;
      if (running) {
        const rate = clamp(c.speed * this.rate, 0.0625, 16);
        if (Math.abs(el.playbackRate - rate) > 1e-3) el.playbackRate = rate;
        if (el.paused) {
          if (Math.abs(el.currentTime - srcT) > 0.05) el.currentTime = srcT;
          el.play().catch((err) => {
            // Autoplay policy refused unmuted playback (no audio unlock yet): keep the picture going muted.
            if (err?.name === 'NotAllowedError' && !el.muted) { el.muted = true; el.play().catch(() => {}); }
          });
        } else if (!el.seeking && Math.abs(el.currentTime - srcT) > 0.3) el.currentTime = srcT;
      } else {
        if (!el.paused) el.pause();
        if (!el.seeking && Math.abs(el.currentTime - srcT) > 0.5 / FPS) el.currentTime = srcT;
      }
      if (e.gain) this.setGain(e, running && !c.muted && !tr.muted ? c.volume * fadeAt(c, t) * mul : 0);
    }
  }

  // ---------- clock ----------
  invalidate() { if (!this.raf) this.raf = requestAnimationFrame(this.tick); }

  tick(now) {
    this.raf = 0;
    if (this.playing) {
      const dt = Math.max(0, (now - this.last) / 1000);
      this.last = now;
      this.t += dt * this.rate;
      const end = this.job ? this.job.end : this.duration();
      if (this.t >= end && this.rate > 0) {
        this.t = end;
        if (this.job) { const j = this.job; this.job = null; this.pause(); j.onDone?.(); return; }
        this.pause();
      } else if (this.t <= 0 && this.rate < 0) { this.t = 0; this.pause(); }
    }
    this.sync();
    this.draw();
    this.emit('time');
    if (this.playing) this.raf = requestAnimationFrame(this.tick);
  }

  draw() {
    const p = this.store.p, W = this.canvas.width, H = this.canvas.height;
    const j = this.job;
    if (j?.canvas) {
      this.comp.render(j.ctx, j.W, j.H, this.t, p);
      drawWatermark(j.ctx, j.W, j.H);
      this.ctx.drawImage(j.canvas, 0, 0, W, H);
    } else {
      this.comp.render(this.ctx, W, H, this.t, p);
      this.overlay?.(this.ctx, W, H, this.t);
    }
    j?.onFrame?.(this.t);
  }

  // Renders a still frame at any size once all needed media has seeked (for PNG export).
  async renderStill(ctx, W, H) {
    this.sync();
    await this.settle();
    this.comp.render(ctx, W, H, this.t, this.store.p);
  }

  settle(timeout = 4000) {
    const t0 = performance.now();
    return new Promise((resolve) => {
      const check = () => {
        const busy = [...this.needed(this.t).keys()].some((id) => {
          const e = this.pool.get(id);
          return e && !e.asleep && (e.el.seeking || e.el.readyState < 2);
        });
        if (!busy || performance.now() - t0 > timeout) resolve();
        else setTimeout(check, 30);
      };
      check();
    });
  }

  play(rate = 1) {
    this.ensureAudio();
    if (!this.playing && rate > 0 && this.t >= this.duration() - 1e-3) this.t = 0;
    this.rate = rate;
    if (!this.playing) { this.playing = true; this.last = performance.now(); }
    this.invalidate();
    this.emit('state');
  }

  pause() {
    if (!this.playing && this.rate === 1) return;
    this.playing = false;
    this.rate = 1;
    for (const e of this.pool.values()) { e.el.pause(); this.setGain(e, 0, true); }
    this.invalidate();
    this.emit('state');
  }

  toggle() { if (this.playing) this.pause(); else this.play(); }

  // J / K / L shuttle.
  shuttle(dir) {
    if (dir === 0) return this.pause();
    if (dir > 0) this.play(this.playing && this.rate > 0 ? Math.min(4, this.rate * 2) : 1);
    else this.play(this.playing && this.rate < 0 ? Math.max(-4, this.rate * 2) : -1);
  }

  seek(t) {
    this.t = clamp(t, 0, Math.max(0, this.duration()));
    this.invalidate();
    this.emit('time');
  }

  step(frames) {
    if (this.playing) this.pause();
    this.seek(Math.round(this.t * FPS + frames) / FPS);
  }

  // ---------- export ----------
  // job: { canvas?, ctx?, W?, H?, end, onFrame?, onDone? } — plays 0 → end in real time.
  async startExport(job) {
    this.pause();
    this.ensureAudio();
    this.t = 0;
    this.sync();
    await this.settle();
    if (job.cancelled) return;
    this.job = job;
    this.rate = 1;
    this.playing = true;
    this.last = performance.now();
    this.invalidate();
    this.emit('state');
  }

  cancelExport() {
    if (!this.job) return;
    this.job = null;
    this.pause();
  }

  destroyMedia(mediaId) {
    for (const [id, e] of this.pool) if (e.mediaId === mediaId) this.dropEl(id);
  }
}
