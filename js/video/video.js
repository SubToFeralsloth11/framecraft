// FrameCraft video editor: layout, preview + transport, direct manipulation in the preview,
// empty state and keyboard shortcuts. Mounted once by js/main.js.
import { License, requirePro } from '../license.js';
import { el, toast, pickFiles } from '../ui.js';
import { ASPECTS, FPS, clamp, clone, frameSize, timecode, trackStateAt, videoTracks, propAt, setKey } from './model.js';
import { Store } from './store.js';
import { MediaBin, ACCEPT } from './media.js';
import { Engine } from './engine.js';
import { pointInPoly } from './render.js';
import { createActions } from './actions.js';
import { Timeline } from './timeline.js';
import { Inspector } from './inspector.js';
import { Panels } from './panels.js';
import { openExport } from './exporter.js';
import { saveProject, openProject } from './project.js';

const MAX_PREVIEW_SHORT = 1080;

export function mount(root) {
  root.textContent = '';
  const store = new Store();
  const media = new MediaBin();

  // ---------- layout ----------
  const canvas = el('canvas', { class: 'vt-canvas' });
  const mediaHost = el('div', { class: 'vt-media-host', 'aria-hidden': 'true' });
  const stage = el('div', { class: 'vt-stage checker' }, canvas);
  const left = el('aside', { class: 'vt-left panel' });
  const inspectorBody = el('div', { class: 'vt-insp' });
  const right = el('aside', { class: 'vt-right panel' }, el('div', { class: 'panel-title' }, 'Inspector'), inspectorBody);
  const transport = el('div', { class: 'vt-transport' });
  const center = el('section', { class: 'vt-center' }, stage, transport);
  const bottom = el('section', { class: 'vt-bottom panel' });
  const top = el('div', { class: 'vt-top' });
  root.append(top, el('div', { class: 'vt-main' }, left, center, right), bottom, mediaHost);

  const engine = new Engine({ store, media, canvas, host: mediaHost });
  const ed = {
    root, store, media, engine, drag: null,
    frame: () => frameSize(store.p.aspect, 1080),
    setAspect: (a) => { if (ASPECTS[a]) store.mutate((p) => { p.aspect = a; }); },
    pickColor: (id) => { picking = id; stage.classList.add('vt-picking'); toast('Click the background colour in the preview'); },
  };
  ed.actions = createActions(ed);
  const { actions } = ed;
  ed.timeline = new Timeline(ed, bottom);
  new Inspector(ed, inspectorBody);
  new Panels(ed, left);

  // ---------- top bar ----------
  const undoBtn = el('button', { class: 'icon-btn', title: 'Undo (Ctrl/Cmd+Z)', onclick: () => store.undo() }, '↶ Undo');
  const redoBtn = el('button', { class: 'icon-btn', title: 'Redo (Ctrl/Cmd+Shift+Z)', onclick: () => store.redo() }, '↷ Redo');
  const saveBtn = el('button', { class: 'btn', title: 'Save project (.fcvideo)', onclick: () => saveProject(ed) }, '💾 Save');
  top.append(
    el('button', { class: 'btn', onclick: async () => actions.importFiles(await pickFiles(ACCEPT, true)) }, '＋ Import'),
    el('button', { class: 'btn', title: 'Start a new empty project', onclick: () => newProject() }, 'New'),
    el('button', { class: 'btn', title: 'Open a .fcvideo project', onclick: () => openProject(ed) }, '📂 Open'),
    saveBtn,
    el('span', { class: 'vt-sep' }),
    undoBtn, redoBtn,
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn primary', onclick: () => openExport(ed) }, '⬇ Export'));
  const renderTop = () => {
    undoBtn.disabled = !store.undoStack.length;
    redoBtn.disabled = !store.redoStack.length;
    saveBtn.querySelector('.pro-badge')?.remove();
    if (!License.isPro()) saveBtn.append(el('span', { class: 'pro-badge' }, 'PRO'));
  };
  License.onChange(renderTop);

  function newProject() {
    if (store.p.clips.length && !confirm('Start a new project? The current timeline will be cleared (media stays in the bin).')) return;
    engine.pause();
    store.load(new Store().p);
    engine.seek(0);
  }

  // ---------- transport ----------
  const playBtn = el('button', { class: 'vt-play', title: 'Play / pause (Space)', onclick: () => engine.toggle() }, '▶');
  const tcNow = el('span', { class: 'vt-tc' });
  const tcDur = el('span', { class: 'vt-tc muted' });
  const rateTag = el('span', { class: 'vt-rate muted' });
  const aspectSel = el('select', { title: 'Aspect ratio', onchange: () => ed.setAspect(aspectSel.value) }, Object.keys(ASPECTS).map((a) => el('option', { value: a }, a)));
  const scrub = el('input', { type: 'range', class: 'vt-scrub', min: 0, max: 1000, step: 1, value: 0, oninput: () => engine.seek((scrub.value / 1000) * engine.duration()) });
  transport.append(
    el('div', { class: 'row' },
      el('button', { class: 'icon-btn', title: 'Go to start (Home)', onclick: () => engine.seek(0) }, '⏮'),
      el('button', { class: 'icon-btn', title: 'Previous frame (←)', onclick: () => engine.step(-1) }, '◀︎|'),
      playBtn,
      el('button', { class: 'icon-btn', title: 'Next frame (→)', onclick: () => engine.step(1) }, '|▶︎'),
      el('button', { class: 'icon-btn', title: 'Go to end (End)', onclick: () => engine.seek(engine.duration()) }, '⏭'),
      tcNow, el('span', { class: 'muted' }, '/'), tcDur, rateTag),
    scrub,
    el('label', { class: 'row muted' }, 'Aspect', aspectSel));
  const renderTransport = () => {
    const d = engine.duration();
    tcNow.textContent = timecode(engine.t);
    tcDur.textContent = timecode(d);
    playBtn.textContent = engine.playing && engine.rate > 0 ? '❚❚' : '▶';
    rateTag.textContent = engine.playing && engine.rate !== 1 ? `${engine.rate > 0 ? '▶' : '◀'} ${Math.abs(engine.rate)}x` : '';
    if (document.activeElement !== scrub) scrub.value = d ? (engine.t / d) * 1000 : 0;
  };
  engine.on(renderTransport);

  // ---------- preview sizing ----------
  function layoutPreview() {
    const [a, b] = ASPECTS[store.p.aspect];
    const pad = 16, sw = stage.clientWidth - pad * 2, sh = stage.clientHeight - pad * 2;
    if (sw <= 0 || sh <= 0) return;
    const k = Math.min(sw / a, sh / b);
    const cw = Math.floor(a * k), ch = Math.floor(b * k);
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    const dpr = Math.min(2, devicePixelRatio || 1);
    const short = Math.min(MAX_PREVIEW_SHORT, Math.min(cw, ch) * dpr);
    const { w, h } = frameSize(store.p.aspect, short);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    engine.invalidate();
  }
  new ResizeObserver(layoutPreview).observe(stage);

  // ---------- empty state ----------
  const empty = el('div', { class: 'vt-empty' },
    el('div', { class: 'vt-empty-card' },
      el('div', { class: 'vt-big' }, '🎬'),
      el('h2', {}, 'Start your video'),
      el('p', { class: 'muted' }, 'Drop video, audio or image files anywhere here, or import them. Then drag them from the Media bin onto the timeline. Everything stays on your computer.'),
      el('div', { class: 'row vt-center-row' },
        el('button', { class: 'btn primary', onclick: async () => actions.importFiles(await pickFiles(ACCEPT, true), {}) }, '＋ Import media'),
        el('button', { class: 'btn', onclick: () => actions.titleCard() }, '✨ Try a title card'))));
  stage.append(empty);
  stage.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files') || ed.drag?.type === 'media' || ed.drag?.type === 'gen') { e.preventDefault(); stage.classList.add('drop'); } });
  stage.addEventListener('dragleave', (e) => { if (!stage.contains(e.relatedTarget)) stage.classList.remove('drop'); });
  stage.addEventListener('drop', (e) => {
    stage.classList.remove('drop');
    e.preventDefault();
    const d = ed.drag;
    ed.drag = null;
    if (d?.type === 'media') { const m = media.get(d.id); if (m) actions.addMedia(m); }
    else if (d?.type === 'gen') actions.addGenerated(d.kind, clone(d.props));
    else if (e.dataTransfer.files.length) actions.importFiles([...e.dataTransfer.files], {});
  });
  // Stop the browser from opening files dropped elsewhere in the editor.
  root.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  root.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) e.preventDefault(); });

  // ---------- preview: selection outline, click to select, drag to move ----------
  const toCanvas = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height];
  };
  const visibleClips = (t) => {
    const out = [];
    for (const tr of videoTracks(store.p)) {
      if (tr.hidden) continue;
      const st = trackStateAt(store.p, tr.id, t);
      if (st?.clip) out.push(st.clip);
      else if (st) out.push(st.p < 0.5 ? st.a : st.b);
    }
    return out; // bottom → top
  };
  engine.overlay = (ctx, W, H, t) => {
    const vis = new Set(visibleClips(t).map((c) => c.id));
    ctx.save();
    ctx.lineWidth = Math.max(1, W / 600);
    ctx.strokeStyle = '#6c8cff';
    ctx.setLineDash([6, 4]);
    for (const c of store.selected()) {
      if (!vis.has(c.id)) continue;
      const pts = engine.comp.corners(c, t, W, H);
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
  };

  let picking = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const [px, py] = toCanvas(e);
    if (picking) return pickAt(px, py);
    const t = engine.t, W = canvas.width, H = canvas.height;
    const hits = visibleClips(t).reverse().filter((c) => pointInPoly(px, py, engine.comp.corners(c, t, W, H)));
    if (!hits.length) { store.select([]); return; }
    const sel = hits.find((c) => store.selection.has(c.id)) || hits[0];
    if (!store.selection.has(sel.id) || store.selection.size > 1) store.select([sel.id]);
    if (engine.playing) engine.pause();
    const id = sel.id, lt = clamp(t - sel.start, 0, sel.duration);
    const keyed = ['x', 'y'].some((k) => sel.keyframes[k]?.length);
    if (keyed && !License.isPro()) return;
    const ox = propAt(sel, 'x', lt), oy = propAt(sel, 'y', lt);
    const key = 'preview-move-' + performance.now();
    canvas.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const [mx, my] = toCanvas(ev);
      let nx = ox + (mx - px) / W, ny = oy + (my - py) / H;
      if (!ev.altKey) { // snap to centre
        if (Math.abs(nx - 0.5) < 0.012) nx = 0.5;
        if (Math.abs(ny - 0.5) < 0.012) ny = 0.5;
      }
      store.mutate((p) => {
        const c = p.clips.find((x) => x.id === id);
        if (!c) return;
        for (const [k, v] of [['x', nx], ['y', ny]]) {
          if (c.keyframes[k]?.length) setKey(c, k, lt, v);
          else c[k] = v;
        }
      }, { coalesce: key, source: 'preview' });
    };
    const up = () => { canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
  });

  function pickAt(px, py) {
    const id = picking;
    picking = null;
    stage.classList.remove('vt-picking');
    if (!requirePro('Chroma key (green screen)')) return;
    // Render the frame with this clip's key turned off so the original colour is sampled.
    const W = canvas.width, H = canvas.height;
    const off = el('canvas', { width: W, height: H });
    const octx = off.getContext('2d', { willReadFrequently: true });
    const p = clone(store.p);
    const c = p.clips.find((x) => x.id === id);
    if (!c) return;
    c.chroma.on = false;
    engine.comp.render(octx, W, H, engine.t, p);
    const x = clamp(Math.round(px) - 2, 0, W - 5), y = clamp(Math.round(py) - 2, 0, H - 5);
    const d = octx.getImageData(x, y, 5, 5).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4, hex = '#' + [r, g, b].map((v) => Math.round(v / n).toString(16).padStart(2, '0')).join('');
    store.mutate((q) => { const k = q.clips.find((z) => z.id === id); if (k) { k.chroma.color = hex; k.chroma.on = true; } });
    toast(`Key colour set to ${hex}`, 'ok');
  }

  // ---------- store wiring ----------
  let lastAspect = null;
  store.on((info) => {
    empty.classList.toggle('hidden', store.p.clips.length > 0);
    if (store.p.aspect !== lastAspect) { lastAspect = store.p.aspect; aspectSel.value = lastAspect; layoutPreview(); }
    if (engine.t > engine.duration()) engine.seek(engine.duration());
    renderTop();
    renderTransport();
    engine.invalidate();
    if (info.type === 'load') ed.timeline.fit();
  });
  store.emit({ type: 'init' });
  License.onChange(() => engine.invalidate());

  // ---------- keyboard ----------
  let active = true;
  window.addEventListener('fc:mode', (e) => {
    active = e.detail?.mode === 'video';
    if (!active) engine.pause();
  });
  window.addEventListener('keydown', (e) => {
    if (!active || root.classList.contains('hidden') || document.querySelector('.modal-wrap')) return;
    const tgt = e.target;
    if (tgt.closest?.('input, textarea, select, [contenteditable="true"]')) {
      if (e.key === 'Escape') tgt.blur();
      return;
    }
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    let handled = true;
    if (mod && k === 'z') { if (e.shiftKey) store.redo(); else store.undo(); }
    else if (mod && k === 'y') store.redo();
    else if (mod && k === 'c') actions.copy();
    else if (mod && k === 'v') actions.paste();
    else if (mod && k === 'd') actions.duplicate();
    else if (mod && k === 'a') actions.selectAll();
    else if (mod && k === 's') saveProject(ed);
    else if (mod) handled = false;
    else if (e.key === ' ') engine.toggle();
    else if (k === 's') actions.split();
    else if (e.key === 'Delete' || e.key === 'Backspace') actions.deleteSelected(e.shiftKey);
    else if (k === 'j') engine.shuttle(-1);
    else if (k === 'k') engine.shuttle(0);
    else if (k === 'l') engine.shuttle(1);
    else if (e.key === 'ArrowLeft') engine.step(e.shiftKey ? -FPS : -1);
    else if (e.key === 'ArrowRight') engine.step(e.shiftKey ? FPS : 1);
    else if (e.key === 'Home') engine.seek(0);
    else if (e.key === 'End') engine.seek(engine.duration());
    else if (e.key === '+' || e.key === '=') ed.timeline.zoomBy(1.4);
    else if (e.key === '-' || e.key === '_') ed.timeline.zoomBy(1 / 1.4);
    else if (k === 'n') ed.timeline.toggleSnap();
    else if (e.key === 'Escape') { store.select([]); if (picking) { picking = null; stage.classList.remove('vt-picking'); } }
    else handled = false;
    if (handled) e.preventDefault();
  });

  window.addEventListener('beforeunload', (e) => {
    if (store.p.clips.length && store.undoStack.length) { e.preventDefault(); e.returnValue = ''; }
  });
}
