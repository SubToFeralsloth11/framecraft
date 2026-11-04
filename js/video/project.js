// .fcvideo project files: timeline JSON plus a list of media referenced by file name. Opening
// matches media already in the bin by name, then asks the user to relink anything missing.
import { requirePro } from '../license.js';
import { el, modal, toast, download, pickFiles } from '../ui.js';
import { iconEl } from '../icons.js';
import { ACCEPT, kindOf } from './media.js';
import { normalize } from './model.js';

export function saveProject(ed) {
  if (!requirePro('Saving projects')) return;
  const { store, media } = ed;
  const used = new Set(store.p.clips.map((c) => c.mediaId).filter(Boolean));
  const data = {
    app: 'FrameCraft', format: 'fcvideo', version: 1, savedAt: new Date().toISOString(),
    project: store.p,
    media: media.list().filter((m) => used.has(m.id)).map(({ id, name, kind, size, duration, width, height }) => ({ id, name, kind, size, duration, width, height })),
  };
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), 'framecraft-project.fcvideo');
  toast('Project saved. Keep the media files next to it so you can relink them.', 'ok', 4000);
}

function parse(text) {
  const d = JSON.parse(text);
  if (d?.format !== 'fcvideo' || !Array.isArray(d.project?.tracks) || !Array.isArray(d.project?.clips)) throw new Error('Not a FrameCraft video project');
  return d;
}

export async function openProject(ed) {
  const { store, media, engine } = ed;
  const [file] = await pickFiles('.fcvideo,application/json');
  if (!file) return;
  let data;
  try { data = parse(await file.text()); } catch (e) { return toast(e.message || 'Could not read that project', 'err', 4000); }
  if (store.p.clips.length && !confirm('Replace the current timeline with this project?')) return;
  engine.pause();
  const project = data.project;
  const saved = data.media || [];
  const remap = new Map();
  const missing = [];
  for (const m of saved) {
    const have = media.get(m.id)?.name === m.name ? media.get(m.id)
      : media.list().find((x) => x.name === m.name && x.kind === m.kind && (!m.size || x.size === m.size));
    if (have) remap.set(m.id, have.id);
    else missing.push(m);
  }
  const finish = () => {
    for (const c of project.clips) if (c.mediaId && remap.has(c.mediaId)) c.mediaId = remap.get(c.mediaId);
    store.load(normalize(project));
    engine.seek(0);
    const off = project.clips.filter((c) => c.mediaId && !media.get(c.mediaId)).length;
    toast(off ? `Project opened · ${off} clip${off > 1 ? 's' : ''} offline` : 'Project opened', off ? 'warn' : 'ok', 4000);
  };
  if (!missing.length) return finish();
  relinkDialog(ed, missing, remap, finish);
}

function relinkDialog(ed, missing, remap, finish) {
  const { media } = ed;
  const list = el('div', { class: 'vt-relink' });
  const draw = () => {
    list.textContent = '';
    for (const m of missing) {
      const ok = remap.has(m.id);
      const row = el('div', { class: 'vt-relink-row' + (ok ? ' ok' : '') },
        iconEl(ok ? 'check' : 'warn', 18),
        el('div', {}, el('div', {}, m.name), el('div', { class: 'muted vt-small' }, ok ? 'Linked' : `${m.kind} · missing`)),
        ok ? el('span') : el('button', { class: 'btn', onclick: () => locate([m]) }, 'Locate…'));
      list.append(row);
    }
  };
  // Imports the picked files; a file is linked to the missing entry with the same name (or the single
  // requested entry when only one was asked for).
  const locate = async (wanted) => {
    const files = await pickFiles(ACCEPT, wanted.length !== 1);
    if (!files.length) return;
    for (const f of files) {
      const target = wanted.length === 1 ? wanted[0] : missing.find((m) => !remap.has(m.id) && m.name === f.name);
      if (!target) continue;
      if (kindOf(f) && kindOf(f) !== target.kind && !(target.kind === 'audio' && kindOf(f) === 'video')) {
        toast(`${f.name} is not a ${target.kind} file`, 'err');
        continue;
      }
      const { added, errors } = await media.add([f], [media.get(target.id) ? undefined : target.id]);
      errors.forEach((e) => toast(e, 'err', 4000));
      if (added[0]) remap.set(target.id, added[0].id);
    }
    draw();
    if (missing.every((m) => remap.has(m.id))) { dlg.close(); }
  };
  draw();
  let done = false;
  const go = () => { if (done) return; done = true; finish(); };
  const body = el('div', { class: 'modal-body' },
    el('p', { style: { margin: 0 } }, `${missing.length} media file${missing.length > 1 ? 's are' : ' is'} not in this browser yet. Point FrameCraft to them (they never leave your computer).`),
    list,
    el('div', { class: 'row vt-wrap' },
      el('button', { class: 'btn primary', onclick: () => locate(missing.filter((m) => !remap.has(m.id))) }, 'Select files… (matched by name)'),
      el('button', { class: 'btn', onclick: () => dlg.close() }, 'Continue')),
    el('div', { class: 'muted vt-small' }, 'Anything you skip shows as “Media offline”. You can delete those clips or reopen the project later.'));
  const dlg = modal('Relink media', body, { onClose: go });
}
