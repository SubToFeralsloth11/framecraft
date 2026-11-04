// Multi-track timeline: ruler, playhead, track headers, clips with move / trim / multi-select,
// snapping, zoom, drag-and-drop targets and a clip context menu.
import { CONFIG } from '../config.js';
import { License } from '../license.js';
import { el } from '../ui.js';
import {
  FPS, clipEnd, clone, displayTracks, trackLabel, canHold, trackClips, trimStart, trimEnd, moveClips, snapTime,
  projectDuration, prevAdjacent, transDur, TRANSITIONS, KEY_PROPS, clamp,
} from './model.js';

const HEAD_W = 136;
const ROW_H = { video: 58, audio: 46 };
const MIN_PPS = 4, MAX_PPS = 480;
const fmtRuler = (t, step) => {
  const m = Math.floor(t / 60), s = Math.floor(t % 60), f = Math.round((t % 1) * FPS);
  return step < 1 ? `${m}:${String(s).padStart(2, '0')}.${String(f).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

export class Timeline {
  constructor(ed, host) {
    this.ed = ed;
    this.pps = 60;
    this.snap = true;
    this.build(host);
    ed.store.on(() => this.render());
    ed.media.on(() => this.render());
    ed.engine.on((type) => { if (type === 'time') this.updatePlayhead(); });
    License.onChange(() => this.render());
    new ResizeObserver(() => this.render()).observe(this.scroll);
    this.render();
  }

  build(host) {
    const { actions } = this.ed;
    this.snapBtn = el('button', { class: 'icon-btn vt-on', title: 'Snapping (N)', onclick: () => this.toggleSnap() }, '🧲 Snap');
    this.zoom = el('input', { type: 'range', min: 0, max: 1000, step: 1, title: 'Timeline zoom (+ / −)', oninput: () => this.setPps(MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, this.zoom.value / 1000)) });
    this.addV = el('button', { class: 'btn', onclick: () => actions.addTrack('video') }, '+ Video track');
    this.addA = el('button', { class: 'btn', onclick: () => actions.addTrack('audio') }, '+ Audio track');
    const bar = el('div', { class: 'vt-tl-bar' },
      el('button', { class: 'icon-btn', title: 'Split at playhead (S)', onclick: () => actions.split() }, '✂ Split'),
      el('button', { class: 'icon-btn', title: 'Delete (Del)', onclick: () => actions.deleteSelected(false) }, '🗑 Delete'),
      el('button', { class: 'icon-btn', title: 'Ripple delete (Shift+Del)', onclick: () => actions.deleteSelected(true) }, '⇤ Ripple delete'),
      el('button', { class: 'icon-btn', title: 'Duplicate (Ctrl/Cmd+D)', onclick: () => actions.duplicate() }, '⧉ Duplicate'),
      this.snapBtn,
      el('span', { class: 'vt-sep' }),
      this.addV, this.addA,
      el('div', { class: 'spacer' }),
      el('button', { class: 'icon-btn', title: 'Zoom out (−)', onclick: () => this.zoomBy(1 / 1.4) }, '−'),
      this.zoom,
      el('button', { class: 'icon-btn', title: 'Zoom in (+)', onclick: () => this.zoomBy(1.4) }, '+'),
      el('button', { class: 'icon-btn', title: 'Zoom to fit', onclick: () => this.fit() }, '⤢ Fit'));

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

  // ---------- geometry ----------
  timeAtClient(x) { return Math.max(0, (x - this.inner.getBoundingClientRect().left - HEAD_W) / this.pps); }
  contentWidth() {
    const dur = projectDuration(this.ed.store.p);
    return Math.max((dur + 30) * this.pps, this.scroll.clientWidth - HEAD_W);
  }

  setPps(pps, anchor = this.ed.engine.t) {
    const before = HEAD_W + anchor * this.pps - this.scroll.scrollLeft;
    this.pps = clamp(pps, MIN_PPS, MAX_PPS);
    this.zoom.value = (Math.log(this.pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)) * 1000;
    this.render();
    this.scroll.scrollLeft = HEAD_W + anchor * this.pps - before;
  }
  zoomBy(f, anchor) { this.setPps(this.pps * f, anchor); }
  fit() {
    const dur = Math.max(5, projectDuration(this.ed.store.p));
    this.setPps((this.scroll.clientWidth - HEAD_W - 40) / dur, 0);
    this.scroll.scrollLeft = 0;
  }
  toggleSnap() { this.snap = !this.snap; this.snapBtn.classList.toggle('vt-on', this.snap); }

  // ---------- render ----------
  render() {
    const { store, media } = this.ed, p = store.p;
    const width = this.contentWidth();
    this.inner.style.width = HEAD_W + width + 'px';
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
      const head = el('div', { class: `vt-head vt-${tr.kind}` },
        el('b', {}, trackLabel(p, tr)),
        tr.kind === 'video' ? el('button', { class: 'icon-btn' + (tr.hidden ? ' vt-off' : ''), title: tr.hidden ? 'Show track' : 'Hide track', onclick: () => this.ed.actions.toggleTrack(tr.id, 'hidden') }, tr.hidden ? '◌' : '👁') : null,
        el('button', { class: 'icon-btn' + (tr.muted ? ' vt-off' : ''), title: tr.muted ? 'Unmute track' : 'Mute track', onclick: () => this.ed.actions.toggleTrack(tr.id, 'muted') }, tr.muted ? '🔇' : '🔊'),
        el('button', { class: 'icon-btn', title: 'Remove track', onclick: () => this.ed.actions.removeTrack(tr.id) }, '✕'));
      const row = el('div', { class: `vt-row vt-${tr.kind}`, style: { height: ROW_H[tr.kind] + 'px' } }, head, lane);
      this.rows.append(row);
      lane.addEventListener('pointerdown', (e) => { if (e.target === lane) { if (!e.shiftKey) store.select([]); this.scrub(e); } });
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
        }, '⧉'));
      }
    }
    this.drawRuler();
    this.updatePlayhead();
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
    if (Object.keys(c.keyframes).some((k) => c.keyframes[k]?.length)) badges.push('◆');
    if (c.muted) badges.push('🔇');
    const label = c.kind === 'text' ? `T  ${c.text.content.split('\n')[0] || 'Text'}` : (offline ? '⚠ ' : '') + c.name;
    node.append(el('div', { class: 'vt-clip-label' }, label, ...badges.map((b) => el('span', { class: 'vt-badge' }, b))));
    if (c.fadeIn > 0) node.append(el('div', { class: 'vt-fade in', style: { width: c.fadeIn * this.pps + 'px' } }));
    if (c.fadeOut > 0) node.append(el('div', { class: 'vt-fade out', style: { width: c.fadeOut * this.pps + 'px' } }));
    const keyTimes = new Set();
    for (const p of KEY_PROPS) for (const k of c.keyframes[p] || []) keyTimes.add(k.t.toFixed(3));
    for (const kt of keyTimes) if (+kt >= 0 && +kt <= c.duration) node.append(el('i', { class: 'vt-key', style: { left: +kt * this.pps + 'px' } }));
    node.append(el('div', { class: 'vt-h l', title: 'Trim start' }), el('div', { class: 'vt-h r', title: 'Trim end' }));
    node.addEventListener('pointerdown', (e) => this.clipDown(e, c));
    node.addEventListener('contextmenu', (e) => { e.preventDefault(); this.openMenu(e, c); });
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
    const cv = this.ruler, w = Math.max(1, this.scroll.clientWidth - HEAD_W), h = 24, dpr = devicePixelRatio || 1;
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
    const x = HEAD_W + t * this.pps;
    this.playhead.style.transform = `translateX(${x}px)`;
    if (this.ed.engine.playing) {
      const s = this.scroll, vis = s.scrollLeft + HEAD_W, right = s.scrollLeft + s.clientWidth;
      if (x > right - 40 || x < vis) s.scrollLeft = x - HEAD_W - 40;
    }
  }

  // ---------- interactions ----------
  scrub(e) {
    const { engine } = this.ed;
    if (engine.playing) engine.pause();
    const move = (ev) => engine.seek(this.timeAtClient(ev.clientX));
    move(e);
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  snapTargets(exclude) {
    const t = [0, this.ed.engine.t];
    for (const c of this.ed.store.p.clips) if (!exclude.has(c.id)) t.push(c.start, clipEnd(c));
    return t;
  }

  clipDown(e, c) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const { store } = this.ed;
    const handle = e.target.classList.contains('vt-h') ? (e.target.classList.contains('l') ? 'l' : 'r') : null;
    const wasSelected = store.selection.has(c.id);
    if (e.shiftKey && !handle) { store.select([c.id], true); return; }
    if (!wasSelected) store.select([c.id]);
    const startX = e.clientX, startY = e.clientY;
    let moved = false, cancel = null;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      if (!moved) { moved = true; cancel = handle ? this.beginTrim(c, handle) : this.beginMove(c); }
      cancel.move(ev, (ev.clientX - startX) / this.pps);
    };
    const up = (ev) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (moved) cancel.commit(ev);
      else if (wasSelected && store.selection.size > 1) store.select([c.id]);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
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
    };
  }

  showSnapLine(t) {
    this.dropLine.classList.remove('hidden');
    this.dropLine.style.transform = `translateX(${HEAD_W + t * this.pps}px)`;
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
    this.closeMenu();
    const { actions, store, engine } = this.ed;
    if (!store.selection.has(c.id)) store.select([c.id]);
    const item = (label, key, fn) => el('button', { onclick: () => { this.closeMenu(); fn(); } }, el('span', {}, label), el('kbd', {}, key));
    const inside = engine.t > c.start && engine.t < clipEnd(c);
    this.menu = el('div', { class: 'vt-menu', style: { left: e.clientX + 'px', top: e.clientY + 'px' } },
      inside ? item('Split at playhead', 'S', () => actions.split()) : null,
      item('Copy', '⌘C', () => actions.copy()),
      item('Paste at playhead', '⌘V', () => actions.paste()),
      item('Duplicate', '⌘D', () => actions.duplicate()),
      c.trans ? item('Remove transition', '', () => store.mutate((p) => { const x = p.clips.find((k) => k.id === c.id); if (x) x.trans = null; })) : null,
      item('Delete', 'Del', () => actions.deleteSelected(false)),
      item('Ripple delete', '⇧Del', () => actions.deleteSelected(true)));
    this.ed.root.append(this.menu);
    const r = this.menu.getBoundingClientRect();
    if (r.bottom > innerHeight) this.menu.style.top = innerHeight - r.height - 6 + 'px';
    if (r.right > innerWidth) this.menu.style.left = innerWidth - r.width - 6 + 'px';
  }
  closeMenu() { this.menu?.remove(); this.menu = null; }
}
