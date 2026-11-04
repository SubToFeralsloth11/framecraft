// FrameCraft Photo: Photoshop-style layered image editor. Entry point: mount(root).
import { el, toast } from '../ui.js';
import { License, requirePro } from '../license.js';
import { Doc } from './doc.js';
import { View } from './view.js';
import { makeCanvas } from './canvas.js';
import { iconEl } from '../icons.js';
import { paintTools } from './tools-paint.js';
import { selectTools } from './tools-select.js';
import { otherTools } from './tools-other.js';
import { createAdjustPanel } from './filters.js';
import { createLayersPanel, createHistoryPanel } from './panels.js';
import * as io from './io.js';

// Toolbar order (two columns).
const TOOL_ORDER = ['move', 'marquee', 'ellipse', 'lasso', 'wand', 'crop', 'eyedropper', 'text', 'brush', 'pencil', 'eraser', 'clone',
  'bucket', 'gradient', 'blur', 'dodge', 'smudge', 'shape', 'hand', 'zoom'];
const ALL_TOOLS = [...paintTools, ...selectTools, ...otherTools];
const TOOLS = Object.fromEntries(ALL_TOOLS.map((t) => [t.id, t]));

const COARSE = matchMedia('(pointer: coarse)');
const COMPACT = matchMedia('(max-width: 1100px)');
const PHONE = matchMedia('(max-width: 759px)');

// What the on-screen Shift / Alt toggles do per tool (shown on touch screens only).
const SEL_MODS = { shift: 'Add · square', alt: 'Subtract · center' };
const MOD_HELP = {
  marquee: SEL_MODS, ellipse: SEL_MODS,
  lasso: { shift: 'Add', alt: 'Subtract' }, wand: { shift: 'Add', alt: 'Subtract' },
  move: { shift: 'Straight' },
  brush: { shift: 'Line from last' }, pencil: { shift: 'Line from last' }, eraser: { shift: 'Line from last' },
  clone: { alt: 'Set source' },
  gradient: { shift: 'Snap 45°' },
  shape: { shift: 'Square / 45°', alt: 'From center' },
  eyedropper: { alt: 'Background' },
  zoom: { alt: 'Zoom out' },
};

const PANEL_NAMES = { layers: 'Layers', adjust: 'Adjustments & filters', history: 'History' };

// Commands in the overflow menu (compact layouts). [icon, label, command, needsDoc, pro]
const MORE_MENU = [
  ['File', [['file', 'New canvas', 'newDoc', false], ['open', 'Open image', 'open', false], ['image', 'Place image as layer', 'place'],
    ['open', 'Open project', 'openProject', false], ['save', 'Save project', 'saveProject', true, true], ['export', 'Export image', 'export']]],
  ['Edit', [['marquee', 'Select all', 'selectAll'], ['close', 'Deselect', 'deselect'], ['invert', 'Invert selection', 'invertSelection'],
    ['bucket', 'Fill with foreground', 'fillFg'], ['bucket', 'Fill with background', 'fillBg'], ['eraser', 'Delete pixels', 'clear']]],
  ['Layer', [['plus', 'New layer', 'newLayer'], ['copy', 'Duplicate layer', 'duplicateLayer'], ['merge', 'Merge down', 'mergeDown'], ['layers', 'Flatten image', 'flatten']]],
  ['Image', [['resize', 'Image size', 'imageSize'], ['canvas', 'Canvas size', 'canvasSize'], ['rotL', 'Rotate 90° left', 'rotL'],
    ['rotR', 'Rotate 90° right', 'rotR'], ['rotR', 'Rotate 180°', 'rot180'], ['flipH', 'Flip horizontal', 'flipH'], ['flipV', 'Flip vertical', 'flipV']]],
  ['View & colors', [['fit', 'Fit on screen', 'fit'], ['zoom', 'Actual pixels (100%)', 'actual'],
    ['swap', 'Swap colors', 'swapColors', false], ['contrast', 'Default colors', 'resetColors', false]]],
];

