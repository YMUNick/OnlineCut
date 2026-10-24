// Undo / Redo：保存專案快照。連續的同類操作（例如拖動滑桿）會合併成一步。

export class History {
  constructor({ limit = 200, coalesceMs = 800 } = {}) {
    this.limit = limit;
    this.coalesceMs = coalesceMs;
    this.past = [];
    this.future = [];
    this.lastKey = null;
    this.lastTime = 0;
  }

  /** 記錄「改變前」的狀態。key 相同且間隔很短時視為同一步 */
  record(prevState, key = null, now = Date.now()) {
    if (key && key === this.lastKey && now - this.lastTime < this.coalesceMs) {
      this.lastTime = now;
      return;
    }
    this.past.push(prevState);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    this.lastKey = key;
    this.lastTime = now;
  }

  undo(current) {
    if (!this.past.length) return null;
    this.future.push(current);
    this.lastKey = null;
    return this.past.pop();
  }

  redo(current) {
    if (!this.future.length) return null;
    this.past.push(current);
    this.lastKey = null;
    return this.future.pop();
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  clear() {
    this.past = [];
    this.future = [];
    this.lastKey = null;
  }
}
