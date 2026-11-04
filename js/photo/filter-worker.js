// Module worker: runs pixel filters off the main thread.
// Message in:  { id, op, params, data (Uint8ClampedArray), w, h, info, mask (Uint8Array|null) }
// Message out: { id, data } or { id, error }
import { runFilter } from './pixels.js';

self.onmessage = ({ data: job }) => {
  try {
    const out = runFilter(job.op, job.data, job.w, job.h, job.params, job.info, job.mask);
    self.postMessage({ id: job.id, data: out }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id: job.id, error: String(err?.message || err) });
  }
};
