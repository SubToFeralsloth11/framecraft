// New / open / place / export / project files, and image-level operations (size, canvas, rotate, flip).
import { el, toast, modal, download, pickFiles, slider } from '../ui.js';
import { CONFIG } from '../config.js';
import { License, requirePro, drawWatermark } from '../license.js';
import { resample, fileToImage, loadImage, canvasToBlob } from './canvas.js';
import { BLEND_MODES } from './doc.js';

export const PRESET_SIZES = [
  { name: 'Square post', w: 1080, h: 1080 },
  { name: 'Full HD', w: 1920, h: 1080 },
  { name: 'Story / Reel', w: 1080, h: 1920 },
  { name: 'A4 · 300 dpi', w: 2480, h: 3508 },
];

const MAX_SIDE = 16384;
const baseName = (n) => (n || 'image').replace(/\.[^.]+$/, '');

// ---------- new document ----------

export function newDocForm(ed, onDone) {
  const w = el('input', { type: 'number', min: 1, max: MAX_SIDE, value: 1200 });
  const h = el('input', { type: 'number', min: 1, max: MAX_SIDE, value: 800 });
  const bg = el('select', {}, [['white', 'White'], ['transparent', 'Transparent'], ['bg', 'Background color'], ['black', 'Black']].map(([v, t]) => el('option', { value: v }, t)));
  const create = (W, H) => {
    W = Math.round(+W); H = Math.round(+H);
    if (!(W >= 1 && H >= 1 && W <= MAX_SIDE && H <= MAX_SIDE)) { toast(`Size must be 1–${MAX_SIDE} px`, 'err'); return; }
    const fill = { white: '#ffffff', black: '#000000', bg: ed.bg, transparent: null }[bg.value];
    ed.newDoc(W, H, fill);
    onDone?.();
  };
  return el('div', { class: 'pe-new' },
    el('div', { class: 'pe-new-grid' }, PRESET_SIZES.map((p) => el('button', { class: 'pe-size-card', onclick: () => create(p.w, p.h) },
      el('div', { class: 'pe-size-shape', style: { aspectRatio: `${p.w} / ${p.h}` } }),
      el('b', {}, p.name), el('span', { class: 'muted' }, `${p.w} × ${p.h}`)))),
    el('div', { class: 'row pe-custom' }, el('span', { class: 'muted' }, 'Custom'), w, el('span', { class: 'muted' }, '×'), h,
      el('span', { class: 'muted' }, 'px'), el('div', { class: 'spacer' }),
      el('label', { class: 'row' }, el('span', { class: 'muted' }, 'Background'), bg),
      el('button', { class: 'btn primary', onclick: () => create(w.value, h.value) }, 'Create')));
}

export function newDocDialog(ed) {
  if (!confirmDiscard(ed)) return;
  const dlg = modal('New canvas', el('div', { class: 'modal-body pe-dlg' }, newDocForm(ed, () => dlg.close())));
}

export function confirmDiscard(ed) {
  return !ed.doc || !ed.doc.dirty || ed.doc.history.entries.length <= 1 || confirm('Discard the current image? Unsaved changes will be lost.');
}

// ---------- open / place images ----------

export async function openImageFile(ed, file) {
  try {
    const img = await fileToImage(file);
    let w = img.naturalWidth, h = img.naturalHeight;
    if (Math.max(w, h) > MAX_SIDE) { const s = MAX_SIDE / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); toast('Very large image scaled down to fit the browser canvas limit', 'warn', 4000); }
    ed.newDoc(w, h, null, { name: baseName(file.name), image: img });
  } catch (err) {
    toast(`Could not open ${file.name}: ${err.message}`, 'err', 4000);
  }
}

