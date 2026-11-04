// Inspector for the selected clip: transform + keyframes, crop, blend, speed, audio, fades, colour,
// looks, effects, chroma key, text/background/shape properties and transitions.
import { CONFIG } from '../config.js';
import { License, requirePro } from '../license.js';
import { el, toast } from '../ui.js';
import { iconEl } from '../icons.js';
import {
  clamp, clipEnd, propAt, keyIndex, setKey, removeKey, setSpeed, trimEnd, prevAdjacent, transDur, timecode,
  TRANSITIONS, TEXT_ANIMS, COLOR_DEFAULT, ASPECTS, KEY_PROPS, trackOf,
} from './model.js';
import { LOOKS, EFFECTS, BLEND_MODES } from './looks.js';
import { FONTS, SHAPES } from './gen.js';

const pct = (v) => `${Math.round(v * 100)}%`;
const secs = (v) => `${(+v).toFixed(2)} s`;
const pro = () => (License.isPro() ? null : el('span', { class: 'pro-badge' }, 'PRO'));

export class Inspector {
  constructor(ed, host) {
    this.ed = ed;
    this.host = host;
    this.updaters = [];
    ed.store.on((info) => { if (info.source === 'inspector' || info.source === 'preview') this.refresh(); else this.build(); });
    ed.engine.on((type) => { if (type === 'time') this.refresh(); });
    License.onChange(() => this.build());
    this.build();
  }

  cur() { return this.ed.store.clip(this.id); }
  lt(c = this.cur()) { return clamp(this.ed.engine.t - c.start, 0, c.duration); }
  edit(key, fn) {
    const id = this.id;
    this.ed.store.mutate((p) => { const c = p.clips.find((x) => x.id === id); if (c) fn(c, p); }, { coalesce: `${id}:${key}`, source: 'inspector' });
  }
  refresh() { if (this.cur() || !this.id) this.updaters.forEach((u) => u()); }

  // ---------- control builders ----------
  section(title, open = true, ...children) {
    const d = el('details', { class: 'vt-sec', open }, el('summary', { class: 'panel-title' }, ...[title].flat()), ...children);
    return d;
  }

  range(label, { min, max, step = 1, get, set, fmt = (v) => v, key = label, extra = null, reset = null }) {
    const out = el('output');
    const input = el('input', { type: 'range', min, max, step });
    const refresh = () => { const c = this.cur(); if (!c) return; const v = get(c); input.value = v; out.textContent = fmt(v); };
    input.addEventListener('input', () => { out.textContent = fmt(+input.value); this.edit(key, (c, p) => set(c, +input.value, p)); });
    const lab = el('span', { title: reset != null ? 'Double-click (double-tap) to reset' : '' }, label);
    if (reset != null) {
      const doReset = () => this.edit(key + ':reset', (c, p) => set(c, reset, p));
      lab.addEventListener('dblclick', doReset);
      // Touch browsers do not reliably fire dblclick: detect a double tap ourselves.
      let lastTap = 0;
      lab.addEventListener('pointerup', (e) => {
        if (e.pointerType !== 'touch') return;
        const now = performance.now();
        if (now - lastTap < 350) { e.preventDefault(); doReset(); lastTap = 0; } else lastTap = now;
      });
    }
    this.updaters.push(refresh);
    refresh();
    return el('label', { class: 'field' + (extra ? ' vt-keyed' : '') }, lab, input, out, extra);
  }

  select(label, options, get, set) {
    const s = el('select', { onchange: () => this.edit('sel:' + label, (c) => set(c, s.value)) },
      Object.entries(options).map(([v, n]) => el('option', { value: v }, typeof n === 'string' ? n : n.name)));
    s.value = get(this.cur());
    this.updaters.push(() => { const c = this.cur(); if (c && document.activeElement !== s) s.value = get(c); });
    return el('label', { class: 'field' }, el('span', {}, label), s, el('span'));
  }

  color(label, get, set) {
    const i = el('input', { type: 'color', value: get(this.cur()), oninput: () => this.edit(label, (c) => set(c, i.value)) });
    return el('label', { class: 'field' }, el('span', {}, label), el('div', { class: 'row' }, i), el('span'));
  }