function createEditor(root) {
  const listeners = new Map();
  const scratch = new Map();
  let busyCount = 0, busyTimer = 0;

  const ed = {
    root,
    doc: null,
    view: null,
    tool: 'brush',
    toolObj: null,
    opts: Object.fromEntries(ALL_TOOLS.map((t) => [t.id, structuredClone(t.defaults || {})])),
    fg: '#000000',
    bg: '#ffffff',
    session: null,
    lastPaint: null,
    cloneSource: null,
    mods: { shift: false, alt: false }, // on-screen Shift / Alt toggles for touch

    setMod(key, on) { ed.mods[key] = on; ed.emit('mods'); },

    on(ev, cb) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(cb); },
    emit(ev, ...args) { listeners.get(ev)?.forEach((cb) => cb(...args)); },
    render() { ed.view?.render(); },

    // Reusable document-sized canvases, cleared on each request.
    scratch(name) {
      const { width: w, height: h } = ed.doc;
      let s = scratch.get(name);
      if (!s || s.canvas.width !== w || s.canvas.height !== h) {
        const c = makeCanvas(w, h);
        s = { canvas: c, ctx: c.getContext('2d') };
        scratch.set(name, s);
      } else {
        s.ctx.setTransform(1, 0, 0, 1, 0, 0);
        s.ctx.globalAlpha = 1;
        s.ctx.globalCompositeOperation = 'source-over';
        s.ctx.clearRect(0, 0, w, h);
      }
      return s;
    },

    editableLayer() {
      const l = ed.doc?.layer;
      if (!l) return null;
      if (l.locked) { toast(`“${l.name}” is locked`, 'warn'); return null; }
      if (!l.visible) { toast(`“${l.name}” is hidden. Show it to edit.`, 'warn'); return null; }
      return l;
    },

    setColor(which, color) { ed[which] = color; ed.emit('colors'); },

    busy(on, label = 'Working') {
      const box = ed.busyBox;
      if (on) {
        busyCount++;
        box.querySelector('span').textContent = `${label}…`;
        clearTimeout(busyTimer);
        busyTimer = setTimeout(() => box.classList.remove('hidden'), 180);
      } else if (--busyCount <= 0) {
        busyCount = 0;
        clearTimeout(busyTimer);
        box.classList.add('hidden');
      }
    },

    newDoc(w, h, fill, { name, image, layers, active } = {}) {
      ed.toolObj?.deactivate?.(ed);
      if (ed.session) ed.cancelSession();
      const d = new Doc(w, h, (kind) => notify(d, kind));
      d.name = name || 'Untitled';
      if (layers) {
        for (const spec of layers) {
          const l = d.addLayer(spec.name, d.layers.length, { force: true });
          Object.assign(l, { visible: spec.visible, opacity: spec.opacity, blend: spec.blend, locked: spec.locked });
          l.ctx.drawImage(spec.image, 0, 0);
        }
        d.active = Math.max(0, Math.min(d.layers.length - 1, active ?? d.layers.length - 1));
      } else {
        const l = d.addLayer(image ? name || 'Image' : 'Background', 0, { force: true });
        if (fill) { l.ctx.fillStyle = fill; l.ctx.fillRect(0, 0, w, h); }
        if (image) { l.ctx.imageSmoothingQuality = 'high'; l.ctx.drawImage(image, 0, 0, w, h); }
      }
      d.history.push(layers ? 'Open project' : image ? 'Open image' : 'New canvas');
      d.dirty = false;
      ed.doc = d;
      scratch.clear();
      ed.lastPaint = null;
      ed.cloneSource = null;
      ed.emit('doc');
      ed.view.fit();
      ed.toolObj?.activate?.(ed);
      ed.render();
    },

    setTool(id) {
      const t = TOOLS[id];
      if (!t) return;
      if (t.pro && !requirePro(t.name)) return;
      if (ed.toolObj && ed.toolObj !== t) ed.toolObj.deactivate?.(ed);
      ed.tool = id;
      ed.toolObj = t;
      if (ed.mods.shift || ed.mods.alt) { ed.mods = { shift: false, alt: false }; ed.emit('mods'); }
      ed.view.canvas.style.cursor = t.cursor || 'default';
      t.activate?.(ed);
      ed.emit('tool');
      ed.render();
    },

    pointer(type, e, p) {
      if (!ed.doc) return;
      if (ed.session) {
        if (type === 'down' && !ed.sessionPick?.(p)) toast('Apply or cancel the adjustment first', 'warn');
        return;
      }
      const t = ed.toolObj;
      const m = ed.mods;
      if (m.shift || m.alt) {
        e = { clientX: e.clientX, clientY: e.clientY, button: e.button, pointerId: e.pointerId, pointerType: e.pointerType,
          metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey || m.shift, altKey: e.altKey || m.alt };
      }
      if (type === 'down') t.down?.(ed, e, p);
      else if (type === 'move') t.move?.(ed, e, p);
      else if (type === 'up') t.up?.(ed, e, p);
      else if (type === 'hover') t.hover?.(ed, e, p);
      ed.render();
    },

    // A second finger landed mid-stroke: undo the stroke in progress without a history step.
    abortPointer() {
      if (!ed.doc || ed.session) return;
      ed.toolObj?.abort?.(ed);
      ed.render();
    },

    cmd(name, ...args) { return commands[name]?.(...args); },
  };

  function notify(d, kind) {
    if (d !== ed.doc && ed.doc) return;
    if (kind === 'layers') ed.emit('layers');
    else if (kind === 'history') ed.emit('history');
    else if (kind === 'size') { scratch.clear(); ed.emit('size'); }
    ed.render();
  }

  const needDoc = (fn) => (...a) => (ed.doc ? fn(ed.doc, ...a) : undefined);
  const beforeEdit = () => {
    if (ed.session) ed.cancelSession();
    if (ed.tool === 'text') TOOLS.text.cancel(ed);
  };

  function fillSelection(d, color) {
    const l = ed.editableLayer();
    if (!l) return;
    const sel = d.selection;
    if (sel.active) {
      const t = ed.scratch('tmp');
      t.ctx.fillStyle = color;
      t.ctx.fillRect(0, 0, d.width, d.height);
      t.ctx.globalCompositeOperation = 'destination-in';
      t.ctx.drawImage(sel.canvas, 0, 0);
      l.ctx.drawImage(t.canvas, 0, 0);
    } else {
      l.ctx.fillStyle = color;
      l.ctx.fillRect(0, 0, d.width, d.height);
    }
    d.commit('Fill');
  }

  const commands = {
    newDoc: () => io.newDocDialog(ed),
    open: () => io.openDialog(ed),
    place: needDoc(() => io.placeDialog(ed)),
    openProject: () => io.openProjectDialog(ed),
    saveProject: needDoc(() => io.saveProject(ed)),
    export: needDoc(() => io.exportDialog(ed)),
    imageSize: needDoc(() => { beforeEdit(); io.imageSizeDialog(ed); }),
    canvasSize: needDoc(() => { beforeEdit(); io.canvasSizeDialog(ed); }),
    rotL: needDoc(() => { beforeEdit(); io.rotate(ed, -90); }),
    rotR: needDoc(() => { beforeEdit(); io.rotate(ed, 90); }),
    rot180: needDoc(() => { beforeEdit(); io.rotate(ed, 180); }),
    flipH: needDoc(() => { beforeEdit(); io.flip(ed, true); }),
    flipV: needDoc(() => { beforeEdit(); io.flip(ed, false); }),
    undo: needDoc((d) => { beforeEdit(); d.history.undo(); }),
    redo: needDoc((d) => { beforeEdit(); d.history.redo(); }),
    selectAll: needDoc((d) => d.selection.all()),
    deselect: needDoc((d) => d.selection.clear()),
    invertSelection: needDoc((d) => d.selection.invert()),
    clear: needDoc((d) => {
      const l = ed.editableLayer();
      if (!l) return;
      if (d.selection.active) {
        l.ctx.save();
        l.ctx.globalCompositeOperation = 'destination-out';
        l.ctx.drawImage(d.selection.canvas, 0, 0);
        l.ctx.restore();
      } else l.ctx.clearRect(0, 0, d.width, d.height);
      d.commit('Delete pixels');
    }),
    fillFg: needDoc((d) => fillSelection(d, ed.fg)),
    fillBg: needDoc((d) => fillSelection(d, ed.bg)),
    newLayer: needDoc((d) => { beforeEdit(); if (d.addLayer()) d.history.push('New layer'); }),
    duplicateLayer: needDoc((d) => { beforeEdit(); if (d.duplicateLayer()) d.history.push('Duplicate layer'); }),
    deleteLayer: needDoc((d) => {
      beforeEdit();
      if (d.layers.length <= 1) { toast('An image needs at least one layer', 'warn'); return; }
      if (d.deleteLayer()) d.history.push('Delete layer');
    }),
    mergeDown: needDoc((d) => { beforeEdit(); if (d.mergeDown()) d.history.push('Merge down'); else toast('No layer below to merge into', 'warn'); }),
    flatten: needDoc((d) => {
      beforeEdit();
      if (d.layers.length < 2) return;
      const flat = d.flatten();
      d.layers.splice(0, d.layers.length);
      d.active = 0;
      const l = d.addLayer('Background', 0, { force: true });
      l.ctx.drawImage(flat, 0, 0);
      d.history.push('Flatten image');
    }),
    layerUp: needDoc((d) => { beforeEdit(); if (d.moveLayer(d.active, d.active + 1)) d.history.push('Move layer up'); }),
    layerDown: needDoc((d) => { beforeEdit(); if (d.moveLayer(d.active, d.active - 1)) d.history.push('Move layer down'); }),
    fit: needDoc(() => ed.view.fit()),
    actual: needDoc(() => ed.view.actual()),
    zoomIn: needDoc(() => ed.view.zoomStep(1)),
    zoomOut: needDoc(() => ed.view.zoomStep(-1)),
    swapColors: () => { [ed.fg, ed.bg] = [ed.bg, ed.fg]; ed.emit('colors'); },
    resetColors: () => { ed.fg = '#000000'; ed.bg = '#ffffff'; ed.emit('colors'); },
  };

  return ed;
}