export async function placeImageFile(ed, file) {
  const d = ed.doc;
  if (!d) return openImageFile(ed, file);
  try {
    const img = await fileToImage(file);
    const layer = d.addLayer(baseName(file.name || 'Pasted image'));
    if (!layer) return;
    let w = img.naturalWidth, h = img.naturalHeight;
    const s = Math.min(1, d.width / w, d.height / h);
    w *= s; h *= s;
    layer.ctx.imageSmoothingQuality = 'high';
    layer.ctx.drawImage(img, Math.round((d.width - w) / 2), Math.round((d.height - h) / 2), Math.round(w), Math.round(h));
    d.commit('Place image', layer);
  } catch (err) {
    toast(`Could not place image: ${err.message}`, 'err', 4000);
  }
}

export async function openDialog(ed) {
  const [file] = await pickFiles('image/*,.fcphoto');
  if (!file) return;
  if (file.name.endsWith('.fcphoto')) return openProject(ed, file);
  if (confirmDiscard(ed)) openImageFile(ed, file);
}

export async function placeDialog(ed) {
  const files = await pickFiles('image/*', true);
  for (const f of files) await placeImageFile(ed, f);
}

// ---------- project files (.fcphoto) ----------

export async function saveProject(ed) {
  const d = ed.doc;
  if (!d || !requirePro('Save project')) return;
  ed.busy(true, 'Saving project');
  try {
    const project = {
      app: CONFIG.appName, type: 'fcphoto', version: 1, width: d.width, height: d.height, active: d.active, name: d.name,
      layers: d.layers.map((l) => ({ name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, locked: l.locked, data: l.canvas.toDataURL('image/png') })),
    };
    download(new Blob([JSON.stringify(project)], { type: 'application/json' }), `${d.name || 'untitled'}.fcphoto`);
    d.dirty = false;
    toast('Project saved', 'ok');
  } finally {
    ed.busy(false);
  }
}

export async function openProjectDialog(ed) {
  const [file] = await pickFiles('.fcphoto,application/json');
  if (file) openProject(ed, file);
}

export async function openProject(ed, file) {
  if (!confirmDiscard(ed)) return;
  ed.busy(true, 'Opening project');
  try {
    const p = JSON.parse(await file.text());
    if (p.type !== 'fcphoto' || !Array.isArray(p.layers) || !(p.width > 0 && p.height > 0)) throw new Error('Not a FrameCraft photo project');
    const images = await Promise.all(p.layers.map((l) => loadImage(l.data)));
    ed.newDoc(p.width, p.height, null, {
      name: p.name || baseName(file.name),
      layers: p.layers.map((l, i) => ({
        name: String(l.name || `Layer ${i + 1}`), visible: l.visible !== false, opacity: Math.max(0, Math.min(1, +l.opacity || 0)),
        blend: BLEND_MODES.includes(l.blend) ? l.blend : 'normal', locked: !!l.locked, image: images[i],
      })),
      active: p.active,
    });
    toast('Project opened', 'ok');
  } catch (err) {
    toast(`Could not open project: ${err.message}`, 'err', 4000);
  } finally {
    ed.busy(false);
  }
}

// ---------- export ----------

