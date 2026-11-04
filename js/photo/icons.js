// Inline SVG icons (24×24, stroked with currentColor).
const P = (d) => `<path d="${d}"/>`;

const ICONS = {
  move: P('M12 2v20M2 12h20M12 2 9 5M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3'),
  marquee: '<rect x="4" y="5" width="16" height="14" stroke-dasharray="3 2.2"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7" stroke-dasharray="3 2.2"/>',
  lasso: P('M7 17c-3-2-4-5-2-8 3-5 12-5 14 0 2 4-3 7-8 7-2 0-3-.5-4-1M7 17c0 2-1 3-2 4M7 17c1.2 0 2 .8 2 2'),
  wand: P('M4 20 15 9M15 9l2-2M18 2v3M21 5h-3M14 3l1 1M21 10l-1-1M19.5 3.5l-1 1'),
  crop: P('M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14'),
  dropper: P('m2 22 1-4 9-9 4 4-9 9-4 1zM14 7l3-3a2.1 2.1 0 0 1 3 3l-3 3M12 5l7 7'),
  brush: P('m18 3 3 3-9 9-3-3zM9 12c-3 0-5 2-5 4s-1 3-2 4c3 0 8 0 9-3 .5-1.5 0-3-2-5'),
  pencil: P('m17 3 4 4L8 20H4v-4zM14 6l4 4'),
  eraser: P('M8 21h12M5 15l9-9a2 2 0 0 1 3 0l3 3a2 2 0 0 1 0 3l-8 8H9l-4-4a1.5 1.5 0 0 1 0-1zM9 11l6 6'),
  bucket: P('M19 11 11 3 3 11l8 8zM3 11h16M20 15s2 2.5 2 4a2 2 0 0 1-4 0c0-1.5 2-4 2-4z'),
  gradient: '<rect x="3" y="3" width="18" height="18" rx="2"/>' + P('M3 15 15 3M3 21 21 3M9 21 21 9'),
  stamp: P('M5 22h14M5 18h14v-3a2 2 0 0 0-2-2h-3l-.5-3a3.5 3.5 0 1 0-5 0L8 13H7a2 2 0 0 0-2 2z'),
  drop: P('M12 2s7 7.5 7 13a7 7 0 0 1-14 0c0-5.5 7-13 7-13z'),
  sun: '<circle cx="12" cy="12" r="4"/>' + P('M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'),
  finger: P('M9 11V5a2 2 0 0 1 4 0v6M13 10a2 2 0 0 1 4 0v4a7 7 0 0 1-7 7 6 6 0 0 1-5-3l-2-4a2 2 0 0 1 3.5-2L9 14'),
  text: P('M4 7V4h16v3M9 20h6M12 4v16'),
  shapes: '<rect x="3" y="3" width="10" height="10" rx="1"/><circle cx="16" cy="16" r="5"/>',
  hand: P('M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15'),
  zoom: '<circle cx="11" cy="11" r="7"/>' + P('m21 21-5-5M11 8v6M8 11h6'),
  plus: P('M12 5v14M5 12h14'),
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/>' + P('M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3'),
  merge: P('M12 3v12M7 10l5 5 5-5M4 20h16'),
  up: P('M12 19V5M6 11l6-6 6 6'),
  down: P('M12 5v14M6 13l6 6 6-6'),
  trash: P('M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6'),
  eye: P('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z') + '<circle cx="12" cy="12" r="3"/>',
  eyeOff: P('M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2'),
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/>' + P('M8 11V7a4 4 0 0 1 8 0v4'),
  unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/>' + P('M8 11V7a4 4 0 0 1 7.5-2'),
  undo: P('M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3'),
  redo: P('m15 14 5-5-5-5M20 9H9a5 5 0 0 0 0 10h3'),
  rotL: P('M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5'),
  rotR: P('M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5'),
  flipH: P('M12 3v18M8 7 3 12l5 5zM16 7l5 5-5 5z'),
  flipV: P('M3 12h18M7 8l5-5 5 5zM7 16l5 5 5-5z'),
  file: P('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M12 12v6M9 15h6'),
  open: P('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'),
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/>' + P('m21 15-5-5L5 21'),
  save: P('M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8'),
  export: P('M12 15V3M7 8l5-5 5 5M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4'),
  resize: P('M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7'),
  canvas: '<rect x="6" y="6" width="12" height="12"/>' + P('M2 6h2M2 18h2M20 6h2M20 18h2M6 2v2M18 2v2M6 20v2M18 20v2'),
  swap: P('M7 4 3 8l4 4M3 8h13a4 4 0 0 1 4 4M17 20l4-4-4-4M21 16H8a4 4 0 0 1-4-4'),
};

export function icon(name) {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// Icon as a DOM node (for use as a child with ui.el()).
export function iconEl(name) {
  const t = document.createElement('template');
  t.innerHTML = icon(name);
  return t.content.firstChild;
}
