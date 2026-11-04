// Layers and History panels.
import { el, modal } from '../ui.js';
import { CONFIG } from '../config.js';
import { License } from '../license.js';
import { BLEND_MODES } from './doc.js';
import { iconEl } from '../icons.js';

const BLEND_LABELS = { normal: 'Normal', multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', darken: 'Darken', lighten: 'Lighten',
  'color-dodge': 'Color dodge', 'color-burn': 'Color burn', 'hard-light': 'Hard light', 'soft-light': 'Soft light', difference: 'Difference',
  exclusion: 'Exclusion', hue: 'Hue', saturation: 'Saturation', color: 'Color', luminosity: 'Luminosity' };

const COARSE = matchMedia('(pointer: coarse)');

// Long-press (touch / pen) calls fn; also covers Android's long-press contextmenu. The click that
// follows a long-press is swallowed so it doesn't also activate the row.
function onLongPress(node, fn) {
  let timer = 0, sx = 0, sy = 0, fired = false, type = 'mouse';
  const stop = () => { clearTimeout(timer); timer = 0; };
  const fire = () => { stop(); fired = true; fn(); };
  node.addEventListener('pointerdown', (e) => {
    type = e.pointerType;
    fired = false;
    if (type === 'mouse') return;
    sx = e.clientX; sy = e.clientY;
    stop();
    timer = setTimeout(fire, 500);
  });
  node.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) stop(); });
  node.addEventListener('pointerup', stop);
  node.addEventListener('pointercancel', stop);
  node.addEventListener('contextmenu', (e) => {
    if (type === 'mouse') return;
    e.preventDefault();
    if (!fired) fire();
  });
  node.addEventListener('click', (e) => { if (fired) { fired = false; e.preventDefault(); e.stopPropagation(); } }, true);
}

function thumb(layer, doc) {
  const T = 36;
  const s = Math.min(T / doc.width, T / doc.height);
  const c = el('canvas', { class: 'pe-thumb checker', width: Math.max(1, Math.round(doc.width * s)), height: Math.max(1, Math.round(doc.height * s)) });
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(layer.canvas, 0, 0, c.width, c.height);
  return c;
}