export function exportDialog(ed) {
  const d = ed.doc;
  if (!d) return;
  const pro = License.isPro();
  const cap = CONFIG.free.photoMaxExport;
  const state = { format: 'png', quality: 92, scale: 100 };
  const fmt = el('select', { onchange: () => { state.format = fmt.value; update(); } },
    [['png', 'PNG (lossless, transparency)'], ['jpeg', 'JPG (small, no transparency)'], ['webp', 'WebP (small, transparency)']].map(([v, t]) => el('option', { value: v }, t)));
  const quality = slider('Quality', { min: 10, max: 100, value: state.quality, onInput: (v) => { state.quality = v; }, format: (v) => `${v}%` });
  const scale = slider('Scale', { min: 10, max: 100, value: 100, onInput: (v) => { state.scale = v; update(); }, format: (v) => `${v}%` });
  const info = el('div', { class: 'muted' });
  const size = () => {
    let w = d.width * state.scale / 100, h = d.height * state.scale / 100;
    const capped = !pro && Math.max(w, h) > cap;
    if (capped) { const s = cap / Math.max(w, h); w *= s; h *= s; }
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)), capped };
  };
  function update() {
    quality.classList.toggle('hidden', state.format === 'png');
    const s = size();
    info.replaceChildren(...[`Output: ${s.w} × ${s.h} px`, s.capped ? el('span', {}, ` · Free plan max ${cap}px. `, el('span', { class: 'pro-badge' }, 'PRO'), ' exports full resolution') : null,
      !pro ? el('div', {}, 'Free exports include a small watermark.') : null].filter(Boolean));
  }
  const go = async () => {
    const s = size();
    ed.busy(true, 'Exporting');
    try {
      const flat = d.flatten();
      const out = s.w === d.width && s.h === d.height ? flat : resample(flat, s.w, s.h);
      const ctx = out.getContext('2d');
      if (state.format === 'jpeg') {
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, s.w, s.h);
        ctx.globalCompositeOperation = 'source-over';
      }
      drawWatermark(ctx, s.w, s.h);
      const type = `image/${state.format}`;
      const blob = await canvasToBlob(out, type, state.quality / 100);
      let ext = state.format === 'jpeg' ? 'jpg' : state.format;
      if (blob.type !== type) { ext = blob.type === 'image/png' ? 'png' : ext; toast(`${state.format.toUpperCase()} is not supported by this browser; saved as PNG`, 'warn', 4000); }
      download(blob, `${d.name || 'image'}.${ext}`);
      dlg.close();
      toast(`Exported ${s.w} × ${s.h}`, 'ok');
    } catch (err) {
      toast(`Export failed: ${err.message}`, 'err', 4000);
    } finally {
      ed.busy(false);
    }
  };
  const dlg = modal('Export image', el('div', { class: 'modal-body pe-dlg' },
    el('label', { class: 'field' }, el('span', {}, 'Format'), fmt), quality, scale, info,
    el('div', { class: 'row' }, el('div', { class: 'spacer' }), el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), el('button', { class: 'btn primary', onclick: go }, 'Export'))));
  update();
}

// ---------- image operations ----------

export function imageSizeDialog(ed) {
  const d = ed.doc;
  if (!d) return;
  const ratio = d.width / d.height;
  const w = el('input', { type: 'number', min: 1, max: MAX_SIDE, value: d.width });
  const h = el('input', { type: 'number', min: 1, max: MAX_SIDE, value: d.height });
  const pct = el('input', { type: 'number', min: 1, max: 1000, value: 100 });
  const lock = el('input', { type: 'checkbox', checked: true });
  w.addEventListener('input', () => { if (lock.checked) h.value = Math.max(1, Math.round(w.value / ratio)); pct.value = Math.round((w.value / d.width) * 100); });
  h.addEventListener('input', () => { if (lock.checked) w.value = Math.max(1, Math.round(h.value * ratio)); pct.value = Math.round((h.value / d.height) * 100); });
  pct.addEventListener('input', () => { w.value = Math.max(1, Math.round((d.width * pct.value) / 100)); h.value = Math.max(1, Math.round((d.height * pct.value) / 100)); });
  const apply = () => {
    const W = Math.round(+w.value), H = Math.round(+h.value);
    if (!(W >= 1 && H >= 1 && W <= MAX_SIDE && H <= MAX_SIDE)) { toast(`Size must be 1–${MAX_SIDE} px`, 'err'); return; }
    dlg.close();
    if (W === d.width && H === d.height) return;
    const scaled = d.layers.map((l) => resample(l.canvas, W, H));
    let i = 0;
    d.transform(W, H, (ctx) => ctx.drawImage(scaled[i++], 0, 0));
    d.history.push('Image size');
    ed.view.fit();
  };
  const dlg = modal('Image size', el('div', { class: 'modal-body pe-dlg' },
    el('label', { class: 'field' }, el('span', {}, 'Width'), w, el('span', { class: 'muted' }, 'px')),
    el('label', { class: 'field' }, el('span', {}, 'Height'), h, el('span', { class: 'muted' }, 'px')),
    el('label', { class: 'field' }, el('span', {}, 'Percent'), pct, el('span', { class: 'muted' }, '%')),
    el('label', { class: 'row' }, lock, 'Keep proportions'),
    el('div', { class: 'row' }, el('div', { class: 'spacer' }), el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), el('button', { class: 'btn primary', onclick: apply }, 'Resample'))));
}

