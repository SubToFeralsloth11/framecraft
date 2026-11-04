// Export: real-time render of the timeline through canvas.captureStream + MediaRecorder (audio mixed
// via a MediaStreamDestination), current frame as PNG, or audio only.
import { CONFIG } from '../config.js';
import { License, requirePro, drawWatermark } from '../license.js';
import { el, modal, toast, download } from '../ui.js';
import { frameSize, timecode, FPS } from './model.js';

const RESOLUTIONS = [
  { short: 480, label: '480p', bitrate: 2_500_000 },
  { short: 720, label: '720p', bitrate: 5_000_000 },
  { short: 1080, label: '1080p (Full HD)', bitrate: 9_000_000 },
  { short: 2160, label: '4K (2160p)', bitrate: 35_000_000 },
];
const VIDEO_MIMES = [
  'video/mp4;codecs=avc1.640033,mp4a.40.2', 'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,opus', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
];
const AUDIO_MIMES = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];

export const pickMime = (list) => (window.MediaRecorder ? list.find((t) => MediaRecorder.isTypeSupported(t)) || null : null);
const extOf = (mime) => (mime.includes('mp4') ? (mime.startsWith('audio') ? 'm4a' : 'mp4') : mime.includes('ogg') ? 'ogg' : 'webm');

export function openExport(ed) {
  const { engine } = ed;
  const dur = engine.duration();
  if (!dur) return toast('Add something to the timeline first', 'warn');
  const pro = License.isPro();
  const cap = pro ? Infinity : CONFIG.free.videoMaxHeight;
  const res = el('select', {}, RESOLUTIONS.map((r) => el('option', { value: r.short }, r.label + (r.short > cap ? ' — PRO' : ''))));
  res.value = String(pro ? 1080 : CONFIG.free.videoMaxHeight);
  const fps = el('select', {}, [24, 30, 60].map((f) => el('option', { value: f }, `${f} fps`)));
  fps.value = String(FPS);
  const info = el('div', { class: 'muted' });
  const vMime = pickMime(VIDEO_MIMES);
  const end = pro ? dur : Math.min(dur, CONFIG.free.videoMaxSeconds);
  const refresh = () => {
    const { w, h } = frameSize(ed.store.p.aspect, +res.value);
    info.textContent = `${w}×${h} · ${timecode(end)} · ${vMime ? (vMime.includes('mp4') ? 'MP4 (H.264)' : 'WebM') : 'not supported in this browser'}`;
  };
  res.addEventListener('change', () => {
    if (+res.value > cap && !requirePro('Export above 720p')) res.value = String(CONFIG.free.videoMaxHeight);
    refresh();
  });
  refresh();
  const opts = () => ({ ...RESOLUTIONS.find((r) => r.short === +res.value), fps: +fps.value, end });
  const body = el('div', { class: 'modal-body vt-export' },
    el('label', { class: 'field' }, el('span', {}, 'Resolution'), res, el('span')),
    el('label', { class: 'field' }, el('span', {}, 'Frame rate'), fps, el('span')),
    info,
    pro ? null : el('div', { class: 'vt-note' },
      el('span', { class: 'pro-badge' }, 'FREE'), ` Up to ${CONFIG.free.videoMaxHeight}p, the first ${CONFIG.free.videoMaxSeconds} s of the timeline, with a small watermark. `,
      el('a', { href: '#', onclick: (e) => { e.preventDefault(); requirePro('Unlimited video export'); } }, 'Go Pro'), ' for 4K, full length and no watermark.'),
    !pro && dur > end ? el('div', { class: 'vt-note warn' }, `Your timeline is ${timecode(dur)} long; the free export stops at ${timecode(end)}.`) : null,
    el('div', { class: 'muted vt-small' }, 'Export plays the timeline in real time. Keep this tab visible until it finishes.'),
    el('div', { class: 'row vt-wrap' },
      el('button', { class: 'btn primary', disabled: !vMime, onclick: () => { dlg.close(); exportVideo(ed, opts(), vMime); } }, '⬇ Export video'),
      el('button', { class: 'btn', onclick: () => { dlg.close(); exportFrame(ed, opts()); } }, '🖼 Current frame (PNG)'),
      el('button', { class: 'btn', onclick: () => { dlg.close(); exportAudio(ed, opts()); } }, '♪ Audio only')));
  const dlg = modal('Export', body);
}

