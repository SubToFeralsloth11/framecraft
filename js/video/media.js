// Media bin store: imports files, probes duration/size, makes thumbnails and audio waveform peaks.
import { uid } from './model.js';

const EXT = {
  video: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'avi'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'],
};
export const ACCEPT = 'video/*,audio/*,image/*,' + Object.values(EXT).flat().map((e) => '.' + e).join(',');
const PEAKS_PER_SEC = 40;
const PEAKS_MAX_BYTES = 120 * 1024 * 1024;

export function kindOf(file) {
  const t = file.type || '';
  for (const k of ['video', 'audio', 'image']) if (t.startsWith(k + '/')) return k;
  const ext = file.name.split('.').pop().toLowerCase();
  return Object.keys(EXT).find((k) => EXT[k].includes(ext)) || null;
}

const once = (target, ok, ms = 15000) => new Promise((resolve, reject) => {
  const done = (e) => { clearTimeout(timer); target.removeEventListener(ok, done); target.removeEventListener('error', fail); resolve(e); };
  const fail = () => { clearTimeout(timer); target.removeEventListener(ok, done); reject(new Error('Could not read this file')); };
  const timer = setTimeout(() => { target.removeEventListener(ok, done); target.removeEventListener('error', fail); reject(new Error('Timed out reading this file')); }, ms);
  target.addEventListener(ok, done, { once: true });
  target.addEventListener('error', fail, { once: true });
});

// MediaRecorder webm files report Infinity until you seek past the end.
async function realDuration(el) {
  if (Number.isFinite(el.duration)) return el.duration;
  el.currentTime = 1e7;
  await Promise.race([once(el, 'durationchange', 5000).catch(() => {}), once(el, 'seeked', 5000).catch(() => {})]);
  const d = Number.isFinite(el.duration) ? el.duration : el.currentTime || 0;
  el.currentTime = 0;
  return d;
}

function thumbFrom(src, sw, sh) {
  const c = document.createElement('canvas');
  const k = Math.min(1, 192 / sw, 108 / sh);
  c.width = Math.max(1, Math.round(sw * k));
  c.height = Math.max(1, Math.round(sh * k));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.75);
}

async function computePeaks(file) {
  if (file.size > PEAKS_MAX_BYTES) return null;
  try {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const buf = await new OAC(1, 1, 44100).decodeAudioData(await file.arrayBuffer());
    const n = Math.max(1, Math.ceil(buf.duration * PEAKS_PER_SEC));
    const per = buf.length / n, out = new Float32Array(n);
    for (let ch = 0; ch < Math.min(2, buf.numberOfChannels); ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        let m = out[i];
        const end = Math.min(d.length, Math.floor((i + 1) * per));
        for (let j = Math.floor(i * per); j < end; j += 8) { const v = Math.abs(d[j]); if (v > m) m = v; }
        out[i] = m;
      }
    }
    return out;
  } catch {
    return null; // no decodable audio track
  }
}

async function probe(file, id) {
  const kind = kindOf(file);
  if (!kind) throw new Error(`${file.name}: unsupported file type`);
  const url = URL.createObjectURL(file);
  const item = { id: id || uid('m'), name: file.name, kind, file, url, size: file.size, duration: null, width: 0, height: 0, thumb: null, peaks: null, img: null };
  try {
    if (kind === 'image') {
      const img = new Image();
      img.src = url;
      await img.decode();
      Object.assign(item, { img, width: img.naturalWidth || 1280, height: img.naturalHeight || 720, thumb: url });
    } else {
      const el = document.createElement(kind === 'video' ? 'video' : 'audio');
      el.preload = 'auto';
      el.muted = true;
      el.playsInline = true;
      el.src = url;
      await once(el, 'loadedmetadata');
      item.duration = await realDuration(el);
      if (kind === 'video' && !el.videoWidth) item.kind = 'audio'; // audio-only container
      if (item.kind === 'video') {
        item.width = el.videoWidth;
        item.height = el.videoHeight;
        el.currentTime = Math.min(1, item.duration * 0.1);
        await once(el, 'seeked', 8000).catch(() => {});
        if (el.readyState >= 2) item.thumb = thumbFrom(el, el.videoWidth, el.videoHeight);
      }
      el.removeAttribute('src');
      el.load();
      if (!item.duration) throw new Error(`${file.name}: could not read duration`);
      item.peaks = await computePeaks(file);
    }
  } catch (e) {
    URL.revokeObjectURL(url);
    throw new Error(e.message.startsWith(file.name) ? e.message : `${file.name}: ${e.message}`);
  }
  return item;
}

export class MediaBin {
  constructor() { this.items = new Map(); this.listeners = new Set(); }
  on(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  emit() { this.listeners.forEach((cb) => cb()); }
  get(id) { return id ? this.items.get(id) : null; }
  list() { return [...this.items.values()]; }

  // Imports files; returns { added, errors }. Imports run one at a time to keep memory low.
  async add(files, ids = []) {
    const added = [], errors = [];
    for (let i = 0; i < files.length; i++) {
      try {
        const item = await probe(files[i], ids[i]);
        this.items.set(item.id, item);
        added.push(item);
        this.emit();
      } catch (e) { errors.push(e.message); }
    }
    return { added, errors };
  }

  remove(id) {
    const it = this.items.get(id);
    if (!it) return;
    URL.revokeObjectURL(it.url);
    this.items.delete(id);
    this.emit();
  }
}