  check(label, get, set, badge = null) {
    const i = el('input', { type: 'checkbox', checked: !!get(this.cur()) });
    i.addEventListener('change', () => { if (set(i.checked) === false) i.checked = !i.checked; });
    this.updaters.push(() => { const c = this.cur(); if (c) i.checked = !!get(c); });
    return el('label', { class: 'field vt-check' }, el('span', {}, label), el('div', { class: 'row' }, i, badge), el('span'));
  }

  // Range row for a keyframable property, with keyframe add/remove and previous/next navigation.
  keyed(label, prop, opts) {
    const diamond = el('button', { class: 'vt-kf', title: 'Add / remove keyframe at playhead' }, iconEl('keyframe', 13));
    const prev = el('button', { class: 'vt-kf nav', title: 'Previous keyframe' }, iconEl('chevronLeft', 13));
    const next = el('button', { class: 'vt-kf nav', title: 'Next keyframe' }, iconEl('chevronRight', 13));
    const jump = (dir) => {
      const c = this.cur(), lt = this.lt(c), ks = c.keyframes[prop] || [];
      const k = dir < 0 ? [...ks].reverse().find((x) => x.t < lt - 1e-3) : ks.find((x) => x.t > lt + 1e-3);
      if (k) this.ed.engine.seek(c.start + k.t);
    };
    prev.onclick = (e) => { e.preventDefault(); jump(-1); };
    next.onclick = (e) => { e.preventDefault(); jump(1); };
    diamond.onclick = (e) => {
      e.preventDefault();
      if (!requirePro('Keyframe animation')) return;
      const c = this.cur(), lt = this.lt(c);
      this.ed.store.mutate((p) => {
        const x = p.clips.find((k) => k.id === c.id);
        if (keyIndex(x, prop, lt) >= 0) removeKey(x, prop, lt);
        else setKey(x, prop, lt, propAt(x, prop, lt));
      }, { source: 'inspector' });
    };
    this.updaters.push(() => {
      const c = this.cur();
      if (!c) return;
      const has = !!c.keyframes[prop]?.length;
      diamond.classList.toggle('on', keyIndex(c, prop, this.lt(c)) >= 0);
      diamond.classList.toggle('has', has);
      prev.classList.toggle('hidden', !has);
      next.classList.toggle('hidden', !has);
    });
    return this.range(label, {
      ...opts, key: prop, extra: el('span', { class: 'vt-kfs' }, prev, diamond, next),
      get: (c) => propAt(c, prop, clamp(this.ed.engine.t - c.start, 0, c.duration)),
      set: (c, v) => {
        if (c.keyframes[prop]?.length) {
          if (!License.isPro()) { requirePro('Keyframe animation'); return; }
          setKey(c, prop, clamp(this.ed.engine.t - c.start, 0, c.duration), v);
        } else c[prop] = v;
      },
    });
  }

  // ---------- build ----------
  build() {
    this.updaters = [];
    const { store } = this.ed;
    const sel = store.selected();
    this.id = sel.length === 1 ? sel[0].id : null;
    this.host.textContent = '';
    if (sel.length > 1) return this.host.append(this.multi(sel));
    if (!sel.length) return this.host.append(this.project());
    const c = sel[0], tr = trackOf(store.p, c);
    const visual = tr?.kind === 'video' && c.kind !== 'audio';
    const media = c.kind === 'video' || c.kind === 'audio';
    this.host.append(...[
      this.header(c),
      c.kind === 'text' ? this.textSec() : null,
      c.kind === 'solid' ? this.solidSec() : null,
      c.kind === 'shape' ? this.shapeSec() : null,
      c.trans && prevAdjacent(store.p, c) ? this.transSec(c) : null,
      visual ? this.transformSec() : null,
      visual ? this.cropSec() : null,
      media ? this.speedSec() : null,
      media ? this.audioSec() : null,
      this.fadeSec(),
      visual ? this.colorSec() : null,
      visual ? this.effectsSec() : null,
      visual ? this.chromaSec() : null,
    ].filter(Boolean));
  }