// ---------- layout pieces ----------

function moreMenu(ed) {
  const pop = el('div', { class: 'pe-more hidden', role: 'menu' });
  const btn = el('button', { class: 'pe-mbtn pe-m-more pe-m-keep', title: 'More commands', 'aria-label': 'More commands', 'aria-haspopup': 'menu',
    onclick: () => (pop.classList.contains('hidden') ? show() : hide()) }, iconEl('more'));
  btn.needsDoc = false;
  const hide = () => pop.classList.add('hidden');
  function show() {
    pop.replaceChildren(...MORE_MENU.flatMap(([title, items]) => [
      el('div', { class: 'pe-more-sec' }, title),
      ...items.map(([iconName, label, cmd, needsDoc = true, pro]) => el('button', {
        class: 'pe-more-item', role: 'menuitem', disabled: needsDoc && !ed.doc, onclick: () => { hide(); ed.cmd(cmd); } },
      iconEl(iconName), el('span', {}, label), pro ? el('span', { class: 'pro-badge' }, 'PRO') : null)),
    ]));
    pop.classList.remove('hidden');
  }
  document.addEventListener('pointerdown', (e) => { if (!pop.contains(e.target) && !btn.contains(e.target)) hide(); }, true);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  ed.on('doc', hide);
  return { btn, pop };
}