export function canvasSizeDialog(ed) {
  const d = ed.doc;
  if (!d) return;
  const w = el('input', { type: 'number', min: 1, max: MAX_SIDE, value: d.width });
  const h = el('input', { type: 'number', min: 1, max: MAX_SIDE, value: d.height });
  let anchor = [1, 1];
  const grid = el('div', { class: 'pe-anchor' });
  const renderGrid = () => {
    grid.replaceChildren(...[0, 1, 2].flatMap((y) => [0, 1, 2].map((x) => el('button', {
      class: anchor[0] === x && anchor[1] === y ? 'active' : '', title: 'Anchor', onclick: () => { anchor = [x, y]; renderGrid(); } }))));
  };
  renderGrid();
  const apply = () => {
    const W = Math.round(+w.value), H = Math.round(+h.value);
    if (!(W >= 1 && H >= 1 && W <= MAX_SIDE && H <= MAX_SIDE)) { toast(`Size must be 1–${MAX_SIDE} px`, 'err'); return; }
    dlg.close();
    if (W === d.width && H === d.height) return;
    const ox = Math.round(((W - d.width) * anchor[0]) / 2), oy = Math.round(((H - d.height) * anchor[1]) / 2);
    d.transform(W, H, (ctx, old) => ctx.drawImage(old, ox, oy));
    d.history.push('Canvas size');
    ed.view.fit();
  };
  const dlg = modal('Canvas size', el('div', { class: 'modal-body pe-dlg' },
    el('label', { class: 'field' }, el('span', {}, 'Width'), w, el('span', { class: 'muted' }, 'px')),
    el('label', { class: 'field' }, el('span', {}, 'Height'), h, el('span', { class: 'muted' }, 'px')),
    el('div', { class: 'field' }, el('span', {}, 'Anchor'), grid),
    el('div', { class: 'muted' }, 'New area is transparent; existing content is cropped when shrinking.'),
    el('div', { class: 'row' }, el('div', { class: 'spacer' }), el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), el('button', { class: 'btn primary', onclick: apply }, 'Apply'))));
}

export function rotate(ed, deg) {
  const d = ed.doc;
  if (!d) return;
  const swap = deg % 180 !== 0;
  const W = swap ? d.height : d.width, H = swap ? d.width : d.height;
  const ow = d.width, oh = d.height;
  d.transform(W, H, (ctx, old) => { ctx.translate(W / 2, H / 2); ctx.rotate((deg * Math.PI) / 180); ctx.drawImage(old, -ow / 2, -oh / 2); });
  d.history.push(deg === 180 ? 'Rotate 180°' : deg > 0 ? 'Rotate 90° CW' : 'Rotate 90° CCW');
  ed.view.fit();
}

export function flip(ed, horizontal) {
  const d = ed.doc;
  if (!d) return;
  d.transform(d.width, d.height, (ctx, old) => {
    ctx.translate(horizontal ? d.width : 0, horizontal ? 0 : d.height);
    ctx.scale(horizontal ? -1 : 1, horizontal ? 1 : -1);
    ctx.drawImage(old, 0, 0);
  });
  d.history.push(horizontal ? 'Flip horizontal' : 'Flip vertical');
}