  header(c) {
    const name = el('input', { type: 'text', value: c.name, oninput: () => this.edit('name', (x) => { x.name = name.value; }) });
    const info = el('div', { class: 'muted vt-info' });
    this.updaters.push(() => { const x = this.cur(); if (x) info.textContent = `${x.kind.toUpperCase()} · ${timecode(x.start)} → ${timecode(clipEnd(x))} · ${x.duration.toFixed(2)} s`; });
    this.updaters.at(-1)();
    const generated = c.srcDur == null;
    return el('div', { class: 'vt-insp-head' },
      el('label', { class: 'field' }, el('span', {}, 'Name'), name, el('span')),
      info,
      generated ? this.range('Duration', {
        min: 0.2, max: 60, step: 0.1, fmt: secs, get: (x) => x.duration,
        set: (x, v, p) => {
          const next = p.clips.filter((o) => o.trackId === x.trackId && o.start >= clipEnd(x) - 1e-4 && o.id !== x.id).sort((a, b) => a.start - b.start)[0];
          trimEnd(x, x.start + v, next ? next.start : Infinity);
        },
      }) : null);
  }

  textSec() {
    const t = (fn) => (c, v) => fn(c.text, v);
    const area = el('textarea', { rows: 3, value: this.cur().text.content, oninput: () => this.edit('content', (c) => { c.text.content = area.value; }) });
    const align = el('div', { class: 'row vt-seg' }, ['left', 'center', 'right'].map((a) => {
      const b = el('button', { class: 'icon-btn', title: `Align ${a}`, onclick: () => this.edit('align' + a, (c) => { c.text.align = a; }) }, iconEl({ left: 'alignLeft', center: 'alignCenter', right: 'alignRight' }[a], 16));
      this.updaters.push(() => b.classList.toggle('vt-on', this.cur()?.text.align === a));
      return b;
    }));
    this.updaters.at(-1)();
    return this.section('Text', true,
      el('div', { class: 'vt-pad' }, area),
      this.select('Font', Object.fromEntries(Object.entries(FONTS).map(([k, f]) => [k, f.name])), (c) => c.text.font, t((x, v) => { x.font = v; })),
      this.range('Size', { min: 12, max: 400, get: (c) => c.text.size, set: t((x, v) => { x.size = v; }), fmt: (v) => v + ' px' }),
      this.color('Color', (c) => c.text.color, t((x, v) => { x.color = v; })),
      this.check('Bold', (c) => c.text.bold, (v) => this.edit('bold', (c) => { c.text.bold = v; })),
      this.check('Italic', (c) => c.text.italic, (v) => this.edit('italic', (c) => { c.text.italic = v; })),
      el('label', { class: 'field' }, el('span', {}, 'Align'), align, el('span')),
      this.range('Line height', { min: 0.8, max: 2.5, step: 0.05, get: (c) => c.text.lineHeight, set: t((x, v) => { x.lineHeight = v; }), fmt: (v) => v.toFixed(2) }),
      this.check('Stroke', (c) => c.text.stroke, (v) => this.edit('stroke', (c) => { c.text.stroke = v; })),
      this.color('Stroke color', (c) => c.text.strokeColor, t((x, v) => { x.strokeColor = v; })),
      this.range('Stroke width', { min: 1, max: 30, get: (c) => c.text.strokeWidth, set: t((x, v) => { x.strokeWidth = v; }) }),
      this.check('Shadow', (c) => c.text.shadow, (v) => this.edit('shadow', (c) => { c.text.shadow = v; })),
      this.color('Shadow color', (c) => c.text.shadowColor, t((x, v) => { x.shadowColor = v; })),
      this.range('Shadow blur', { min: 0, max: 60, get: (c) => c.text.shadowBlur, set: t((x, v) => { x.shadowBlur = v; }) }),
      this.check('Background box', (c) => c.text.box, (v) => this.edit('box', (c) => { c.text.box = v; })),
      this.color('Box color', (c) => c.text.boxColor, t((x, v) => { x.boxColor = v; })),
      this.range('Box opacity', { min: 0, max: 1, step: 0.01, get: (c) => c.text.boxOpacity, set: t((x, v) => { x.boxOpacity = v; }), fmt: pct }),
      this.range('Box padding', { min: 0, max: 120, get: (c) => c.text.boxPad, set: t((x, v) => { x.boxPad = v; }) }),
      this.select('Animation', TEXT_ANIMS, (c) => c.text.anim, t((x, v) => { x.anim = v; })),
      this.range('Anim length', { min: 0.1, max: 5, step: 0.05, get: (c) => c.text.animDur, set: t((x, v) => { x.animDur = v; }), fmt: secs }));
  }