function menuBar(ed) {
  const b = (iconName, label, cmd, { title, pro, needsDoc = true, cls } = {}) => {
    const btn = el('button', { class: `pe-mbtn${cls ? ` ${cls}` : ''}`, title: title || label, 'aria-label': title || label, onclick: () => ed.cmd(cmd) },
      iconEl(iconName), label ? el('span', {}, label) : null, pro ? el('span', { class: 'pro-badge' }, 'PRO') : null);
    btn.needsDoc = needsDoc;
    return btn;
  };
  const undo = b('undo', '', 'undo', { title: 'Undo (Ctrl/Cmd+Z)', cls: 'pe-m-keep pe-m-undo' });
  const redo = b('redo', '', 'redo', { title: 'Redo (Shift+Ctrl/Cmd+Z)', cls: 'pe-m-keep pe-m-redo' });
  const more = moreMenu(ed);
  const panels = el('button', { class: 'pe-mbtn pe-m-panels', title: 'Show or hide panels', 'aria-label': 'Show or hide panels', onclick: () => ed.setPanel(ed.panelTab() ? '' : 'layers') },
    iconEl('layers'), el('span', {}, 'Panels'));
  panels.needsDoc = false;
  const bar = el('div', { class: 'pe-menu' },
    b('file', 'New', 'newDoc', { needsDoc: false, title: 'New canvas' }),
    b('open', 'Open', 'open', { needsDoc: false, title: 'Open image or project (Ctrl/Cmd+O)', cls: 'pe-m-keep pe-m-open' }),
    b('image', 'Place', 'place', { title: 'Add an image as a new layer' }),
    el('div', { class: 'pe-msep' }),
    b('open', 'Open project', 'openProject', { needsDoc: false, title: 'Open a .fcphoto project' }),
    b('save', 'Save project', 'saveProject', { pro: true, title: 'Save layered .fcphoto project (Ctrl/Cmd+S)' }),
    b('export', 'Export', 'export', { title: 'Export PNG / JPG / WebP (Shift+Ctrl/Cmd+S)', cls: 'pe-m-keep pe-m-export' }),
    el('div', { class: 'pe-msep' }),
    undo, redo,
    el('div', { class: 'pe-msep' }),
    b('resize', 'Image size', 'imageSize'),
    b('canvas', 'Canvas size', 'canvasSize'),
    b('rotL', '', 'rotL', { title: 'Rotate 90° counter-clockwise' }),
    b('rotR', '', 'rotR', { title: 'Rotate 90° clockwise' }),
    b('flipH', '', 'flipH', { title: 'Flip horizontal' }),
    b('flipV', '', 'flipV', { title: 'Flip vertical' }),
    el('div', { class: 'pe-msep' }),
    b('merge', 'Flatten', 'flatten', { title: 'Flatten all layers into one' }),
    panels, more.btn);
  bar.pop = more.pop;
  const update = () => {
    bar.querySelectorAll('.pe-mbtn').forEach((x) => { x.disabled = x.needsDoc && !ed.doc; });
    undo.disabled = !ed.doc?.history.canUndo;
    redo.disabled = !ed.doc?.history.canRedo;
  };
  ed.on('doc', update);
  ed.on('history', update);
  update();
  return bar;
}

