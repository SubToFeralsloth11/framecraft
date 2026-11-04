// Small shared UI helpers used by the shell and both editors.

import { iconEl } from './icons.js';

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'value') continue; // applied last so min/max/step are already set on ranges
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  if (attrs.value != null) node.value = attrs.value;
  for (const c of children.flat(Infinity)) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

let toastBox;
export function toast(message, kind = 'info', ms = 2600) {
  toastBox ??= document.body.appendChild(el('div', { class: 'toasts' }));
  const t = toastBox.appendChild(el('div', { class: `toast ${kind}` }, message));
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

// Modal dialog. `body` is a Node; returns { close }.
export function modal(title, body, { onClose } = {}) {
  const close = () => { wrap.remove(); onClose?.(); };
  const wrap = el('div', { class: 'modal-wrap', onpointerdown: (e) => e.target === wrap && close() },
    el('div', { class: 'modal', role: 'dialog', 'aria-label': title },
      el('div', { class: 'modal-head' }, el('h2', {}, title), el('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close', onclick: close }, iconEl('close'))),
      body));
  document.body.append(wrap);
  return { close };
}

// Labeled range slider row: returns the row; calls onInput(number).
export function slider(label, { min = 0, max = 100, step = 1, value = 0, onInput, format = (v) => v } = {}) {
  const out = el('output', {}, format(value));
  const input = el('input', { type: 'range', min, max, step, value, oninput: () => { out.textContent = format(+input.value); onInput?.(+input.value); } });
  return el('label', { class: 'field slider' }, el('span', {}, label), input, out);
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  el('a', { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function pickFiles(accept, multiple = false) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, multiple });
    input.addEventListener('change', () => resolve([...input.files]));
    input.click();
  });
}
