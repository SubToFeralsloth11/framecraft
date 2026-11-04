// Multi-track timeline: ruler, playhead, track headers, clips with move / trim / multi-select,
// snapping, zoom, drag-and-drop targets and a clip context menu. Touch: one finger drags clips /
// trims / scrubs, long-press opens the clip menu, two fingers pinch-zoom and pan.
import { CONFIG } from '../config.js';
import { License } from '../license.js';
import { el } from '../ui.js';
import { iconEl } from '../icons.js';
import {
  FPS, clipEnd, clone, displayTracks, trackLabel, canHold, trackClips, trimStart, trimEnd, moveClips, snapTime,
  projectDuration, prevAdjacent, transDur, TRANSITIONS, KEY_PROPS, clamp,
} from './model.js';

const ROW_H = { video: 58, audio: 46 };
const MIN_PPS = 4, MAX_PPS = 480;
const LONG_PRESS_MS = 480;
const TRANS_ICONS = { crossfade: 'crossfade', dip: 'dip', wipe: 'wipe', slide: 'slide', zoom: 'zoomT' };
const fmtRuler = (t, step) => {
  const m = Math.floor(t / 60), s = Math.floor(t % 60), f = Math.round((t % 1) * FPS);
  return step < 1 ? `${m}:${String(s).padStart(2, '0')}.${String(f).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
// Icon + text label; the label hides on phones (CSS) so the bar stays compact.
const lbl = (name, text) => [iconEl(name, 16), el('span', { class: 'vt-lbl' }, text)];

export class Timeline {
  constructor(ed, host) {
    this.ed = ed;
    this.pps = 60;
    this.snap = true;
    this.multi = false; // on-screen "Select multiple" (touch equivalent of Shift-click)
    this.hw = 136; // track header width; read from --vt-head-w on render
    this.op = null; // in-progress one-pointer operation { cancel }
    this.build(host);
    this.initTouch();
    ed.store.on(() => this.render());
    ed.media.on(() => this.render());
    ed.engine.on((type) => { if (type === 'time') this.updatePlayhead(); });
    License.onChange(() => this.render());
    new ResizeObserver(() => this.render()).observe(this.scroll);
    this.render();
  }

  build(host) {
    const { actions } = this.ed;
    this.snapBtn = el('button', { class: 'icon-btn vt-on', title: 'Snapping (N)', onclick: () => this.toggleSnap() }, lbl('magnet', 'Snap'));
    this.multiBtn = el('button', { class: 'icon-btn vt-mob', title: 'Select multiple clips (tap clips to add / remove)', onclick: () => this.toggleMulti() }, lbl('selAdd', 'Multi-select'));
    this.zoom = el('input', { type: 'range', min: 0, max: 1000, step: 1, title: 'Timeline zoom (+ / −)', oninput: () => this.setPps(MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, this.zoom.value / 1000)) });
    this.addV = el('button', { class: 'btn', title: 'Add a video track', onclick: () => actions.addTrack('video') }, iconEl('plus', 14), 'Video track');
    this.addA = el('button', { class: 'btn', title: 'Add an audio track', onclick: () => actions.addTrack('audio') }, iconEl('plus', 14), 'Audio track');
    const bar = el('div', { class: 'vt-tl-bar' },
      el('button', { class: 'icon-btn', title: 'Split at playhead (S)', onclick: () => actions.split() }, lbl('scissors', 'Split')),
      el('button', { class: 'icon-btn', title: 'Delete (Del)', onclick: () => actions.deleteSelected(false) }, lbl('trash', 'Delete')),
      el('button', { class: 'icon-btn', title: 'Ripple delete (Shift+Del)', onclick: () => actions.deleteSelected(true) }, lbl('ripple', 'Ripple delete')),
      el('button', { class: 'icon-btn', title: 'Duplicate (Ctrl/Cmd+D)', onclick: () => actions.duplicate() }, lbl('copy', 'Duplicate')),
      this.snapBtn,
      this.multiBtn,
      el('span', { class: 'vt-sep' }),
      this.addV, this.addA,
      el('div', { class: 'spacer' }),
      el('button', { class: 'icon-btn', title: 'Zoom out (−)', onclick: () => this.zoomBy(1 / 1.4) }, iconEl('zoomOut', 16)),
      this.zoom,
      el('button', { class: 'icon-btn', title: 'Zoom in (+)', onclick: () => this.zoomBy(1.4) }, iconEl('zoom', 16)),
      el('button', { class: 'icon-btn', title: 'Zoom to fit', onclick: () => this.fit() }, lbl('fit', 'Fit')));

    this.ruler = el('canvas', { class: 'vt-ruler' });
    this.rows = el('div', { class: 'vt-rows' });
    this.playhead = el('div', { class: 'vt-playhead' });
    this.dropLine = el('div', { class: 'vt-dropline hidden' });
    this.inner = el('div', { class: 'vt-inner' },
      el('div', { class: 'vt-rulerrow' }, el('div', { class: 'vt-corner' }, 'Tracks'), this.ruler),
      this.rows, this.playhead, this.dropLine);
    this.scroll = el('div', { class: 'vt-scroll' }, this.inner);
    host.append(bar, this.scroll);

    this.scroll.addEventListener('scroll', () => this.drawRuler());
    this.scroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, this.timeAtClient(e.clientX));
    }, { passive: false });
    this.ruler.addEventListener('pointerdown', (e) => this.scrub(e));
    document.addEventListener('pointerdown', (e) => { if (this.menu && !this.menu.contains(e.target)) this.closeMenu(); });
  }

  // ---------- touch: pinch zoom / two-finger pan ----------
  initTouch() {
    this.touches = new Map(); // pointerId → { x, y } for touches that started in the timeline
    this.pinch = null;
    this.scroll.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 1) {
        // One finger on the track headers pans the timeline (there is nothing to edit there).
        if (e.target.closest('.vt-head, .vt-corner') && !e.target.closest('button')) { e.stopPropagation(); this.startPinch(); }
        return;
      }
      // Second finger: drop whatever the first finger started, then zoom / pan.
      e.stopPropagation();
      e.preventDefault();
      this.cancelOp();
      this.closeMenu();
      this.startPinch();
    }, true);
    const move = (e) => {
      const t = this.touches.get(e.pointerId);
      if (!t) return;
      t.x = e.clientX;
      t.y = e.clientY;
      if (this.pinch && !this.pinchRaf) this.pinchRaf = requestAnimationFrame(() => { this.pinchRaf = 0; this.applyPinch(); });
    };
    const up = (e) => {
      if (!this.touches.delete(e.pointerId)) return;
      // Lifting one of two fingers ends the gesture; the remaining finger does nothing until lifted.
      if (this.pinch && (this.pinch.n === 2 || !this.touches.size)) this.pinch = this.touches.size ? { dead: true } : null;
      if (!this.touches.size) this.pinch = null;
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  }

  touchPoints() {
    const pts = [...this.touches.values()].slice(0, 2);
    const mid = pts.length > 1 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : { ...pts[0] };
    const dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    return { mid, dist, n: pts.length };
  }

  startPinch() {
    const { mid, dist, n } = this.touchPoints();
    const left = this.inner.getBoundingClientRect().left;
    this.pinch = { n, d0: Math.max(10, dist), pps0: this.pps, t0: (mid.x - left - this.hw) / this.pps, y0: mid.y, top0: this.scroll.scrollTop };
  }

  applyPinch() {
    const p = this.pinch;
    if (!p || p.dead || !this.touches.size) return;
    const { mid, dist, n } = this.touchPoints();
    if (p.n === 2 && n === 2) {
      const pps = clamp(p.pps0 * (dist / p.d0), MIN_PPS, MAX_PPS);
      if (Math.abs(pps - this.pps) > 1e-3) { this.pps = pps; this.render(); }
    }
    // Keep the time that was under the fingers' midpoint under it (zoom anchor + horizontal pan).
    const r = this.scroll.getBoundingClientRect();
    this.scroll.scrollLeft = this.hw + p.t0 * this.pps - (mid.x - r.left);
    this.scroll.scrollTop = p.top0 - (mid.y - p.y0);
  }

  cancelOp() { const op = this.op; this.op = null; op?.cancel(); }

  // ---------- geometry ----------
  timeAtClient(x) { return Math.max(0, (x - this.inner.getBoundingClientRect().left - this.hw) / this.pps); }
  contentWidth() {
    const dur = projectDuration(this.ed.store.p);
    return Math.max((dur + 30) * this.pps, this.scroll.clientWidth - this.hw);
  }

  setPps(pps, anchor = this.ed.engine.t) {
    const before = this.hw + anchor * this.pps - this.scroll.scrollLeft;
    this.pps = clamp(pps, MIN_PPS, MAX_PPS);
    this.zoom.value = (Math.log(this.pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)) * 1000;
    this.render();
    this.scroll.scrollLeft = this.hw + anchor * this.pps - before;
  }
  zoomBy(f, anchor) { this.setPps(this.pps * f, anchor); }
  fit() {
    const dur = Math.max(5, projectDuration(this.ed.store.p));
    this.setPps((this.scroll.clientWidth - this.hw - 40) / dur, 0);
    this.scroll.scrollLeft = 0;
  }
  toggleSnap() { this.snap = !this.snap; this.snapBtn.classList.toggle('vt-on', this.snap); }
  toggleMulti(on = !this.multi) { this.multi = on; this.multiBtn.classList.toggle('vt-on', on); }

  // ---------- render ----------
  render() {
    const { store, media } = this.ed, p = store.p;
    this.hw = parseFloat(getComputedStyle(this.inner).getPropertyValue('--vt-head-w')) || 136;
    const width = this.contentWidth();
    this.inner.style.width = this.hw + width + 'px';
    const atLimit = p.tracks.length >= CONFIG.free.videoMaxTracks && !License.isPro();
    for (const b of [this.addV, this.addA]) b.querySelector('.pro-badge')?.remove();
    if (atLimit) { this.addV.append(el('span', { class: 'pro-badge' }, 'PRO')); this.addA.append(el('span', { class: 'pro-badge' }, 'PRO')); }
    this.zoom.value = (Math.log(this.pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)) * 1000;

    this.rows.textContent = '';
    this.lanes = new Map();
    for (const tr of displayTracks(p)) {
      const lane = el('div', { class: 'vt-lane', style: { width: width + 'px' } });
      lane.dataset.track = tr.id;
      this.lanes.set(tr.id, lane);
      const row = el('div', { class: `vt-row vt-${tr.kind}`, style: { height: ROW_H[tr.kind] + 'px' } }, this.head(tr), lane);
      this.rows.append(row);
      lane.addEventListener('pointerdown', (e) => {
        if (e.target !== lane || e.button !== 0) return;
        if (!e.shiftKey && !this.multi) store.select([]);
        this.scrub(e);
      });
      this.dropTarget(lane, tr);
      for (const c of trackClips(p, tr.id)) lane.append(this.clipEl(c, tr, media));
      // transition markers
      for (const c of trackClips(p, tr.id)) {
        const a = c.trans && prevAdjacent(p, c);
        if (!a) continue;
        const d = transDur(a, c);
        lane.append(el('div', {
          class: 'vt-trans', title: `${TRANSITIONS[c.trans.type]} (${d.toFixed(2)} s) — click to edit`,
          style: { left: (c.start - d / 2) * this.pps + 'px', width: Math.max(10, d * this.pps) + 'px' },
          onpointerdown: (e) => { e.stopPropagation(); store.select([c.id]); },
        }, iconEl(TRANS_ICONS[c.trans.type] || 'crossfade', 12)));
      }
    }
    this.drawRuler();
    this.updatePlayhead();
  }

  // Track header. Desktop: name + hide / mute / remove buttons. Touch / phone (CSS): name + state
  // icons + one "more" button that opens the same actions as a menu.
  head(tr) {
    const { actions, store } = this.ed;
    const p = store.p;
    const hide = () => actions.toggleTrack(tr.id, 'hidden');
    const mute = () => actions.toggleTrack(tr.id, 'muted');
    const remove = () => actions.removeTrack(tr.id);
    const more = el('button', {
      class: 'icon-btn vt-head-more', title: 'Track options',
      onclick: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        this.popMenu(r.left, r.bottom + 4, [
          tr.kind === 'video' ? [tr.hidden ? 'Show track' : 'Hide track', '', hide] : null,
          [tr.muted ? 'Unmute track' : 'Mute track', '', mute],
          ['Remove track', '', remove],
        ]);
      },
    }, iconEl('more', 16));
    return el('div', { class: `vt-head vt-${tr.kind}` },
      el('b', {}, trackLabel(p, tr)),
      el('span', { class: 'vt-head-state' },
        tr.kind === 'video' && tr.hidden ? iconEl('eyeOff', 12) : null,
        tr.muted ? iconEl('mute', 12) : null),
      tr.kind === 'video' ? el('button', { class: 'icon-btn vt-hb' + (tr.hidden ? ' vt-off' : ''), title: tr.hidden ? 'Show track' : 'Hide track', onclick: hide }, iconEl(tr.hidden ? 'eyeOff' : 'eye', 15)) : null,
      el('button', { class: 'icon-btn vt-hb' + (tr.muted ? ' vt-off' : ''), title: tr.muted ? 'Unmute track' : 'Mute track', onclick: mute }, iconEl(tr.muted ? 'mute' : 'volume', 15)),
      el('button', { class: 'icon-btn vt-hb', title: 'Remove track', onclick: remove }, iconEl('close', 15)),
      more);
  }

  clipEl(c, tr, media) {
    const m = media.get(c.mediaId);
    const sel = this.ed.store.selection.has(c.id);
    const offline = c.mediaId && !m;
    const node = el('div', {
      class: `vt-clip k-${c.kind}${sel ? ' sel' : ''}${offline ? ' offline' : ''}${tr.kind === 'audio' ? ' on-audio' : ''}`,
      style: { left: c.start * this.pps + 'px', width: Math.max(2, c.duration * this.pps) + 'px' },
      title: `${c.name} — ${c.duration.toFixed(2)} s`,
    });
    node.dataset.id = c.id;
    if ((c.kind === 'video' || c.kind === 'image') && m?.thumb && tr.kind === 'video') node.style.backgroundImage = `url("${m.thumb}")`;
    if (c.kind === 'solid') node.style.background = c.fill.mode === 'solid' ? c.fill.c1 : `linear-gradient(90deg, ${c.fill.c1}, ${c.fill.c2})`;
    if (m?.peaks && (tr.kind === 'audio' || c.kind === 'video')) node.append(this.waveform(c, m));
    const badges = [];
    if (c.speed !== 1) badges.push(`${c.speed}x`);
    if (c.effects.length) badges.push(`fx${c.effects.length}`);
    if (c.chroma.on) badges.push('key');
    if (Object.keys(c.keyframes).some((k) => c.keyframes[k]?.length)) badges.push(iconEl('keyframe', 9));
    if (c.muted) badges.push(iconEl('mute', 10));
    const label = c.kind === 'text'
      ? [iconEl('text', 12), c.text.content.split('\n')[0] || 'Text']
      : [offline ? iconEl('warn', 12) : null, c.name];
    node.append(el('div', { class: 'vt-clip-label' }, label, ...badges.map((b) => el('span', { class: 'vt-badge' }, b))));
    if (c.fadeIn > 0) node.append(el('div', { class: 'vt-fade in', style: { width: c.fadeIn * this.pps + 'px' } }));
    if (c.fadeOut > 0) node.append(el('div', { class: 'vt-fade out', style: { width: c.fadeOut * this.pps + 'px' } }));
    const keyTimes = new Set();
    for (const p of KEY_PROPS) for (const k of c.keyframes[p] || []) keyTimes.add(k.t.toFixed(3));
    for (const kt of keyTimes) if (+kt >= 0 && +kt <= c.duration) node.append(el('i', { class: 'vt-key', style: { left: +kt * this.pps + 'px' } }));
    node.append(el('div', { class: 'vt-h l', title: 'Trim start' }), el('div', { class: 'vt-h r', title: 'Trim end' }));
    node.addEventListener('pointerdown', (e) => this.clipDown(e, c));
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (performance.now() - (this.lpAt || 0) < 1200) return; // our long-press already opened it
      this.openMenu(e, c);
    });
    node.addEventListener('dragover', (e) => { if (this.ed.drag?.type === 'transition' || this.ed.drag?.type === 'effect') { e.preventDefault(); e.stopPropagation(); node.classList.add('drop'); } });
    node.addEventListener('dragleave', () => node.classList.remove('drop'));
    node.addEventListener('drop', (e) => {
      const d = this.ed.drag;
      if (d?.type !== 'transition' && d?.type !== 'effect') return;
      e.preventDefault();
      e.stopPropagation();
      node.classList.remove('drop');
      this.ed.drag = null;
      if (d.type === 'effect') this.ed.actions.applyEffect(c.id, d.id);
      else this.ed.actions.applyTransition(c.id, d.id, e.offsetX < node.clientWidth / 2 ? 'start' : 'end');
    });
    return node;
  }

  waveform(c, m) {
    const w = Math.min(4000, Math.max(2, Math.round(c.duration * this.pps))), h = 40;
    const cv = el('canvas', { class: 'vt-wave', width: w, height: h });
    const ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    const per = (c.duration * c.speed * 40) / w;
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor(c.in * 40 + x * per), i1 = Math.max(i0 + 1, Math.floor(c.in * 40 + (x + 1) * per));
      let v = 0;
      for (let i = i0; i < i1 && i < m.peaks.length; i++) v = Math.max(v, m.peaks[i]);
      const bh = Math.max(1, v * h * Math.min(2, c.volume));
      ctx.fillRect(x, (h - bh) / 2, 1, bh);
    }
    return cv;
  }

  drawRuler() {
    const cv = this.ruler, w = Math.max(1, this.scroll.clientWidth - this.hw), h = 24, dpr = devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = h * dpr; cv.style.width = w + 'px'; cv.style.height = h + 'px'; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const t0 = this.scroll.scrollLeft / this.pps, t1 = t0 + w / this.pps;
    const steps = [1 / FPS, 2 / FPS, 5 / FPS, 10 / FPS, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
    const major = steps.find((s) => s * this.pps >= 70) || 3600;
    const minor = major / 5;
    ctx.strokeStyle = '#4a5164';
    ctx.fillStyle = '#8b91a1';
    ctx.font = '10px system-ui, sans-serif';
    ctx.beginPath();
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round((t - t0) * this.pps) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.moveTo(x, isMajor ? 10 : 17);
      ctx.lineTo(x, h);
      if (isMajor) ctx.fillText(fmtRuler(t + 1e-6, major), x + 3, 10);
    }
    ctx.stroke();
  }

  updatePlayhead() {
    const t = this.ed.engine.t;
    const x = this.hw + t * this.pps;
    this.playhead.style.transform = `translateX(${x}px)`;
    if (this.ed.engine.playing) {
      const s = this.scroll, vis = s.scrollLeft + this.hw, right = s.scrollLeft + s.clientWidth;
      if (x > right - 40 || x < vis) s.scrollLeft = x - this.hw - 40;
    }
  }

  // ---------- interactions ----------
  scrub(e) {
    const { engine } = this.ed;
    if (this.touches.size > 1) return;
    if (engine.playing) engine.pause();
    const t0 = engine.t, id = e.pointerId;
    const move = (ev) => { if (ev.pointerId === id) engine.seek(this.timeAtClient(ev.clientX)); };
    const stop = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      if (this.op === op) this.op = null;
    };
    const up = (ev) => { if (ev.pointerId === id) stop(); };
    const op = { cancel: () => { stop(); engine.seek(t0); } };
    this.cancelOp();
    this.op = op;
    move(e);
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  }

  snapTargets(exclude) {
    const t = [0, this.ed.engine.t];
    for (const c of this.ed.store.p.clips) if (!exclude.has(c.id)) t.push(c.start, clipEnd(c));
    return t;
  }

  clipDown(e, c) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (this.touches.size > 1) return;
    const { store } = this.ed;
    const touch = e.pointerType === 'touch';
    const handle = e.target.classList.contains('vt-h') ? (e.target.classList.contains('l') ? 'l' : 'r') : null;
    const wasSelected = store.selection.has(c.id);
    if (e.shiftKey && !handle) { store.select([c.id], true); return; }
    const multi = this.multi && !handle;
    if (!wasSelected && !multi) store.select([c.id]);
    const id = e.pointerId, startX = e.clientX, startY = e.clientY;
    const threshold = touch ? 8 : 4;
    let moved = false, drag = null;
    let lp = touch ? setTimeout(() => {
      lp = null;
      if (moved || this.op !== op) return;
      stop();
      this.lpAt = performance.now();
      navigator.vibrate?.(12);
      this.openMenu({ clientX: startX, clientY: startY }, c);
    }, LONG_PRESS_MS) : null;
    const move = (ev) => {
      if (ev.pointerId !== id) return;
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < threshold) return;
      if (!moved) {
        moved = true;
        clearTimeout(lp);
        if (multi && !store.selection.has(c.id)) store.select([c.id], true);
        drag = handle ? this.beginTrim(c, handle) : this.beginMove(c);
      }
      drag.move(ev, (ev.clientX - startX) / this.pps);
    };
    const stop = () => {
      clearTimeout(lp);
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', abort);
      if (this.op === op) this.op = null;
    };
    const up = (ev) => {
      if (ev.pointerId !== id) return;
      stop();
      if (moved) drag.commit(ev);
      else if (multi) store.select([c.id], true);
      else if (wasSelected && store.selection.size > 1) store.select([c.id]);
    };
    const abort = (ev) => { if (ev.pointerId === id) op.cancel(); };
    const op = { cancel: () => { stop(); if (moved) drag.abort(); } };
    this.cancelOp();
    this.op = op;
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', abort);
  }

  beginTrim(c, side) {
    const { store } = this.ed, p = store.p;
    const node = this.inner.querySelector(`.vt-clip[data-id="${c.id}"]`);
    const others = trackClips(p, c.trackId).filter((o) => o.id !== c.id);
    const minStart = Math.max(0, ...others.filter((o) => clipEnd(o) <= c.start + 1e-4).map(clipEnd));
    const maxEnd = Math.min(Infinity, ...others.filter((o) => o.start >= clipEnd(c) - 1e-4).map((o) => o.start));
    const targets = this.snapTargets(new Set([c.id]));
    const thr = 8 / this.pps;
    let result = c;
    return {
      move: (_ev, dt) => {
        const tmp = clone(c);
        if (side === 'l') {
          let ns = c.start + dt;
          if (this.snap) ns = snapTime(ns, targets, thr);
          trimStart(tmp, ns, minStart);
        } else {
          let ne = clipEnd(c) + dt;
          if (this.snap) ne = snapTime(ne, targets, thr);
          trimEnd(tmp, ne, maxEnd);
        }
        result = tmp;
        node.style.left = tmp.start * this.pps + 'px';
        node.style.width = Math.max(2, tmp.duration * this.pps) + 'px';
        this.showSnapLine(side === 'l' ? tmp.start : clipEnd(tmp));
      },
      commit: () => {
        this.hideSnapLine();
        const r = result;
        store.mutate((q) => {
          const x = q.clips.find((k) => k.id === c.id);
          if (side === 'l') trimStart(x, r.start, minStart);
          else trimEnd(x, clipEnd(r), maxEnd);
        });
      },
      abort: () => { this.hideSnapLine(); this.render(); },
    };
  }

  beginMove(c) {
    const { store } = this.ed, p = store.p;
    const tracks = displayTracks(p);
    const group = store.selected();
    const ids = new Set(group.map((g) => g.id));
    const targets = this.snapTargets(ids);
    const thr = 8 / this.pps;
    const minStart = Math.min(...group.map((g) => g.start));
    const rowOf = (trackId) => tracks.findIndex((t) => t.id === trackId);
    const nodes = new Map(group.map((g) => [g.id, this.inner.querySelector(`.vt-clip[data-id="${g.id}"]`)]));
    let moves = [];
    return {
      move: (ev, dt) => {
        let d = Math.max(dt, -minStart);
        if (this.snap) {
          const s = snapTime(c.start + d, targets, thr), e = snapTime(clipEnd(c) + d, targets, thr);
          if (s !== c.start + d) d = s - c.start;
          else if (e !== clipEnd(c) + d) d = e - clipEnd(c);
          d = Math.max(d, -minStart);
        }
        // vertical: row under pointer relative to the grabbed clip's row
        const rowEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.vt-row');
        const laneId = rowEl?.querySelector('.vt-lane')?.dataset.track;
        let delta = laneId ? rowOf(laneId) - rowOf(c.trackId) : 0;
        if (delta && group.some((g) => { const t = tracks[rowOf(g.trackId) + delta]; return !t || !canHold(t, g); })) delta = 0;
        moves = group.map((g) => ({ id: g.id, start: g.start + d, trackId: tracks[rowOf(g.trackId) + delta].id }));
        for (const m of moves) {
          const n = nodes.get(m.id);
          if (!n) continue;
          n.style.left = m.start * this.pps + 'px';
          const lane = this.lanes.get(m.trackId);
          if (n.parentNode !== lane) lane.append(n);
          n.classList.add('dragging');
        }
        this.showSnapLine(c.start + d);
      },
      commit: () => {
        this.hideSnapLine();
        if (moves.length) store.mutate((q) => moveClips(q, moves));
        else this.render();
      },
      abort: () => { this.hideSnapLine(); this.render(); },
    };
  }

  showSnapLine(t) {
    this.dropLine.classList.remove('hidden');
    this.dropLine.style.transform = `translateX(${this.hw + t * this.pps}px)`;
  }
  hideSnapLine() { this.dropLine.classList.add('hidden'); }

  // Media / titles / files dropped onto a lane.
  dropTarget(lane, tr) {
    const accepts = (e) => ['media', 'gen'].includes(this.ed.drag?.type) || [...(e.dataTransfer?.types || [])].includes('Files');
    const timeAt = (e) => {
      let t = this.timeAtClient(e.clientX);
      if (this.snap) t = snapTime(t, this.snapTargets(new Set()), 8 / this.pps);
      return t;
    };
    lane.addEventListener('dragover', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      lane.classList.add('drop');
      this.showSnapLine(timeAt(e));
    });
    lane.addEventListener('dragleave', () => { lane.classList.remove('drop'); this.hideSnapLine(); });
    lane.addEventListener('drop', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.stopPropagation();
      lane.classList.remove('drop');
      this.hideSnapLine();
      const at = timeAt(e), d = this.ed.drag;
      this.ed.drag = null;
      const { actions, media } = this.ed;
      if (d?.type === 'media') { const m = media.get(d.id); if (m) actions.addMedia(m, { trackId: tr.id, at }); }
      else if (d?.type === 'gen') actions.addGenerated(d.kind, clone(d.props), { trackId: tr.id, at });
      else if (e.dataTransfer.files.length) actions.importFiles([...e.dataTransfer.files], { trackId: tr.id, at });
    });
  }

  openMenu(e, c) {
    const { actions, store, engine } = this.ed;
    if (!store.selection.has(c.id)) store.select([c.id], this.multi);
    const inside = engine.t > c.start && engine.t < clipEnd(c);
    this.popMenu(e.clientX, e.clientY, [
      inside ? ['Split at playhead', 'S', () => actions.split()] : null,
      ['Copy', '⌘C', () => actions.copy()],
      ['Paste at playhead', '⌘V', () => actions.paste()],
      ['Duplicate', '⌘D', () => actions.duplicate()],
      c.trans ? ['Remove transition', '', () => store.mutate((p) => { const x = p.clips.find((k) => k.id === c.id); if (x) x.trans = null; })] : null,
      ['Delete', 'Del', () => actions.deleteSelected(false)],
      ['Ripple delete', '⇧Del', () => actions.deleteSelected(true)],
      this.ed.openInspector ? ['Edit in Inspector', '', () => this.ed.openInspector(), 'vt-mob'] : null,
    ]);
  }

  // Fixed-position menu at (x, y), kept inside the viewport. items: [label, shortcut, fn, class?] | null.
  popMenu(x, y, items) {
    this.closeMenu();
    const item = ([label, key, fn, cls]) => el('button', { class: cls || null, onclick: () => { this.closeMenu(); fn(); } }, el('span', {}, label), key ? el('kbd', {}, key) : null);
    this.menu = el('div', { class: 'vt-menu', role: 'menu', style: { left: x + 'px', top: y + 'px' } }, items.filter(Boolean).map(item));
    this.ed.root.append(this.menu);
    const r = this.menu.getBoundingClientRect();
    if (r.bottom > innerHeight - 6) this.menu.style.top = Math.max(6, innerHeight - r.height - 6) + 'px';
    if (r.right > innerWidth - 6) this.menu.style.left = Math.max(6, innerWidth - r.width - 6) + 'px';
  }
  closeMenu() { this.menu?.remove(); this.menu = null; }
}