function outputSize(ed, short) {
  const s = License.isPro() ? short : Math.min(short, CONFIG.free.videoMaxHeight);
  return frameSize(ed.store.p.aspect, s);
}

async function exportFrame(ed, o) {
  const { w, h } = outputSize(ed, o.short);
  const canvas = el('canvas', { width: w, height: h });
  const ctx = canvas.getContext('2d');
  await ed.engine.renderStill(ctx, w, h);
  drawWatermark(ctx, w, h);
  canvas.toBlob((b) => { download(b, `frame-${timecode(ed.engine.t).replace(/:/g, '-')}.png`); toast('Frame saved', 'ok'); }, 'image/png');
}

async function exportVideo(ed, o, mime) {
  const { w, h } = outputSize(ed, o.short);
  const canvas = el('canvas', { width: w, height: h });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const video = canvas.captureStream(o.fps);
  const audio = ed.engine.audioStream();
  await record(ed, {
    title: `Exporting ${w}×${h} video`, mime, end: o.end, job: { canvas, ctx, W: w, H: h },
    tracks: [...video.getVideoTracks(), ...audio.stream.getAudioTracks()],
    options: { videoBitsPerSecond: o.bitrate, audioBitsPerSecond: 192_000 },
    cleanup: () => { audio.stop(); video.getTracks().forEach((t) => t.stop()); },
    filename: `framecraft-video.${extOf(mime)}`,
  });
}

async function exportAudio(ed, o) {
  const p = ed.store.p;
  if (!p.clips.some((c) => c.mediaId && ed.media.get(c.mediaId)?.kind !== 'image')) return toast('There is no audio on the timeline', 'warn');
  const mime = pickMime(AUDIO_MIMES);
  if (!mime) return toast('This browser cannot record audio', 'err');
  const audio = ed.engine.audioStream();
  await record(ed, {
    title: 'Exporting audio', mime, end: o.end, job: {},
    tracks: audio.stream.getAudioTracks(),
    options: { audioBitsPerSecond: 192_000 },
    cleanup: () => audio.stop(),
    filename: `framecraft-audio.${extOf(mime)}`,
  });
}

async function record(ed, { title, mime, end, job, tracks, options, cleanup, filename }) {
  const { engine } = ed;
  let rec;
  try {
    rec = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, ...options });
  } catch (e) {
    cleanup();
    return toast(`Recording failed to start: ${e.message}`, 'err', 5000);
  }
  const chunks = [];
  let state = 'running';
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  let finish;
  const stopped = new Promise((resolve) => { finish = resolve; rec.onstop = resolve; });
  const bar = el('progress', { max: 1, value: 0 });
  const status = el('div', { class: 'muted' }, 'Preparing…');
  let t0 = 0;
  const exportJob = {
    ...job, end,
    onFrame: (t) => {
      bar.value = Math.min(1, t / end);
      const spent = (performance.now() - t0) / 1000;
      const left = t > 0.5 ? Math.max(0, (spent / t) * (end - t)) : end;
      status.textContent = `${timecode(t)} / ${timecode(end)} · about ${Math.ceil(left)} s left`;
    },
    onDone: () => { if (rec.state !== 'inactive') rec.stop(); else finish(); },
  };
  const cancel = () => {
    if (state !== 'running') return;
    state = 'cancelled';
    exportJob.cancelled = true;
    engine.cancelExport();
    if (rec.state !== 'inactive') rec.stop(); else finish();
  };
  const dlg = modal(title, el('div', { class: 'modal-body vt-export' }, bar, status,
    el('div', { class: 'row' }, el('button', { class: 'btn danger', onclick: () => cancel() }, 'Cancel'))), { onClose: cancel });
  await engine.startExport(exportJob);
  if (state === 'running') { t0 = performance.now(); rec.start(1000); }
  await stopped;
  cleanup();
  if (state === 'cancelled') { toast('Export cancelled', 'warn'); return; }
  state = 'done';
  dlg.close();
  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  download(blob, filename);
  toast(`Exported ${(blob.size / 1048576).toFixed(1)} MB`, 'ok', 4000);
}