// On-screen Shift / Alt toggles for touch screens.
function modToggles(ed, help) {
  const btn = (key, label) => el('button', { class: `pe-mod${ed.mods[key] ? ' active' : ''}`, 'data-k': key, 'aria-pressed': String(!!ed.mods[key]),
    title: `${label} (${help[key]})`, onclick: () => ed.setMod(key, !ed.mods[key]) }, el('b', {}, label), el('small', {}, help[key]));
  return el('div', { class: 'pe-mods' }, help.shift ? btn('shift', 'Shift') : null, help.alt ? btn('alt', 'Alt') : null);
}

function optionsBar(ed) {
  const bar = el('div', { class: 'pe-options' });
  const render = () => {
    const t = ed.toolObj;
    if (!t) return;
    const mods = COARSE.matches && MOD_HELP[t.id] ? modToggles(ed, MOD_HELP[t.id]) : null;
    bar.replaceChildren(...[el('div', { class: 'pe-opt-tool' }, iconEl(t.icon), el('b', {}, t.name), t.pro ? el('span', { class: 'pro-badge' }, 'PRO') : null), mods, ...(t.options?.(ed) || [])].filter(Boolean));
  };
  ed.on('tool', render);
  ed.on('resyncOptions', render);
  ed.on('mods', () => bar.querySelectorAll('.pe-mod').forEach((b) => {
    const on = !!ed.mods[b.dataset.k];
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }));
  COARSE.addEventListener('change', render);
  return bar;
}

function toolBar(ed) {
  const grid = el('div', { class: 'pe-tool-grid' });
  const buttons = {};
  for (const id of TOOL_ORDER) {
    const t = TOOLS[id];
    buttons[id] = el('button', { class: 'tool-btn', title: `${t.name} (${t.key})${t.pro ? ' · Pro' : ''}`, 'aria-label': t.name, onclick: () => ed.setTool(id) },
      iconEl(t.icon), t.pro ? el('span', { class: 'pe-tool-pro' }) : null);
    grid.append(buttons[id]);
  }
  ed.on('tool', () => Object.entries(buttons).forEach(([id, b]) => {
    b.classList.toggle('active', id === ed.tool);
    if (id === ed.tool && PHONE.matches) {
      // Keep the active tool visible in the phone tool strip (scrollIntoView could also scroll the page).
      const g = grid.getBoundingClientRect(), r = b.getBoundingClientRect();
      if (r.left < g.left || r.right > g.right) grid.scrollLeft += r.left - g.left - (g.width - r.width) / 2;
    }
  }));

  const fgInput = el('input', { type: 'color', value: ed.fg, oninput: () => ed.setColor('fg', fgInput.value) });
  const bgInput = el('input', { type: 'color', value: ed.bg, oninput: () => ed.setColor('bg', bgInput.value) });
  const fg = el('button', { class: 'pe-swatch fg', title: 'Foreground color', onclick: () => fgInput.click() });
  const bg = el('button', { class: 'pe-swatch bg', title: 'Background color', onclick: () => bgInput.click() });
  const sync = () => { fg.style.background = ed.fg; bg.style.background = ed.bg; fgInput.value = ed.fg; bgInput.value = ed.bg; };
  ed.on('colors', sync);
  sync();
  const swatches = el('div', { class: 'pe-swatches' }, bg, fg, fgInput, bgInput,
    el('button', { class: 'pe-swap', title: 'Swap colors (X)', onclick: () => ed.cmd('swapColors') }, iconEl('swap')),
    el('button', { class: 'pe-reset', title: 'Default colors (D)', onclick: () => ed.cmd('resetColors') }, el('i'), el('i')));
  return el('div', { class: 'pe-tools' }, grid, swatches);
}

