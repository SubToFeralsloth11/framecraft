// Project state with snapshot-based undo/redo and change notifications.
import { newProject, normalize } from './model.js';

const MAX_HISTORY = 120;

export class Store {
  constructor() {
    this.p = newProject();
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.lastKey = null;
    this.lastAt = 0;
    this.selection = new Set();
  }

  on(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  emit(info) { this.listeners.forEach((cb) => cb(info)); }

  // Runs fn(project) as one undoable step. `coalesce` merges rapid edits with the same key
  // (slider drags) into a single history entry. `source` lets the originating UI skip its own rebuild.
  mutate(fn, { coalesce = null, source = null } = {}) {
    const before = JSON.stringify(this.p);
    const r = fn(this.p);
    normalize(this.p);
    const after = JSON.stringify(this.p);
    if (after === before) return r;
    const now = performance.now();
    if (!(coalesce && coalesce === this.lastKey && now - this.lastAt < 1500)) {
      this.undoStack.push(before);
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    }
    this.lastKey = coalesce;
    this.lastAt = now;
    this.redoStack.length = 0;
    this.pruneSelection();
    this.emit({ type: 'edit', source });
    return r;
  }

  undo() { this.travel(this.undoStack, this.redoStack); }
  redo() { this.travel(this.redoStack, this.undoStack); }

  travel(from, to) {
    if (!from.length) return false;
    to.push(JSON.stringify(this.p));
    this.p = JSON.parse(from.pop());
    this.lastKey = null;
    this.pruneSelection();
    this.emit({ type: 'history' });
    return true;
  }

  // Replaces the whole project (open file); clears history.
  load(project) {
    this.p = normalize(project);
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.lastKey = null;
    this.selection.clear();
    this.emit({ type: 'load' });
  }

  clip(id) { return this.p.clips.find((c) => c.id === id) || null; }
  selected() { return this.p.clips.filter((c) => this.selection.has(c.id)); }

  select(ids, additive = false) {
    if (!additive) this.selection.clear();
    for (const id of ids) {
      if (additive && this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
    }
    this.emit({ type: 'select' });
  }

  pruneSelection() {
    const ids = new Set(this.p.clips.map((c) => c.id));
    for (const id of [...this.selection]) if (!ids.has(id)) this.selection.delete(id);
  }
}
