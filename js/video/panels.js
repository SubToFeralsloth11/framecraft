// Left panel: Media bin, Titles & graphics, Transitions and Effects tabs. Items are draggable onto
// the timeline (or clips) and can also be clicked to add / apply.
import { el, pickFiles, toast } from '../ui.js';
import { timecode, TRANSITIONS } from './model.js';
import { EFFECTS } from './looks.js';
import { SHAPES } from './gen.js';
import { ACCEPT } from './media.js';

const TITLE_PRESETS = [
  { name: 'Title', props: { name: 'Title', text: { content: 'Your title', size: 110, anim: 'fade' } } },
  { name: 'Lower third', props: { name: 'Lower third', x: 0.3, y: 0.82, text: { content: 'Jane Doe\nFounder, Studio', size: 46, align: 'left', box: true, boxColor: '#101010', boxOpacity: 0.7, boxPad: 22, shadow: false, anim: 'slideUp' } } },
  { name: 'Big & bold', props: { name: 'Big title', text: { content: 'BIG NEWS', font: 'impact', size: 190, stroke: true, strokeWidth: 8, anim: 'pop', animDur: 0.7 } } },
  { name: 'Subtitle', props: { name: 'Subtitle', y: 0.88, text: { content: 'Subtitle text goes here', size: 44, bold: false, box: true, boxOpacity: 0.55, boxPad: 14, shadow: false, anim: 'none' } } },
  { name: 'Typewriter', props: { name: 'Typewriter', text: { content: 'Once upon a time…', font: 'courier', size: 72, anim: 'typewriter', animDur: 2 } } },
  { name: 'Neon', props: { name: 'Neon', text: { content: 'NEON NIGHTS', font: 'rounded', size: 120, color: '#c8fbff', shadowColor: '#00e5ff', shadowBlur: 40, anim: 'fade' } } },
  { name: 'Elegant', props: { name: 'Elegant', text: { content: 'A Love Story', font: 'georgia', italic: true, bold: false, size: 104, color: '#f6e7c8', anim: 'slideUp', animDur: 1.2 } } },
  { name: 'Social caption', props: { name: 'Caption', y: 0.7, text: { content: 'wait for it…', size: 70, color: '#111111', box: true, boxColor: '#ffffff', boxOpacity: 1, boxPad: 18, shadow: false, anim: 'pop' } } },
];
const BACKGROUNDS = [
  { name: 'Black', fill: { mode: 'solid', c1: '#000000', c2: '#000000' } },
  { name: 'White', fill: { mode: 'solid', c1: '#ffffff', c2: '#ffffff' } },
  { name: 'Indigo', fill: { mode: 'linear', c1: '#1d2b64', c2: '#6c3cff', angle: 135 } },
  { name: 'Sunset', fill: { mode: 'linear', c1: '#ff7e5f', c2: '#feb47b', angle: 90 } },
  { name: 'Ocean', fill: { mode: 'linear', c1: '#2193b0', c2: '#6dd5ed', angle: 45 } },
  { name: 'Forest', fill: { mode: 'linear', c1: '#134e5e', c2: '#71b280', angle: 120 } },
  { name: 'Spotlight', fill: { mode: 'radial', c1: '#4a4f5c', c2: '#050505' } },
  { name: 'Candy', fill: { mode: 'linear', c1: '#f857a6', c2: '#ff5858', angle: 160 } },
];
const SHAPE_COLORS = { rect: '#6c8cff', ellipse: '#3ecf8e', triangle: '#f5b74e', star: '#ffd93d', heart: '#ff5c6c' };
const TRANS_ICONS = { crossfade: '◐', dip: '●', wipe: '▶|', slide: '⇆', zoom: '⤢' };