function statusBar(ed) {
  const zoomOut = el('button', { class: 'icon-btn', title: 'Zoom out (-)', 'aria-label': 'Zoom out', onclick: () => ed.cmd('zoomOut') }, iconEl('minus', 16));
  const zoomIn = el('button', { class: 'icon-btn', title: 'Zoom in (+)', 'aria-label': 'Zoom in', onclick: () => ed.cmd('zoomIn') }, iconEl('plus', 16));
  const pct = el('button', { class: 'pe-zoom', title: 'Click: fit on screen (Ctrl/Cmd+0)', onclick: () => ed.cmd('fit') }, '100%');
  const fit = el('button', { class: 'icon-btn pe-fit', title: 'Fit on screen (Ctrl/Cmd+0)', 'aria-label': 'Fit on screen', onclick: () => ed.cmd('fit') }, iconEl('fit', 16));
  const size = el('span', { class: 'muted pe-size' });
  const pos = el('span', { class: 'muted pe-pos' });
  const bar = el('div', { class: 'pe-status' }, zoomOut, pct, zoomIn, fit, el('span', { class: 'pe-ssep' }), size, pos);
  const update = () => {
    bar.classList.toggle('hidden', !ed.doc);
    if (!ed.doc) return;
    pct.textContent = `${Math.round(ed.view.zoom * 1000) / 10}%`;
    size.textContent = `${ed.doc.width} × ${ed.doc.height} px`;
  };
  ed.on('view', update);
  ed.on('doc', update);
  ed.on('size', update);
  ed.on('cursor', (p) => { pos.textContent = ed.doc ? `${Math.floor(p.x)}, ${Math.floor(p.y)}` : ''; });
  update();
  return bar;
}

function welcome(ed) {
  const box = el('div', { class: 'pe-welcome' },
    el('div', { class: 'pe-welcome-card' },
      el('h1', {}, 'FrameCraft Photo'),
      el('p', { class: 'muted' }, 'Layers, selections, brushes, filters. Everything runs in your browser, and your files never leave your computer.'),
      el('div', { class: 'row pe-welcome-actions' },
        el('button', { class: 'btn primary', onclick: () => ed.cmd('open') }, iconEl('image'), 'Open image'),
        el('button', { class: 'btn', onclick: () => ed.cmd('openProject') }, iconEl('open'), 'Open project')),
      el('div', { class: 'pe-sub' }, 'New canvas'),
      io.newDocForm(ed),
      el('p', { class: 'muted pe-small pe-tip' }, 'Tip: drag an image anywhere here, or paste one with Ctrl/Cmd+V.')));
  ed.on('doc', () => box.classList.toggle('hidden', !!ed.doc));
  return box;
}

function panel(title, body, cls) {
  const sec = el('section', { class: `panel pe-panel ${cls}` });
  const head = el('button', { class: 'panel-title pe-panel-title', onclick: () => sec.classList.toggle('collapsed') }, title);
  sec.append(head, el('div', { class: 'pe-panel-body' }, body));
  return sec;
}

