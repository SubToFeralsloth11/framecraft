// Compact option widgets for the tool options bar. Values live in ed.opts[toolId][key].
import { el } from '../ui.js';
import { iconEl } from '../icons.js';

const get = (ed, tool, key) => ed.opts[tool][key];
function set(ed, tool, key, v) {
  ed.opts[tool][key] = v;
  ed.emit('opts', tool, key);
}

export function optRange(ed, tool, key, label, { min = 0, max = 100, step = 1, unit = '' } = {}) {
  const num = el('input', { type: 'number', min, max, step, value: get(ed, tool, key), class: 'pe-num' });
  const range = el('input', { type: 'range', min, max, step, value: get(ed, tool, key) });
  const apply = (v) => {
    v = Math.max(min, Math.min(max, +v || 0));
    set(ed, tool, key, v);
    range.value = v; num.value = v;
  };
  range.addEventListener('input', () => apply(range.value));
  num.addEventListener('change', () => apply(num.value));
  const node = el('label', { class: 'pe-opt' }, el('span', {}, label), range, num, unit ? el('small', { class: 'muted' }, unit) : null);
  // Keep in sync when changed elsewhere (e.g. [ and ] shortcuts).
  node.sync = () => { range.value = num.value = get(ed, tool, key); };
  node.dataset.key = key;
  return node;
}

export function optSelect(ed, tool, key, label, options) {
  const s = el('select', { onchange: () => set(ed, tool, key, s.value) },
    options.map(([v, t]) => el('option', { value: v, selected: v === get(ed, tool, key) }, t)));
  return el('label', { class: 'pe-opt' }, label ? el('span', {}, label) : null, s);
}

export function optCheck(ed, tool, key, label) {
  const c = el('input', { type: 'checkbox', checked: !!get(ed, tool, key), onchange: () => set(ed, tool, key, c.checked) });
  return el('label', { class: 'pe-opt check' }, c, el('span', {}, label));
}

export function optColor(ed, tool, key, label) {
  const c = el('input', { type: 'color', value: get(ed, tool, key), oninput: () => set(ed, tool, key, c.value) });
  return el('label', { class: 'pe-opt' }, el('span', {}, label), c);
}

// Segmented buttons: options = [[value, label, title?], ...]
export function optSeg(ed, tool, key, options, label) {
  const wrap = el('div', { class: 'pe-seg' });
  const render = () => wrap.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === String(get(ed, tool, key))));
  for (const [v, t, title] of options) {
    wrap.append(el('button', { 'data-v': String(v), title: title || '', 'aria-label': title || null, onclick: () => { set(ed, tool, key, v); render(); } }, t));
  }
  render();
  return label ? el('div', { class: 'pe-opt' }, el('span', {}, label), wrap) : wrap;
}

export function selModeSeg(ed, tool) {
  return optSeg(ed, tool, 'mode', [
    ['replace', iconEl('selNew', 16), 'New selection'],
    ['add', iconEl('selAdd', 16), 'Add to selection (Shift)'],
    ['subtract', iconEl('selSub', 16), 'Subtract from selection (Alt/Option)'],
    ['intersect', iconEl('selIntersect', 16), 'Intersect with selection (Shift+Alt)'],
  ]);
}

// Resolve selection mode from modifier keys, falling back to the options bar choice.
export function modeFromEvent(e, fallback) {
  if (e.shiftKey && e.altKey) return 'intersect';
  if (e.shiftKey) return 'add';
  if (e.altKey) return 'subtract';
  return fallback;
}

export function sep() { return el('div', { class: 'pe-sep' }); }
export function hint(text) { return el('span', { class: 'pe-hint muted' }, text); }
export function optButton(label, onclick, attrs = {}) { return el('button', { class: 'btn', onclick, ...attrs }, label); }