  solidSec() {
    const f = (fn) => (c, v) => fn(c.fill, v);
    return this.section('Background', true,
      this.select('Fill', { solid: 'Solid color', linear: 'Linear gradient', radial: 'Radial gradient' }, (c) => c.fill.mode, f((x, v) => { x.mode = v; })),
      this.color('Color 1', (c) => c.fill.c1, f((x, v) => { x.c1 = v; })),
      this.color('Color 2', (c) => c.fill.c2, f((x, v) => { x.c2 = v; })),
      this.range('Angle', { min: 0, max: 360, get: (c) => c.fill.angle, set: f((x, v) => { x.angle = v; }), fmt: (v) => v + '°' }));
  }

  shapeSec() {
    const s = (fn) => (c, v) => fn(c.shape, v);
    return this.section('Shape', true,
      this.select('Type', SHAPES, (c) => c.shape.type, s((x, v) => { x.type = v; })),
      this.color('Fill', (c) => c.shape.fill, s((x, v) => { x.fill = v; })),
      this.color('Outline', (c) => c.shape.stroke, s((x, v) => { x.stroke = v; })),
      this.range('Outline width', { min: 0, max: 40, get: (c) => c.shape.strokeWidth, set: s((x, v) => { x.strokeWidth = v; }) }),
      this.range('Width', { min: 0.02, max: 2, step: 0.01, get: (c) => c.shape.w, set: s((x, v) => { x.w = v; }), fmt: pct }),
      this.range('Height', { min: 0.02, max: 2, step: 0.01, get: (c) => c.shape.h, set: s((x, v) => { x.h = v; }), fmt: pct }),
      this.range('Corner radius', { min: 0, max: 1, step: 0.01, get: (c) => c.shape.radius, set: s((x, v) => { x.radius = v; }), fmt: pct }));
  }

  transSec(c) {
    const a = prevAdjacent(this.ed.store.p, c);
    return this.section('Transition in', true,
      this.select('Type', TRANSITIONS, (x) => x.trans?.type || 'crossfade', (x, v) => { if (x.trans) x.trans.type = v; }),
      this.range('Length', { min: 0.1, max: 3, step: 0.05, get: (x) => x.trans?.dur || 1, set: (x, v) => { if (x.trans) x.trans.dur = v; }, fmt: secs }),
      el('div', { class: 'vt-pad muted' }, `Effective length ${transDur(a, c).toFixed(2)} s (limited by clip lengths).`),
      el('div', { class: 'vt-pad' }, el('button', { class: 'btn', onclick: () => { this.edit('trans-rm', (x) => { x.trans = null; }); this.build(); } }, 'Remove transition')));
  }

  transformSec() {
    const ease = this.select('Interpolation', { linear: 'Linear', ease: 'Ease in/out' }, (c) => c.keyEase || 'linear', (c, v) => {
      c.keyEase = v;
      for (const ks of Object.values(c.keyframes)) for (const k of ks) k.ease = v;
    });
    ease.querySelector('span').append(' ', pro() || '');
    return this.section(['Transform ', el('span', { class: 'muted vt-small vt-kfhint' }, iconEl('keyframe', 11), 'keyframes '), pro()], true,
      this.keyed('Position X', 'x', { min: -0.5, max: 1.5, step: 0.001, fmt: pct, reset: 0.5 }),
      this.keyed('Position Y', 'y', { min: -0.5, max: 1.5, step: 0.001, fmt: pct, reset: 0.5 }),
      this.keyed('Scale', 'scale', { min: 0.05, max: 4, step: 0.01, fmt: pct, reset: 1 }),
      this.keyed('Rotation', 'rotation', { min: -180, max: 180, step: 0.5, fmt: (v) => Math.round(v) + '°', reset: 0 }),
      this.keyed('Opacity', 'opacity', { min: 0, max: 1, step: 0.01, fmt: pct, reset: 1 }),
      ease,
      this.select('Blend mode', BLEND_MODES, (c) => c.blend, (c, v) => { c.blend = v; }),
      el('div', { class: 'vt-pad row' },
        el('button', { class: 'btn', onclick: () => this.edit('fit', (c) => { for (const k of KEY_PROPS) delete c.keyframes[k]; Object.assign(c, { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 }); }) }, 'Reset transform'),
        el('button', { class: 'btn', title: 'Scale so the frame is fully covered', onclick: () => this.fill() }, 'Fill frame')));
  }