// Right column on desktop; overlay drawer on tablets; bottom sheet (one panel at a time) on phones.
function sidePanels(ed, root) {
  const tabTitle = el('span', { class: 'pe-side-tab' });
  const close = el('button', { class: 'icon-btn pe-side-close', title: 'Close panels', 'aria-label': 'Close panels', onclick: () => setPanel('') }, iconEl('close'));
  const head = el('div', { class: 'pe-side-head' },
    el('i', { class: 'pe-sheet-handle', 'aria-hidden': 'true' }),
    el('b', { class: 'pe-side-title' }, tabTitle, el('span', { class: 'pe-side-all' }, 'Panels')),
    close);
  const side = el('div', { class: 'pe-side' }, head,
    panel('Layers', createLayersPanel(ed), 'pe-p-layers'),
    panel('Adjustments & filters', createAdjustPanel(ed), 'pe-p-adjust'),
    panel('History', createHistoryPanel(ed), 'pe-p-history'));

  let tab = '';
  function setPanel(t) {
    if (!t && ed.session && COMPACT.matches) { toast('Apply or cancel the adjustment first', 'warn'); return; }
    tab = t;
    root.classList.toggle('pe-panels-open', !!t);
    root.dataset.sheet = t;
    tabTitle.textContent = PANEL_NAMES[t] || '';
    if (!t) root.style.removeProperty('--pe-sheet-h');
    side.scrollTop = 0;
    ed.emit('panels');
  }
  ed.setPanel = setPanel;
  ed.panelTab = () => tab;
  ed.togglePanel = (t) => setPanel(tab === t ? '' : t);

  // Phone sheet: drag the header to resize; drag it most of the way down to close.
  head.addEventListener('pointerdown', (e) => {
    if (!PHONE.matches || close.contains(e.target) || e.button > 0) return;
    e.preventDefault();
    head.setPointerCapture(e.pointerId);
    const H = root.clientHeight, h0 = side.getBoundingClientRect().height, y0 = e.clientY;
    let raw = h0;
    const move = (ev) => {
      raw = h0 - (ev.clientY - y0);
      root.style.setProperty('--pe-sheet-h', `${Math.round(Math.max(H * 0.2, Math.min(H * 0.85, raw)))}px`);
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
      if (raw < H * 0.22 && !ed.session) setPanel('');
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });
  return side;
}

// Phone bottom bar: opens the panel sheet.
function dock(ed) {
  const b = (t, iconName, label) => el('button', { class: 'pe-dock-btn', 'data-tab': t, 'aria-label': PANEL_NAMES[t], onclick: () => ed.togglePanel(t) },
    iconEl(iconName, 20), el('span', {}, label));
  const bar = el('div', { class: 'pe-dock' }, b('layers', 'layers', 'Layers'), b('adjust', 'sliders', 'Adjust'), b('history', 'history', 'History'));
  ed.on('panels', () => bar.querySelectorAll('.pe-dock-btn').forEach((x) => x.classList.toggle('active', x.dataset.tab === ed.panelTab())));
  return bar;
}

// ---------- keyboard, drop, paste ----------

function isTyping(t) {
  if (!t || !t.closest) return false;
  if (t.closest('textarea, select, [contenteditable=""], [contenteditable="true"]')) return true;
  return t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'color'].includes(t.type);
}