export function createLayersPanel(ed) {
  const blend = el('select', { title: 'Blend mode', onchange: () => setProp('blend', blend.value, 'Blend mode') },
    BLEND_MODES.map((m) => el('option', { value: m }, BLEND_LABELS[m])));
  const opacityOut = el('output', {}, '100%');
  const opacity = el('input', { type: 'range', min: 0, max: 100, value: 100,
    oninput: () => { const l = ed.doc?.layer; if (!l) return; l.opacity = opacity.value / 100; opacityOut.textContent = `${opacity.value}%`; ed.doc.changed('pixels'); },
    onchange: () => ed.doc?.history.push('Layer opacity') });
  const list = el('div', { class: 'pe-layer-list' });
  const limit = el('div', { class: 'pe-small muted pe-limit' });
  const tbtn = (name, title, onclick) => el('button', { class: 'icon-btn', title, onclick }, iconEl(name));
  const bar = el('div', { class: 'pe-layer-bar' },
    tbtn('plus', 'New layer (Shift+Ctrl/Cmd+N)', () => ed.cmd('newLayer')),
    tbtn('copy', 'Duplicate layer (Ctrl/Cmd+J)', () => ed.cmd('duplicateLayer')),
    tbtn('merge', 'Merge down (Ctrl/Cmd+E)', () => ed.cmd('mergeDown')),
    tbtn('up', 'Move layer up', () => ed.cmd('layerUp')),
    tbtn('down', 'Move layer down', () => ed.cmd('layerDown')),
    el('div', { class: 'spacer' }),
    tbtn('trash', 'Delete layer', () => ed.cmd('deleteLayer')));

  function setProp(key, value, label) {
    const l = ed.doc?.layer;
    if (!l) return;
    l[key] = value;
    ed.doc.changed('layers');
    ed.doc.history.push(label);
  }

  let dragFrom = -1;

  function renameDialog(l) {
    const d = ed.doc;
    const input = el('input', { type: 'text', value: l.name, class: 'pe-rename-input', enterkeyhint: 'done', 'aria-label': 'Layer name' });
    const save = () => {
      const v = input.value.trim();
      dlg.close();
      if (v && v !== l.name && ed.doc === d && d.layers.includes(l)) { l.name = v; d.changed('layers'); d.history.push('Rename layer'); }
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); save(); } });
    const dlg = modal('Rename layer', el('div', { class: 'modal-body pe-dlg' }, input,
      el('div', { class: 'row' }, el('div', { class: 'spacer' }),
        el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: save }, iconEl('check', 16), 'Rename'))));
    input.focus();
    input.select();
  }

  // Layer actions sheet (long-press on a row).
  function actions(i) {
    const d = ed.doc;
    if (!d || !d.layers[i]) return;
    if (d.active !== i) { d.active = i; ed.emit('layers'); ed.render(); }
    const l = d.layers[i], top = d.layers.length - 1;
    const act = (iconName, label, fn, { disabled = false, danger = false } = {}) => el('button', {
      class: `btn pe-action${danger ? ' danger' : ''}`, disabled, onclick: () => { dlg.close(); fn(); } }, iconEl(iconName), label);
    const toggle = (key, on, off) => () => { l[key] = !l[key]; d.changed('layers'); d.history.push(l[key] ? on : off); };
    const dlg = modal(l.name, el('div', { class: 'modal-body pe-dlg pe-actions' },
      act('text', 'Rename', () => renameDialog(l)),
      act('copy', 'Duplicate', () => ed.cmd('duplicateLayer')),
      act('merge', 'Merge down', () => ed.cmd('mergeDown'), { disabled: i === 0 }),
      act('up', 'Move up', () => ed.cmd('layerUp'), { disabled: i === top }),
      act('down', 'Move down', () => ed.cmd('layerDown'), { disabled: i === 0 }),
      act(l.visible ? 'eyeOff' : 'eye', l.visible ? 'Hide' : 'Show', toggle('visible', 'Show layer', 'Hide layer')),
      act(l.locked ? 'unlock' : 'lock', l.locked ? 'Unlock' : 'Lock', toggle('locked', 'Lock layer', 'Unlock layer')),
      act('trash', 'Delete', () => ed.cmd('deleteLayer'), { disabled: d.layers.length <= 1, danger: true })));
  }

  function row(l, i) {
    const d = ed.doc;
    const name = el('span', { class: 'pe-layer-name', title: COARSE.matches ? 'Long-press for layer actions' : 'Double-click to rename' }, l.name);
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const input = el('input', { type: 'text', value: l.name, class: 'pe-rename' });
      const done = (save) => {
        if (save && input.value.trim() && input.value !== l.name) { l.name = input.value.trim(); d.changed('layers'); d.history.push('Rename layer'); }
        else render();
      };
      input.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); });
      input.addEventListener('blur', () => done(true));
      name.replaceWith(input);
      input.focus();
      input.select();
    });
    const r = el('div', { class: `pe-layer${i === d.active ? ' active' : ''}${l.visible ? '' : ' off'}`, draggable: !COARSE.matches,
      onclick: () => { if (d.active !== i) { d.active = i; ed.emit('layers'); ed.render(); } } },
      el('button', { class: 'icon-btn pe-eye', title: l.visible ? 'Hide layer' : 'Show layer',
        onclick: (e) => { e.stopPropagation(); l.visible = !l.visible; d.changed('layers'); d.history.push(l.visible ? 'Show layer' : 'Hide layer'); } }, iconEl(l.visible ? 'eye' : 'eyeOff')),
      thumb(l, d),
      name,
      l.blend !== 'normal' || l.opacity < 1 ? el('small', { class: 'muted' }, `${l.opacity < 1 ? `${Math.round(l.opacity * 100)}%` : ''} ${l.blend !== 'normal' ? BLEND_LABELS[l.blend] : ''}`.trim()) : null,
      el('button', { class: `icon-btn pe-lock${l.locked ? ' on' : ''}`, title: l.locked ? 'Unlock layer' : 'Lock layer',
        onclick: (e) => { e.stopPropagation(); l.locked = !l.locked; d.changed('layers'); d.history.push(l.locked ? 'Lock layer' : 'Unlock layer'); } }, iconEl(l.locked ? 'lock' : 'unlock')));
    r.addEventListener('dragstart', (e) => { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
    r.addEventListener('dragover', (e) => { if (dragFrom < 0) return; e.preventDefault(); r.classList.add('drop'); });
    r.addEventListener('dragleave', () => r.classList.remove('drop'));
    r.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      r.classList.remove('drop');
      if (dragFrom >= 0 && dragFrom !== i && d.moveLayer(dragFrom, i)) d.history.push('Reorder layers');
      dragFrom = -1;
    });
    r.addEventListener('dragend', () => { dragFrom = -1; });
    onLongPress(r, () => actions(i));
    return r;
  }

  function render() {
    const d = ed.doc;
    list.replaceChildren();
    if (!d) { limit.textContent = ''; return; }
    for (let i = d.layers.length - 1; i >= 0; i--) list.append(row(d.layers[i], i));
    const l = d.layer;
    blend.value = l.blend;
    opacity.value = Math.round(l.opacity * 100);
    opacityOut.textContent = `${opacity.value}%`;
    limit.replaceChildren(License.isPro() ? '' : el('span', {}, `${d.layers.length} / ${CONFIG.free.photoMaxLayers} layers on Free · `, el('span', { class: 'pro-badge' }, 'PRO'), ' unlimited'));
  }

  // Thumbnails refresh after every history step (pixel edits always end in one).
  ed.on('layers', render);
  ed.on('history', render);
  ed.on('doc', render);
  License.onChange(render);

  render();
  return el('div', { class: 'pe-layers' },
    el('div', { class: 'pe-layer-props' },
      el('label', { class: 'field' }, el('span', {}, 'Blend'), blend),
      el('label', { class: 'field' }, el('span', {}, 'Opacity'), opacity, opacityOut)),
    list, bar, limit);
}

export function createHistoryPanel(ed) {
  const list = el('div', { class: 'pe-history-list' });
  function render() {
    const h = ed.doc?.history;
    list.replaceChildren();
    if (!h) return;
    h.entries.forEach((e, i) => {
      list.append(el('div', { class: `pe-history-item${i === h.index ? ' active' : ''}${i > h.index ? ' future' : ''}`, onclick: () => { if (i !== h.index) h.go(i); } },
        el('span', { class: 'pe-history-n muted' }, String(i + 1)), e.label));
    });
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }
  ed.on('history', render);
  ed.on('doc', render);
  render();
  return el('div', { class: 'pe-history' }, list,
    el('div', { class: 'pe-small muted' }, `Keeps the last ${ed.doc?.history.max ?? 30} steps · tap or click a step to jump`));
}
