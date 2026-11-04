// Editor commands shared by the toolbar, timeline, panels and keyboard shortcuts.
import { CONFIG } from '../config.js';
import { requirePro } from '../license.js';
import { toast } from '../ui.js';
import {
  createClip, clone, uid, clipEnd, canHold, findFreeSpot, insertClips, isFree, splitAt, deleteClips, rippleDelete,
  prevAdjacent, nextAdjacent, videoTracks, audioTracks, TRANSITIONS,
} from './model.js';
import { EFFECTS } from './looks.js';

export function createActions(ed) {
  const { store, media, engine } = ed;
  let clipboard = null;

  const clipFromMedia = (m) => createClip(m.kind, {
    mediaId: m.id, name: m.name,
    srcDur: m.kind === 'image' ? null : m.duration,
    duration: m.kind === 'image' ? 5 : m.duration,
  });

  // First track of the right kind; honours a preferred track when compatible.
  function trackFor(p, c, preferredId) {
    const pref = p.tracks.find((t) => t.id === preferredId);
    if (pref && canHold(pref, c)) return pref;
    return (c.kind === 'audio' ? audioTracks(p) : videoTracks(p))[0] || null;
  }

  function placeNew(clips, { trackId = null, at = null, overwrite = at != null } = {}) {
    const ids = [];
    store.mutate((p) => {
      let cursor = at ?? engine.t;
      for (const c of clips) {
        const tr = trackFor(p, c, trackId);
        if (!tr) { toast(`Add ${c.kind === 'audio' ? 'an audio' : 'a video'} track first`, 'warn'); continue; }
        c.trackId = tr.id;
        c.start = overwrite ? Math.max(0, cursor) : findFreeSpot(p, tr.id, cursor, c.duration);
        insertClips(p, [c]);
        ids.push(c.id);
        if (overwrite) cursor = clipEnd(c);
      }
    });
    if (ids.length) store.select(ids);
    return ids;
  }

  const A = {
    clipFromMedia,

    async importFiles(files, place = null) {
      if (!files?.length) return [];
      const note = files.length > 1 ? `Importing ${files.length} files…` : `Importing ${files[0].name}…`;
      toast(note);
      const { added, errors } = await media.add(files);
      errors.forEach((e) => toast(e, 'err', 4500));
      if (added.length) toast(`Imported ${added.length} file${added.length > 1 ? 's' : ''}`, 'ok');
      if (place && added.length) placeNew(added.map(clipFromMedia), place);
      return added;
    },

    // Adds media to the timeline. Without a position it goes to the first free spot after the playhead.
    addMedia(m, opts = {}) { return placeNew([clipFromMedia(m)], opts); },

    // Titles / backgrounds / shapes. Without a track: the highest video track that is free at the playhead.
    addGenerated(kind, props, opts = {}) {
      const c = createClip(kind, props);
      if (!opts.trackId && opts.at == null) {
        const p = store.p, t = engine.t;
        const vts = videoTracks(p).reverse();
        const free = (kind === 'solid' ? [...vts].reverse() : vts).find((tr) => isFree(p, tr.id, t, t + c.duration));
        if (free) return placeNew([c], { trackId: free.id, at: t });
        return placeNew([c], { trackId: vts[0]?.id });
      }
      return placeNew([c], opts);
    },

    titleCard() {
      if (!videoTracks(store.p).length) { toast('Add a video track first', 'warn'); return; }
      const t = engine.t;
      const bg = createClip('solid', { name: 'Gradient', fill: { mode: 'linear', c1: '#1d2b64', c2: '#6c3cff', angle: 135 } });
      const title = createClip('text', { name: 'Title', text: { content: 'My first video', size: 120, anim: 'pop', animDur: 0.7 } });
      store.mutate((p) => {
        const vts = videoTracks(p);
        bg.trackId = vts[0].id; bg.start = t;
        title.trackId = (vts[1] || vts[0]).id; title.start = t;
        if (vts.length > 1) insertClips(p, [bg, title]); else insertClips(p, [title]);
      });
      store.select([title.id]);
    },

    split() {
      const t = engine.t;
      const sel = store.selection;
      const under = store.p.clips.filter((c) => sel.has(c.id) && t > c.start && t < clipEnd(c));
      const ids = under.length ? new Set(under.map((c) => c.id)) : null;
      const made = store.mutate((p) => splitAt(p, t, ids));
      if (!made?.length) toast('Move the playhead over a clip to split it', 'warn');
    },

    deleteSelected(ripple = false) {
      if (!store.selection.size) return;
      const ids = new Set(store.selection);
      store.mutate((p) => (ripple ? rippleDelete(p, ids) : deleteClips(p, ids)));
    },

    duplicate() {
      const sel = store.selected();
      if (!sel.length) return;
      const ids = [];
      store.mutate((p) => {
        for (const c of sel.sort((a, b) => a.start - b.start)) {
          const d = clone(c);
          d.id = uid();
          d.trans = null;
          d.start = findFreeSpot(p, c.trackId, clipEnd(c), c.duration);
          p.clips.push(d);
          ids.push(d.id);
        }
      });
      store.select(ids);
    },

    copy() {
      const sel = store.selected();
      if (!sel.length) return;
      clipboard = clone(sel);
      toast(`Copied ${sel.length} clip${sel.length > 1 ? 's' : ''}`);
    },

    paste() {
      if (!clipboard?.length) return toast('Nothing to paste', 'warn');
      const minStart = Math.min(...clipboard.map((c) => c.start));
      const ids = [];
      store.mutate((p) => {
        const items = clone(clipboard).map((c) => {
          const tr = trackFor(p, c, c.trackId);
          if (!tr) return null;
          c.id = uid();
          c.trans = null;
          c.trackId = tr.id;
          c.start = engine.t + (c.start - minStart);
          return c;
        }).filter(Boolean);
        insertClips(p, items);
        ids.push(...items.map((c) => c.id));
      });
      store.select(ids);
    },

    addTrack(kind) {
      if (store.p.tracks.length >= CONFIG.free.videoMaxTracks && !requirePro(`More than ${CONFIG.free.videoMaxTracks} tracks`)) return;
      store.mutate((p) => {
        // video tracks are stored bottom → top, so a new one lands on top
        const tr = { id: uid('t'), kind, muted: false, hidden: false };
        if (kind === 'video') p.tracks.splice(videoTracks(p).length ? p.tracks.indexOf(videoTracks(p).at(-1)) + 1 : 0, 0, tr);
        else p.tracks.push(tr);
      });
    },

    removeTrack(id) {
      const p = store.p, tr = p.tracks.find((t) => t.id === id);
      if (!tr) return;
      const n = p.clips.filter((c) => c.trackId === id).length;
      if (n && !confirm(`Remove this track and its ${n} clip${n > 1 ? 's' : ''}?`)) return;
      store.mutate((q) => { q.tracks = q.tracks.filter((t) => t.id !== id); q.clips = q.clips.filter((c) => c.trackId !== id); });
    },

    toggleTrack(id, prop) { store.mutate((p) => { const tr = p.tracks.find((t) => t.id === id); if (tr) tr[prop] = !tr[prop]; }); },

    // side: 'start' puts the transition on the cut before the clip, 'end' on the cut after it.
    applyTransition(clipId, type, side = 'start') {
      const p = store.p, c = p.clips.find((x) => x.id === clipId);
      if (!c) return;
      if (c.kind === 'audio' || p.tracks.find((t) => t.id === c.trackId)?.kind !== 'video') return toast('Transitions work on video tracks', 'warn');
      const target = side === 'end' || !prevAdjacent(p, c) ? nextAdjacent(p, c) : c;
      if (!target) return toast('Place two clips edge to edge on the same track to add a transition', 'warn', 3500);
      const id = target.id;
      store.mutate((q) => {
        const x = q.clips.find((k) => k.id === id);
        x.trans = { type, dur: x.trans?.dur || 1 };
      });
      store.select([id]);
      toast(`${TRANSITIONS[type]} added`, 'ok');
    },

    applyEffect(clipId, type) {
      const c = store.clip(clipId);
      if (!c) return;
      if (c.kind === 'audio' || store.p.tracks.find((t) => t.id === c.trackId)?.kind !== 'video') return toast('Effects work on clips in video tracks', 'warn');
      store.mutate((p) => {
        const x = p.clips.find((k) => k.id === clipId);
        x.effects.push({ id: uid('fx'), type, amount: EFFECTS[type].def ?? 100 });
      });
      store.select([clipId]);
      toast(`${EFFECTS[type].name} applied`, 'ok');
    },

    selectAll() { store.select(store.p.clips.map((c) => c.id)); },
  };
  return A;
}