function bindKeys(ed, isActive) {
  const keyTools = {};
  for (const id of TOOL_ORDER) (keyTools[TOOLS[id].key.toLowerCase()] ??= []).push(id);

  window.addEventListener('keydown', (e) => {
    if (!isActive() || document.querySelector('.modal-wrap') || isTyping(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    const handled = () => { e.preventDefault(); e.stopPropagation(); };

    if (ed.session) {
      if (e.key === 'Enter') { handled(); ed.applySession(); }
      else if (e.key === 'Escape') { handled(); ed.cancelSession(); }
      return;
    }
    if (e.code === 'Space' && !mod) {
      handled();
      if (!ed.view.spaceDown) { ed.view.spaceDown = true; ed.view.host.classList.add('space'); }
      return;
    }
    if (mod) {
      const map = {
        z: e.shiftKey ? 'redo' : 'undo', y: 'redo', a: 'selectAll', d: 'deselect', o: e.shiftKey ? 'openProject' : 'open',
        s: e.shiftKey ? 'export' : 'saveProject', j: 'duplicateLayer', e: e.shiftKey ? 'flatten' : 'mergeDown',
        0: 'fit', 1: 'actual', '=': 'zoomIn', '+': 'zoomIn', '-': 'zoomOut', backspace: 'fillBg', delete: 'fillBg',
      };
      let c = map[k];
      if (k === 'i' && e.shiftKey) c = 'invertSelection';
      if (k === 'n' && e.shiftKey) c = 'newLayer';
      if (k === 'n' && e.altKey) c = 'newDoc';
      if (c) { handled(); ed.cmd(c); }
      return;
    }
    if (!ed.doc) return;
    if (ed.toolObj?.keydown?.(ed, e)) { handled(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { handled(); ed.cmd(e.altKey ? 'fillFg' : 'clear'); return; }
    if (e.key === '[' || e.key === ']') {
      const o = ed.opts[ed.tool];
      if (o && 'size' in o && typeof o.size === 'number') {
        handled();
        const step = o.size < 10 ? 1 : o.size < 50 ? 5 : o.size < 200 ? 10 : 25;
        o.size = Math.max(1, Math.min(1000, o.size + (e.key === ']' ? step : -step)));
        ed.emit('resyncOptions');
        ed.render();
      }
      return;
    }
    if (e.key === '+' || e.key === '=') { handled(); ed.cmd('zoomIn'); return; }
    if (e.key === '-' || e.key === '_') { handled(); ed.cmd('zoomOut'); return; }
    if (k === 'x' && !e.altKey) { handled(); ed.cmd('swapColors'); return; }
    if (k === 'd' && !e.altKey) { handled(); ed.cmd('resetColors'); return; }
    if (e.key === 'Escape' && ed.doc.selection.active) { handled(); ed.cmd('deselect'); return; }
    const group = keyTools[k];
    if (group && !e.altKey) {
      handled();
      const i = group.indexOf(ed.tool);
      ed.setTool(group[i >= 0 ? (i + 1) % group.length : 0]);
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && ed.view.spaceDown) { ed.view.spaceDown = false; ed.view.host.classList.remove('space'); }
  });
  window.addEventListener('blur', () => { ed.view.spaceDown = false; ed.view.host.classList.remove('space'); });
}

async function handleFiles(ed, files) {
  for (const f of files) {
    if (f.name?.endsWith('.fcphoto')) { await io.openProject(ed, f); continue; }
    if (!f.type.startsWith('image/')) { toast(`${f.name} is not an image`, 'warn'); continue; }
    if (!ed.doc) await io.openImageFile(ed, f);
    else await io.placeImageFile(ed, f);
  }
}

function bindDropPaste(ed, host, isActive) {
  host.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    host.classList.add('drop');
  });
  host.addEventListener('dragleave', (e) => { if (!host.contains(e.relatedTarget)) host.classList.remove('drop'); });
  host.addEventListener('drop', (e) => {
    host.classList.remove('drop');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    if (ed.session) ed.cancelSession();
    handleFiles(ed, files);
  });
  document.addEventListener('paste', (e) => {
    if (!isActive() || isTyping(e.target) || document.querySelector('.modal-wrap')) return;
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    if (ed.session) ed.cancelSession();
    handleFiles(ed, files.map((f) => (f.name && f.name !== 'image.png' ? f : new File([f], 'Pasted image.png', { type: f.type }))));
  });
}

// ---------- mount ----------

export function mount(root) {
  root.classList.add('pe');
  root.replaceChildren();
  const ed = createEditor(root);

  const host = el('div', { class: 'pe-viewport' });
  ed.view = new View(ed, host);
  ed.busyBox = el('div', { class: 'pe-busy hidden' }, el('i', { class: 'pe-spinner' }), el('span', {}, 'Working…'));
  host.append(welcome(ed), statusBar(ed), ed.busyBox);

  const side = sidePanels(ed, root);
  const menu = menuBar(ed);
  root.append(menu, optionsBar(ed), toolBar(ed), host, side, dock(ed), menu.pop);

  for (const t of ALL_TOOLS) t.init?.(ed);
  ed.on('session', () => {
    root.classList.toggle('pe-session', !!ed.session);
    // Compact layouts: show the adjustment controls in the sheet / drawer, canvas preview stays visible.
    if (ed.session && COMPACT.matches && ed.panelTab() !== 'adjust') ed.setPanel('adjust');
  });
  const syncCompact = () => { ed.view.keepCenter = COMPACT.matches || COARSE.matches; };
  COMPACT.addEventListener('change', syncCompact);
  syncCompact();
  License.onChange(() => ed.emit('resyncOptions'));
  ed.on('size', () => { ed.view.fit(); if (ed.tool === 'crop') TOOLS.crop.reset(ed); });

  let active = !root.classList.contains('hidden');
  window.addEventListener('fc:mode', (e) => {
    active = e.detail?.mode === 'photo';
    if (!active) { ed.view.spaceDown = false; if (ed.tool === 'text') TOOLS.text.commit(ed); }
    else requestAnimationFrame(() => ed.view.resize());
  });
  const isActive = () => active && !root.classList.contains('hidden');
  bindKeys(ed, isActive);
  bindDropPaste(ed, host, isActive);

  ed.setTool('brush');
  ed.emit('doc');
  return ed;
}
