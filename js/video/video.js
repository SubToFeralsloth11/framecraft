// FrameCraft video editor: layout, preview + transport, direct manipulation in the preview,
// empty state, keyboard shortcuts and the phone / tablet shell (bottom sheets, drawers, tab bar).
// Mounted once by js/main.js.
import { License, requirePro } from '../license.js';
import { el, toast, pickFiles } from '../ui.js';
import { iconEl } from '../icons.js';
import { ASPECTS, FPS, clamp, clone, frameSize, timecode, trackStateAt, videoTracks, propAt, setKey } from './model.js';
import { Store } from './store.js';
import { MediaBin, ACCEPT } from './media.js';
import { Engine } from './engine.js';
import { pointInPoly } from './render.js';
import { createActions } from './actions.js';
import { Timeline } from './timeline.js';
import { Inspector } from './inspector.js';
import { Panels, TABS } from './panels.js';
import { openExport } from './exporter.js';
import { saveProject, openProject } from './project.js';

const MAX_PREVIEW_SHORT = 1080;
// Keep in sync with the @media blocks in css/video.css.
const PHONE_Q = '(max-width: 759px), (orientation: landscape) and (max-height: 520px) and (max-width: 1100px)';
const PHONE_PORTRAIT_Q = '(max-width: 759px) and (min-height: 521px), (max-width: 759px) and (orientation: portrait)';
const TABLET_Q = '(min-width: 760px) and (max-width: 1100px) and (min-height: 521px)';

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
  const leftTitle = el('b', { class: 'vt-sheet-title' }, 'Media');
  const right = el('aside', { class: 'vt-right panel' },
    sheetHead('right', el('b', { class: 'vt-sheet-title' }, 'Inspector')),
    el('div', { class: 'panel-title vt-desk-title' }, 'Inspector'), inspectorBody);
  const transport = el('div', { class: 'vt-transport' });
  const center = el('section', { class: 'vt-center' }, stage, transport);
  const bottom = el('section', { class: 'vt-bottom panel' });
  const top = el('div', { class: 'vt-top' });
  const tabbar = el('nav', { class: 'vt-tabbar', 'aria-label': 'Editor panels' });
  const offerName = el('span', { class: 'vt-offer-name' });
  const offer = el('div', { class: 'vt-offer hidden' },
    el('button', { class: 'btn primary', onclick: () => openSheet('right') }, iconEl('sliders', 16), offerName),
    el('button', { class: 'icon-btn', title: 'Dismiss', onclick: () => hideOffer() }, iconEl('close', 16)));
  root.append(top, el('div', { class: 'vt-main' }, left, center, right), bottom, tabbar, offer, mediaHost);

  const engine = new Engine({ store, media, canvas, host: mediaHost });
  const ed = {
    root, store, media, engine, drag: null,
    frame: () => frameSize(store.p.aspect, 1080),
    setAspect: (a) => { if (ASPECTS[a]) store.mutate((p) => { p.aspect = a; }); },
    pickColor: (id) => { picking = id; stage.classList.add('vt-picking'); if (layout() !== 'desktop') openSheet(null); toast('Click or tap the background colour in the preview'); },
  };
  ed.actions = createActions(ed);
  const { actions } = ed;
  ed.timeline = new Timeline(ed, bottom);
  new Inspector(ed, inspectorBody);
  left.append(sheetHead('left', leftTitle));
  ed.panels = new Panels(ed, left);

  // ---------- phone / tablet shell ----------
  const mq = { phone: matchMedia(PHONE_Q), portrait: matchMedia(PHONE_PORTRAIT_Q), tablet: matchMedia(TABLET_Q) };
  function layout() { return mq.phone.matches ? 'phone' : mq.tablet.matches ? 'tablet' : 'desktop'; }
  let sheet = null; // 'left' | 'right' | null — open bottom sheet (phone) or overlay drawer (tablet)

  function sheetHead(side, title) {
    const head = el('div', { class: 'vt-sheet-head' },
      el('span', { class: 'vt-grab', 'aria-hidden': 'true' }),
      title,
      el('div', { class: 'spacer' }),
      el('button', { class: 'icon-btn vt-pin', title: 'Keep open as a column', onclick: () => dock(side, true) }, iconEl('pin', 16)),
      el('button', { class: 'icon-btn vt-unpin', title: 'Collapse into a drawer', onclick: () => dock(side, false) }, iconEl(side === 'left' ? 'chevronLeft' : 'chevronRight', 16)),
      el('button', { class: 'icon-btn vt-close', title: 'Close', onclick: () => openSheet(null) }, iconEl('close', 16)));
    // Phone portrait: drag the sheet header down to dismiss.
    let y0 = null;
    head.addEventListener('pointerdown', (e) => {
      if (!mq.portrait.matches || e.target.closest('button')) return;
      y0 = e.clientY;
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (y0 == null) return;
      head.parentNode.style.transform = `translateY(${Math.max(0, e.clientY - y0)}px)`;
    });
    const end = (e) => {
      if (y0 == null) return;
      const dy = e.clientY - y0;
      y0 = null;
      head.parentNode.style.transform = '';
      if (dy > 60) openSheet(null);
    };
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
    return head;
  }

  function openSheet(which) {
    sheet = which;
    root.classList.toggle('vt-open-left', which === 'left');
    root.classList.toggle('vt-open-right', which === 'right');
    if (which) hideOffer();
    syncTabs();
  }

  function dock(side, on) {
    root.classList.toggle('vt-dock-' + side, on);
    if (sheet === side) openSheet(null);
    else syncTabs();
  }

  function toggleSide(side) {
    if (root.classList.contains('vt-dock-' + side)) dock(side, false);
    else openSheet(sheet === side ? null : side);
  }

  function leftTab(tab) {
    if (sheet === 'left' && ed.panels.tab === tab) return openSheet(null);
    ed.panels.show(tab);
    openSheet('left');
  }

  const TAB_ICONS = { media: 'film', titles: 'title', transitions: 'crossfade', effects: 'sparkles' };
  const tabBtns = Object.entries(TABS).map(([k, name]) => {
    const b = el('button', { class: 'vt-tab', onclick: () => leftTab(k) }, iconEl(TAB_ICONS[k], 20), el('span', {}, name));
    b.dataset.k = k;
    return b;
  });
  const inspTab = el('button', { class: 'vt-tab', onclick: () => openSheet(sheet === 'right' ? null : 'right') }, iconEl('sliders', 20), el('span', {}, 'Inspector'));
  inspTab.dataset.k = 'inspector';
  tabbar.append(...tabBtns, inspTab);

  const binToggle = el('button', { class: 'icon-btn vt-tab-only', title: 'Show / hide the media panel', onclick: () => toggleSide('left') }, iconEl('layers', 16), el('span', { class: 'vt-lbl' }, 'Media'));
  const inspToggle = el('button', { class: 'icon-btn vt-tab-only', title: 'Show / hide the inspector', onclick: () => toggleSide('right') }, iconEl('sliders', 16), el('span', { class: 'vt-lbl' }, 'Inspector'));

  function syncTabs() {
    for (const b of tabBtns) b.classList.toggle('active', sheet === 'left' && ed.panels.tab === b.dataset.k);
    inspTab.classList.toggle('active', sheet === 'right');
    binToggle.classList.toggle('vt-on', sheet === 'left' || root.classList.contains('vt-dock-left'));
    inspToggle.classList.toggle('vt-on', sheet === 'right' || root.classList.contains('vt-dock-right'));
  }
  ed.panels.onShow = (tab) => { leftTitle.textContent = TABS[tab]; syncTabs(); };
  leftTitle.textContent = TABS[ed.panels.tab];

  // Selecting a clip on a phone offers to open the Inspector sheet.
  let offerTimer = 0;
  function hideOffer() { clearTimeout(offerTimer); offer.classList.add('hidden'); }
  function maybeOffer() {
    const sel = store.selected();
    if (layout() !== 'phone' || sheet || sel.length !== 1) return hideOffer();
    offerName.textContent = `Edit ${sel[0].kind === 'text' ? 'text' : 'clip'}`;
    offer.classList.remove('hidden');
    clearTimeout(offerTimer);
    offerTimer = setTimeout(hideOffer, 4500);
  }
  store.on((info) => { if (info.type === 'select') maybeOffer(); });

  // Called after an item was added / applied by tapping it in the Media/Titles/Transitions/Effects panel.
  ed.picked = () => {
    if (layout() !== 'desktop' && sheet) openSheet(null);
    maybeOffer();
  };
  ed.openInspector = () => {
    if (layout() === 'desktop' || (layout() === 'tablet' && root.classList.contains('vt-dock-right'))) return;
    openSheet('right');
  };

  function tabletDefaults() {
    const wide = innerWidth >= 960;
    root.classList.toggle('vt-dock-left', wide);
    root.classList.toggle('vt-dock-right', wide);
  }
  const onLayout = () => {
    openSheet(null);
    hideOffer();
    if (layout() === 'tablet') tabletDefaults();
  };
  for (const m of [mq.phone, mq.tablet]) m.addEventListener('change', onLayout);
  if (layout() === 'tablet') tabletDefaults();

  // ---------- top bar ----------
  const undoBtn = el('button', { class: 'icon-btn', title: 'Undo (Ctrl/Cmd+Z)', onclick: () => store.undo() }, iconEl('undo', 16), el('span', { class: 'vt-lbl' }, 'Undo'));
  const redoBtn = el('button', { class: 'icon-btn', title: 'Redo (Ctrl/Cmd+Shift+Z)', onclick: () => store.redo() }, iconEl('redo', 16), el('span', { class: 'vt-lbl' }, 'Redo'));
  const saveBtn = el('button', { class: 'btn vt-nophone', title: 'Save project (.fcvideo)', onclick: () => saveProject(ed) }, iconEl('save', 16), 'Save');
  const importMedia = async () => actions.importFiles(await pickFiles(ACCEPT, true));
  const moreBtn = el('button', {
    class: 'icon-btn vt-phone-only', title: 'More',
    onclick: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      ed.timeline.popMenu(r.right, r.bottom + 4, [
        ['New project', '', () => newProject()],
        ['Open project…', '', () => openProject(ed)],
        [`Save project${License.isPro() ? '' : ' (Pro)'}`, '', () => saveProject(ed)],
        ['Select all clips', '', () => actions.selectAll()],
        ['Copy', '', () => actions.copy()],
        ['Paste at playhead', '', () => actions.paste()],
      ]);
    },
  }, iconEl('more', 18));
  top.append(
    binToggle,
    el('button', { class: 'btn', title: 'Import media', onclick: importMedia }, iconEl('plus', 16), el('span', { class: 'vt-lbl' }, 'Import')),
    el('button', { class: 'btn vt-nophone', title: 'Start a new empty project', onclick: () => newProject() }, 'New'),
    el('button', { class: 'btn vt-nophone', title: 'Open a .fcvideo project', onclick: () => openProject(ed) }, iconEl('open', 16), 'Open'),
    saveBtn,
    el('span', { class: 'vt-sep vt-nophone' }),
    undoBtn, redoBtn,
    el('div', { class: 'spacer' }),
    inspToggle,
    el('button', { class: 'btn primary', title: 'Export', onclick: () => openExport(ed) }, iconEl('download', 16), 'Export'),
    moreBtn);
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
  const playBtn = el('button', { class: 'vt-play', title: 'Play / pause (Space)', onclick: () => engine.toggle() }, iconEl('play', 16));
  let playShown = false;
  const tcNow = el('span', { class: 'vt-tc' });
  const tcDur = el('span', { class: 'vt-tc muted' });
  const rateTag = el('span', { class: 'vt-rate muted' });
  const aspectSel = el('select', { title: 'Aspect ratio', onchange: () => ed.setAspect(aspectSel.value) }, Object.keys(ASPECTS).map((a) => el('option', { value: a }, a)));
  const scrub = el('input', { type: 'range', class: 'vt-scrub', min: 0, max: 1000, step: 1, value: 0, oninput: () => engine.seek((scrub.value / 1000) * engine.duration()) });
  transport.append(
    el('div', { class: 'row vt-tbtns' },
      el('button', { class: 'icon-btn', title: 'Go to start (Home)', onclick: () => engine.seek(0) }, iconEl('skipBack', 16)),
      el('button', { class: 'icon-btn', title: 'Previous frame (←)', onclick: () => engine.step(-1) }, iconEl('stepBack', 16)),
      playBtn,
      el('button', { class: 'icon-btn', title: 'Next frame (→)', onclick: () => engine.step(1) }, iconEl('stepFwd', 16)),
      el('button', { class: 'icon-btn', title: 'Go to end (End)', onclick: () => engine.seek(engine.duration()) }, iconEl('skipFwd', 16)),
      tcNow, el('span', { class: 'muted' }, '/'), tcDur, rateTag),
    scrub,
    el('label', { class: 'row muted vt-aspect' }, el('span', { class: 'vt-lbl' }, 'Aspect'), aspectSel));
  const renderTransport = () => {
    const d = engine.duration();
    tcNow.textContent = timecode(engine.t);
    tcDur.textContent = timecode(d);
    const playing = engine.playing && engine.rate > 0;
    if (playing !== playShown) { playShown = playing; playBtn.replaceChildren(iconEl(playing ? 'pause' : 'play', 16)); }
    rateTag.textContent = engine.playing && engine.rate !== 1 ? `${engine.rate > 0 ? '' : 'rev '}${Math.abs(engine.rate)}x` : '';
    if (document.activeElement !== scrub) scrub.value = d ? (engine.t / d) * 1000 : 0;
  };
  engine.on(renderTransport);

  // ---------- preview sizing ----------
  function layoutPreview() {
    const [a, b] = ASPECTS[store.p.aspect];
    const pad = stage.clientWidth < 500 ? 6 : 16;
    const sw = stage.clientWidth - pad * 2, sh = stage.clientHeight - pad * 2;
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
      el('div', { class: 'vt-big' }, iconEl('film', 40)),
      el('h2', {}, 'Start your video'),
      el('p', { class: 'muted vt-desk-txt' }, 'Drop video, audio or image files anywhere here, or import them. Then drag them from the Media bin onto the timeline. Everything stays on your computer.'),
      el('p', { class: 'muted vt-mob' }, 'Import video, audio or images, then tap Add in Media to place them at the playhead. Everything stays on your device.'),
      el('div', { class: 'row vt-center-row' },
        el('button', { class: 'btn primary', onclick: async () => actions.importFiles(await pickFiles(ACCEPT, true), {}) }, iconEl('plus', 16), 'Import media'),
        el('button', { class: 'btn', onclick: () => actions.titleCard() }, iconEl('sparkles', 16), 'Try a title card'))));
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

  // ---------- preview: selection outline, tap/click to select, drag to move, pinch / rotate ----------
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

  // Writes props on a clip at local time lt (keyframed props get a key; locked keyframes are skipped).
  const writeProps = (c, lt, vals) => {
    for (const [k, v] of Object.entries(vals)) {
      if (c.keyframes[k]?.length) { if (License.isPro()) setKey(c, k, lt, v); } else c[k] = v;
    }
  };

  let picking = null;
  const touches = new Map(); // pointerId → { x, y } in canvas pixels, touch pointers only
  let gest = null; // { kind: 'move' | 'two' | 'dead', ... }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    const [px, py] = toCanvas(e);
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: px, y: py });
      if (touches.size === 2) return startTwo();
      if (touches.size > 2) return;
    }
    if (picking) { gest = { kind: 'dead' }; return pickAt(px, py); }
    const t = engine.t, W = canvas.width, H = canvas.height;
    const hits = visibleClips(t).reverse().filter((c) => pointInPoly(px, py, engine.comp.corners(c, t, W, H)));
    if (!hits.length) { store.select([]); gest = { kind: 'dead' }; return; }
    const sel = hits.find((c) => store.selection.has(c.id)) || hits[0];
    if (!store.selection.has(sel.id) || store.selection.size > 1) store.select([sel.id]);
    if (engine.playing) engine.pause();
    const lt = clamp(t - sel.start, 0, sel.duration);
    const keyed = ['x', 'y'].some((k) => sel.keyframes[k]?.length);
    if (keyed && !License.isPro()) { gest = { kind: 'dead' }; return; }
    gest = {
      kind: 'move', pid: e.pointerId, id: sel.id, lt, px, py, cx: e.clientX, cy: e.clientY,
      ox: propAt(sel, 'x', lt), oy: propAt(sel, 'y', lt), key: 'preview-move-' + performance.now(),
      slop: e.pointerType === 'touch' ? 6 : 0, started: false,
    };
  });

  function moveOne(e) {
    const g = gest;
    if (!g.started && Math.hypot(e.clientX - g.cx, e.clientY - g.cy) <= g.slop) return;
    g.started = true;
    const W = canvas.width, H = canvas.height;
    const [mx, my] = toCanvas(e);
    let nx = g.ox + (mx - g.px) / W, ny = g.oy + (my - g.py) / H;
    if (!e.altKey) { // snap to centre
      if (Math.abs(nx - 0.5) < 0.012) nx = 0.5;
      if (Math.abs(ny - 0.5) < 0.012) ny = 0.5;
    }
    store.mutate((p) => {
      const c = p.clips.find((x) => x.id === g.id);
      if (c) writeProps(c, g.lt, { x: nx, y: ny });
    }, { coalesce: g.key, source: 'preview' });
  }

  // Second finger: the one-finger move is rolled back (same history entry) and becomes a
  // two-finger move + pinch-scale + twist-rotate of the selected clip.
  function startTwo() {
    const prev = gest;
    const key = prev?.key || 'preview-xf-' + performance.now();
    if (prev?.kind === 'move' && prev.started) {
      store.mutate((p) => { const c = p.clips.find((x) => x.id === prev.id); if (c) writeProps(c, prev.lt, { x: prev.ox, y: prev.oy }); }, { coalesce: key, source: 'preview' });
    }
    const sel = store.selected();
    const c = sel.length === 1 ? sel[0] : null;
    if (!c || !visibleClips(engine.t).some((v) => v.id === c.id)) { gest = { kind: 'dead' }; return; }
    if (engine.playing) engine.pause();
    const lt = clamp(engine.t - c.start, 0, c.duration);
    const [a, b] = [...touches.values()];
    gest = {
      kind: 'two', id: c.id, lt, key,
      x0: propAt(c, 'x', lt), y0: propAt(c, 'y', lt), s0: propAt(c, 'scale', lt), r0: propAt(c, 'rotation', lt),
      m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d0: Math.max(4, Math.hypot(a.x - b.x, a.y - b.y)), a0: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }

  let twoRaf = 0;
  function moveTwo() {
    twoRaf = 0;
    const g = gest;
    if (g?.kind !== 'two' || touches.size < 2) return;
    const [a, b] = [...touches.values()];
    const W = canvas.width, H = canvas.height;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const scale = clamp(g.s0 * (Math.hypot(a.x - b.x, a.y - b.y) / g.d0), 0.05, 4);
    let rot = g.r0 + ((Math.atan2(b.y - a.y, b.x - a.x) - g.a0) * 180) / Math.PI;
    rot = ((((rot + 180) % 360) + 360) % 360) - 180;
    store.mutate((p) => {
      const c = p.clips.find((x) => x.id === g.id);
      if (c) writeProps(c, g.lt, { x: g.x0 + (mid.x - g.m0.x) / W, y: g.y0 + (mid.y - g.m0.y) / H, scale, rotation: rot });
    }, { coalesce: g.key, source: 'preview' });
  }

  canvas.addEventListener('pointermove', (e) => {
    if (touches.has(e.pointerId)) { const [x, y] = toCanvas(e); touches.set(e.pointerId, { x, y }); }
    if (!gest) return;
    if (gest.kind === 'move' && e.pointerId === gest.pid) moveOne(e);
    else if (gest.kind === 'two' && !twoRaf) twoRaf = requestAnimationFrame(moveTwo);
  });
  const endPointer = (e) => {
    touches.delete(e.pointerId);
    if (!gest) return;
    if (gest.kind === 'move' && e.pointerId === gest.pid) gest = null;
    else if (gest.kind === 'two' && touches.size < 2) gest = touches.size ? { kind: 'dead' } : null;
    else if (gest.kind === 'dead' && !touches.size) gest = null;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

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
    if (store.p.aspect !== lastAspect) {
      lastAspect = store.p.aspect;
      aspectSel.value = lastAspect;
      const [a, b] = ASPECTS[lastAspect];
      root.style.setProperty('--vt-ar', String(b / a)); // phone preview height follows the aspect
      layoutPreview();
    }
    if (engine.t > engine.duration()) engine.seek(engine.duration());
    renderTop();
    renderTransport();
    engine.invalidate();
    if (info.type === 'load') ed.timeline.fit();
  });
  store.emit({ type: 'init' });
  License.onChange(() => engine.invalidate());

  // ---------- audio unlock (iOS: the AudioContext must be created / resumed inside a gesture) ----------
  const unlock = () => {
    if (root.classList.contains('hidden')) return;
    if (!engine.unlocked || engine.actx?.state !== 'running') engine.unlockAudio();
  };
  for (const type of ['pointerup', 'touchend', 'keydown']) addEventListener(type, unlock, true);

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