export class Panels {
  constructor(ed, host) {
    this.ed = ed;
    this.tabs = { media: 'Media', titles: 'Titles', transitions: 'Transitions', effects: 'Effects' };
    this.bar = el('div', { class: 'vt-tabs' }, Object.entries(this.tabs).map(([k, n]) =>
      el('button', { 'data-tab': k, onclick: () => this.show(k) }, n)));
    this.body = el('div', { class: 'vt-panel-body' });
    host.append(this.bar, this.body);
    ed.media.on(() => { if (this.tab === 'media') this.show('media'); });
    ed.store.on((info) => { if (this.tab === 'media' && !info.source && info.type !== 'select' && !ed.drag) this.show('media'); });
    host.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); host.classList.add('drop'); } });
    host.addEventListener('dragleave', (e) => { if (!host.contains(e.relatedTarget)) host.classList.remove('drop'); });
    host.addEventListener('drop', (e) => {
      host.classList.remove('drop');
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      ed.actions.importFiles([...e.dataTransfer.files]);
    });
    this.show('media');
  }

  show(tab) {
    this.tab = tab;
    this.bar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    this.body.textContent = '';
    this.body.append(this[tab]());
  }

  draggable(node, payload, label) {
    node.draggable = true;
    node.addEventListener('dragstart', (e) => {
      this.ed.drag = payload;
      e.dataTransfer.setData('text/plain', label);
      e.dataTransfer.effectAllowed = 'copy';
    });
    node.addEventListener('dragend', () => { this.ed.drag = null; });
    return node;
  }

  media() {
    const { media, actions, store } = this.ed;
    const items = media.list();
    const importBtn = el('button', { class: 'btn primary', onclick: async () => actions.importFiles(await pickFiles(ACCEPT, true)) }, '＋ Import media');
    const grid = el('div', { class: 'vt-bin' }, items.map((m) => {
      const used = store.p.clips.filter((c) => c.mediaId === m.id).length;
      const thumb = m.thumb
        ? el('div', { class: 'vt-thumb', style: { backgroundImage: `url("${m.thumb}")` } })
        : el('div', { class: 'vt-thumb vt-audio-thumb' }, '♪');
      const node = el('div', { class: 'vt-item', title: `${m.name}\nDouble-click or + to add at the playhead; drag onto a track to place it.` },
        thumb,
        el('div', { class: 'vt-item-meta' },
          el('div', { class: 'vt-item-name' }, m.name),
          el('div', { class: 'muted' }, m.kind === 'image' ? `Image · ${m.width}×${m.height}` : `${m.kind === 'video' ? 'Video' : 'Audio'} · ${timecode(m.duration)}`, used ? ` · used ${used}×` : '')),
        el('div', { class: 'vt-item-actions' },
          el('button', { class: 'icon-btn', title: 'Add to timeline at playhead', onclick: () => actions.addMedia(m) }, '＋'),
          el('button', { class: 'icon-btn', title: 'Remove from project', onclick: () => this.removeMedia(m, used) }, '✕')));
      node.addEventListener('dblclick', () => actions.addMedia(m));
      return this.draggable(node, { type: 'media', id: m.id }, m.name);
    }));
    return el('div', { class: 'vt-stack' },
      importBtn,
      items.length ? grid : el('div', { class: 'vt-empty-bin' }, el('div', { class: 'vt-big' }, '⬇'), 'Drop video, audio or image files here', el('div', { class: 'muted' }, 'Files stay on your computer.')));
  }

  removeMedia(m, used) {
    if (used && !confirm(`${m.name} is used by ${used} clip${used > 1 ? 's' : ''}. Remove it and its clips?`)) return;
    if (used) this.ed.store.mutate((p) => { p.clips = p.clips.filter((c) => c.mediaId !== m.id); });
    this.ed.engine.destroyMedia(m.id);
    this.ed.media.remove(m.id);
  }

  titles() {
    const { actions } = this.ed;
    const tile = (label, kind, props, style, inner = label) =>
      this.draggable(el('div', { class: 'vt-tile', role: 'button', style, title: `${label} — click to add at playhead, or drag onto a track`, onclick: () => actions.addGenerated(kind, structuredClone(props)) }, inner), { type: 'gen', kind, props }, label);
    return el('div', { class: 'vt-stack' },
      el('div', { class: 'panel-title' }, 'Titles'),
      el('div', { class: 'vt-tiles' }, TITLE_PRESETS.map((t) => tile(t.name, 'text', t.props, {
        fontFamily: t.props.text.font === 'georgia' ? 'Georgia, serif' : t.props.text.font === 'impact' ? 'Impact, sans-serif' : t.props.text.font === 'courier' ? 'Courier New, monospace' : '',
      }))),
      el('div', { class: 'panel-title' }, 'Backgrounds'),
      el('div', { class: 'vt-tiles' }, BACKGROUNDS.map((b) => tile(b.name, 'solid', { name: b.name, fill: b.fill }, {
        background: b.fill.mode === 'solid' ? b.fill.c1 : b.fill.mode === 'radial' ? `radial-gradient(${b.fill.c1}, ${b.fill.c2})` : `linear-gradient(${b.fill.angle + 90}deg, ${b.fill.c1}, ${b.fill.c2})`,
        color: b.name === 'White' ? '#111' : '#fff',
      }))),
      el('div', { class: 'panel-title' }, 'Shapes'),
      el('div', { class: 'vt-tiles' }, Object.entries(SHAPES).map(([k, n]) => tile(n, 'shape', { name: n, shape: { type: k, fill: SHAPE_COLORS[k], w: k === 'rect' ? 0.4 : 0.3, h: k === 'rect' ? 0.25 : 0.3 } }, {}, [
        el('span', { class: `vt-shape vt-shape-${k}`, style: { color: SHAPE_COLORS[k] } }), n]))));
  }

  transitions() {
    const { actions, store } = this.ed;
    const apply = (type) => {
      const c = store.selected()[0];
      if (!c) return toast('Select a clip first, or drag the transition onto the cut between two clips', 'warn', 3500);
      actions.applyTransition(c.id, type, 'start');
    };
    return el('div', { class: 'vt-stack' },
      el('p', { class: 'muted vt-small' }, 'Drag onto a clip edge that touches another clip (left half = cut before it, right half = cut after it), or select a clip and click.'),
      el('div', { class: 'vt-tiles' }, Object.entries(TRANSITIONS).map(([k, n]) =>
        this.draggable(el('div', { class: 'vt-tile', role: 'button', title: `${n} — drag onto a cut or click to apply`, onclick: () => apply(k) }, el('span', { class: 'vt-big' }, TRANS_ICONS[k]), n), { type: 'transition', id: k }, n))));
  }

  effects() {
    const { actions, store } = this.ed;
    const apply = (type) => {
      const c = store.selected()[0];
      if (!c) return toast('Select a clip first, or drag the effect onto a clip', 'warn');
      actions.applyEffect(c.id, type);
    };
    return el('div', { class: 'vt-stack' },
      el('p', { class: 'muted vt-small' }, 'Drag an effect onto a clip, or select a clip and click. Tweak or remove it in the Inspector. Colour looks are in the Inspector’s Color section.'),
      el('div', { class: 'vt-tiles' }, Object.entries(EFFECTS).map(([k, f]) =>
        this.draggable(el('div', { class: 'vt-tile', role: 'button', title: `${f.name} — drag onto a clip or click to apply`, onclick: () => apply(k) }, el('span', { class: 'vt-big' }, f.icon), f.name), { type: 'effect', id: k }, f.name))));
  }
}