  fill() {
    const c = this.cur(), m = this.ed.media.get(c.mediaId);
    if (!m?.width) return toast('Fill works on video and image clips', 'warn');
    const { w, h } = this.ed.frame();
    const fit = Math.min(w / m.width, h / m.height), cover = Math.max(w / m.width, h / m.height);
    this.edit('fill', (x) => { x.scale = cover / fit; x.x = 0.5; x.y = 0.5; });
  }

  cropSec() {
    const side = (k, label) => this.range(label, { min: 0, max: 0.45, step: 0.005, fmt: pct, reset: 0, key: 'crop' + k, get: (c) => c.crop[k], set: (c, v) => { c.crop[k] = v; } });
    return this.section('Crop', false, side('l', 'Left'), side('r', 'Right'), side('t', 'Top'), side('b', 'Bottom'));
  }

  speedSec() {
    const presets = el('div', { class: 'vt-pad row' }, [0.25, 0.5, 1, 1.5, 2, 4].map((s) =>
      el('button', { class: 'btn vt-mini', onclick: () => this.edit('speed', (c, p) => setSpeed(p, c, s)) }, s + 'x')));
    return this.section('Speed', false,
      this.range('Speed', { min: 0.25, max: 4, step: 0.05, fmt: (v) => v.toFixed(2) + 'x', reset: 1, get: (c) => c.speed, set: (c, v, p) => setSpeed(p, c, v) }),
      presets,
      el('div', { class: 'vt-pad muted vt-small' }, 'Changing speed keeps the same footage and changes the clip length; it stops at the next clip.'));
  }

  audioSec() {
    return this.section('Audio', true,
      this.range('Volume', { min: 0, max: 2, step: 0.01, fmt: pct, reset: 1, get: (c) => c.volume, set: (c, v) => { c.volume = v; } }),
      this.check('Mute clip', (c) => c.muted, (v) => this.edit('mute', (c) => { c.muted = v; })));
  }

  fadeSec() {
    const max = (c) => Math.min(10, c.duration);
    return this.section('Fade in / out', true,
      this.range('Fade in', { min: 0, max: Math.max(0.1, max(this.cur())), step: 0.05, fmt: secs, reset: 0, get: (c) => c.fadeIn, set: (c, v) => { c.fadeIn = v; } }),
      this.range('Fade out', { min: 0, max: Math.max(0.1, max(this.cur())), step: 0.05, fmt: secs, reset: 0, get: (c) => c.fadeOut, set: (c, v) => { c.fadeOut = v; } }),
      el('div', { class: 'vt-pad muted vt-small' }, 'Fades apply to picture opacity and sound volume.'));
  }

  colorSec() {
    const col = (k, label, min, max, fmt = (v) => v) => this.range(label, { min, max, key: 'color' + k, fmt, reset: COLOR_DEFAULT[k], get: (c) => c.color[k], set: (c, v) => { c.color[k] = v; } });
    return this.section('Color', true,
      this.select('Look', LOOKS, (c) => c.look, (c, v) => { c.look = v; }),
      col('brightness', 'Brightness', 0, 200, (v) => v + '%'),
      col('contrast', 'Contrast', 0, 200, (v) => v + '%'),
      col('saturation', 'Saturation', 0, 200, (v) => v + '%'),
      col('hue', 'Hue', -180, 180, (v) => v + '°'),
      col('temperature', 'Temperature', -100, 100),
      col('blur', 'Blur', 0, 40, (v) => v + ' px'),
      col('vignette', 'Vignette', 0, 100, (v) => v + '%'),
      el('div', { class: 'vt-pad' }, el('button', { class: 'btn', onclick: () => this.edit('color-reset', (c) => { c.color = { ...COLOR_DEFAULT }; c.look = 'none'; }) }, 'Reset color')));
  }

