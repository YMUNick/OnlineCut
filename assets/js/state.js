// 編輯器狀態：專案、選取、縮放等，以及 undo/redo。UI 透過 on('change') 重新繪製。

import { createProject, getClip } from './core/project.js';
import { History } from './core/history.js';

export class Store {
  constructor(project = createProject()) {
    this.project = project;
    this.selection = [];        // 選取的片段 id
    this.pxPerSec = 60;         // 時間軸縮放
    this.snap = true;
    this.ripple = false;
    this.history = new History();
    this.listeners = new Map();
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  emit(event, detail) {
    for (const fn of this.listeners.get(event) ?? []) fn(detail);
  }

  /** 套用新的專案狀態並記錄 undo。key：同 key 的連續操作合併 */
  commit(next, { key = null, select = null } = {}) {
    if (next === this.project) return false;
    this.history.record(this.project, key);
    this.project = next;
    if (select) this.selection = select;
    this.pruneSelection();
    this.emit('change', { type: 'project' });
    return true;
  }

  /** 換成全新的專案（開新專案 / 讀檔），清除 undo */
  replace(project) {
    this.project = project;
    this.selection = [];
    this.history.clear();
    this.emit('change', { type: 'replace' });
  }

  undo() {
    const prev = this.history.undo(this.project);
    if (!prev) return false;
    this.project = prev;
    this.pruneSelection();
    this.emit('change', { type: 'project' });
    return true;
  }

  redo() {
    const next = this.history.redo(this.project);
    if (!next) return false;
    this.project = next;
    this.pruneSelection();
    this.emit('change', { type: 'project' });
    return true;
  }

  pruneSelection() {
    this.selection = this.selection.filter(id => getClip(this.project, id));
  }

  select(ids, { add = false } = {}) {
    const list = Array.isArray(ids) ? ids : [ids];
    if (add) {
      const set = new Set(this.selection);
      for (const id of list) set.has(id) ? set.delete(id) : set.add(id);
      this.selection = [...set];
    } else {
      this.selection = list.filter(Boolean);
    }
    this.emit('change', { type: 'selection' });
  }

  get selectedClip() {
    return this.selection.length === 1 ? getClip(this.project, this.selection[0]) : null;
  }

  setView(patch) {
    Object.assign(this, patch);
    this.emit('change', { type: 'view' });
  }
}