  effectsSec() {
    const c = this.cur();
    const list = c.effects.map((fx, i) => {
      const def = EFFECTS[fx.type];
      if (!def) return null;
      const rm = el('button', { class: 'icon-btn', title: 'Remove effect', onclick: (e) => { e.preventDefault(); this.ed.store.mutate((p) => { p.clips.find((x) => x.id === c.id).effects.splice(i, 1); }); } }, iconEl('close', 14));
      if (def.fixed) return el('div', { class: 'field' }, el('span', {}, def.name), el('span', { class: 'muted' }, 'on'), rm);
      return this.range(def.name, { min: 0, max: 100, key: 'fx' + fx.id, fmt: (v) => v + '%', get: (x) => x.effects[i]?.amount ?? 0, set: (x, v) => { if (x.effects[i]) x.effects[i].amount = v; }, extra: rm });
    });
    const add = el('select', { onchange: () => { if (add.value) this.ed.actions.applyEffect(c.id, add.value); } },
      el('option', { value: '' }, 'Add effect…'), Object.entries(EFFECTS).map(([k, f]) => el('option', { value: k }, f.name)));
    return this.section(`Effects (${c.effects.length})`, true, ...list, el('div', { class: 'vt-pad' }, add),
      c.effects.length ? null : el('div', { class: 'vt-pad muted vt-small' }, 'Or drag one from the Effects tab onto a clip (on touch: select the clip and tap the effect).'));
  }

  chromaSec() {
    const gate = () => requirePro('Chroma key (green screen)');
    const pick = el('button', { class: 'btn', onclick: (e) => { e.preventDefault(); if (gate()) this.ed.pickColor(this.id); } }, iconEl('crosshair', 16), 'Pick from preview');
    return this.section(['Chroma key ', pro()], false,
      this.check('Enable', (c) => c.chroma.on, (v) => { if (v && !gate()) return false; this.edit('chroma-on', (c) => { c.chroma.on = v; }); }),
      this.color('Key color', (c) => c.chroma.color, (c, v) => { if (License.isPro()) c.chroma.color = v; }),
      this.range('Tolerance', { min: 0, max: 100, get: (c) => c.chroma.tol, set: (c, v) => { if (License.isPro()) c.chroma.tol = v; } }),
      this.range('Softness', { min: 0, max: 100, get: (c) => c.chroma.soft, set: (c, v) => { if (License.isPro()) c.chroma.soft = v; } }),
      el('div', { class: 'vt-pad' }, pick));
  }

  // ---------- no / multi selection ----------
  multi(sel) {
    const { actions } = this.ed;
    return el('div', { class: 'vt-pad vt-stack' },
      el('h3', {}, `${sel.length} clips selected`),
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: () => actions.duplicate() }, 'Duplicate'),
        el('button', { class: 'btn', onclick: () => actions.copy() }, 'Copy'),
        el('button', { class: 'btn danger', onclick: () => actions.deleteSelected(false) }, 'Delete')),
      el('p', { class: 'muted' }, 'Drag any selected clip to move them together. Shift-click (or turn on Select multiple in the timeline bar) to add or remove clips.'));
  }

  project() {
    const { store, actions } = this.ed;
    const p = store.p;
    const aspect = el('select', { onchange: () => this.ed.setAspect(aspect.value) }, Object.keys(ASPECTS).map((a) => el('option', { value: a }, a)));
    aspect.value = p.aspect;
    const kb = [['Space', 'Play / pause'], ['J K L', 'Shuttle back / stop / forward'], ['← →', 'Step one frame (Shift: 1 s)'], ['Home End', 'Go to start / end'],
      ['S', 'Split at playhead'], ['Del', 'Delete (Shift: ripple)'], ['⌘/Ctrl Z', 'Undo (Shift: redo)'], ['⌘/Ctrl C V D', 'Copy, paste, duplicate'],
      ['+ −', 'Timeline zoom'], ['N', 'Snapping on/off']];
    return el('div', { class: 'vt-stack' },
      this.section('Project', true,
        el('label', { class: 'field' }, el('span', {}, 'Aspect'), aspect, el('span')),
        el('div', { class: 'vt-pad muted' }, `${p.clips.length} clips · ${p.tracks.length} tracks${License.isPro() ? '' : ` (free: up to ${CONFIG.free.videoMaxTracks})`}`),
        el('div', { class: 'vt-pad row' }, el('button', { class: 'btn', onclick: () => actions.titleCard() }, 'Add a title card'))),
      this.section('Keyboard shortcuts', true, el('div', { class: 'vt-keys' }, kb.map(([k, d]) => [el('kbd', {}, k), el('span', {}, d)]))),
      el('p', { class: 'vt-pad muted' }, 'Select a clip in the timeline to edit it here.'));
  }
}
