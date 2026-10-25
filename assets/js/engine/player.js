// 播放引擎：以系統時鐘推進時間軸，讓每個片段專屬的 <video>/<audio> 跟著同步，
// 聲音經過 WebAudio（可以放大到 200%、做淡入淡出），畫面畫到預覽 canvas。

import { clipGainAt, sourceTime, getDuration, clipEnd } from '../core/project.js';
import { visualClipsAt, visualRange, visualSourceTime } from '../core/transitions.js';
import { clamp } from '../core/time.js';
import { drawFrame } from './renderer.js';

const DRIFT_TOLERANCE = 0.2;   // 播放時影片與時間軸差超過這麼多秒才重新對齊
const PRELOAD_AHEAD = 2;       // 提前幾秒準備即將出現的片段
const MAX_ELEMENTS = 16;       // 同時保留的媒體元素上限

export class Player {
  constructor({ canvas, runtime, getProject, onTime, onState, onFrame, silent = false }) {
    this.silent = silent; // 不出聲（匯出備援用：聲音另外混好）
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.runtime = runtime;
    this.getProject = getProject;
    this.onTime = onTime || (() => {});
    this.onState = onState || (() => {});
    this.onFrame = onFrame || (() => {});
    this.time = 0;
    this.playing = false;
    this.elements = new Map(); // clipId → { el, gain, node, mediaId, lastUsed }
    this.master = null;
    this.raf = 0;
    this.renderQueued = false;
    this.layouts = new Map();
    this.loop = this.loop.bind(this);
  }

  // ---------- 音訊 ----------
  audio() {
    const ctx = this.runtime.ctx();
    if (!this.master) {
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
    }
    return ctx;
  }

  setMasterVolume(v) {
    this.audio();
    this.master.gain.value = clamp(v, 0, 1);
  }

  // ---------- 媒體元素 ----------
  element(clip) {
    if (clip.type !== 'video' && clip.type !== 'audio') return null;
    let rec = this.elements.get(clip.id);
    const item = this.runtime.get(clip.mediaId);
    if (!item) return null;
    if (rec && rec.mediaId !== clip.mediaId) { this.dispose(clip.id); rec = null; }
    if (!rec) {
      const el = document.createElement(clip.type === 'video' ? 'video' : 'audio');
      el.preload = 'auto';
      el.playsInline = true;
      el.crossOrigin = 'anonymous';
      el.src = item.url;
      el.preservesPitch = false; // 跟匯出時的變速音訊一致
      el.addEventListener('seeked', () => this.requestRender());
      el.addEventListener('loadeddata', () => this.requestRender());
      rec = { el, mediaId: clip.mediaId, gain: null, node: null, lastUsed: performance.now() };
      if (this.silent) el.muted = true;
      else try {
        const ctx = this.audio();
        rec.node = ctx.createMediaElementSource(el);
        rec.gain = ctx.createGain();
        rec.gain.gain.value = 0;
        rec.node.connect(rec.gain).connect(this.master);
      } catch {
        el.volume = 0; // WebAudio 不能用時退回元素音量
      }
      this.elements.set(clip.id, rec);
      this.trim();
    }
    rec.lastUsed = performance.now();
    return rec;
  }

  dispose(clipId) {
    const rec = this.elements.get(clipId);
    if (!rec) return;
    rec.el.pause();
    try { rec.node?.disconnect(); rec.gain?.disconnect(); } catch { /* 已斷開 */ }
    rec.el.removeAttribute('src');
    rec.el.load();
    this.elements.delete(clipId);
  }

  /** 釋放不在附近、最久沒用到的元素 */
  trim() {
    if (this.elements.size <= MAX_ELEMENTS) return;
    const p = this.getProject();
    const near = new Set(p.clips.filter(c => c.start <= this.time + PRELOAD_AHEAD && clipEnd(c) >= this.time - 1).map(c => c.id));
    const victims = [...this.elements.entries()]
      .filter(([id]) => !near.has(id))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (this.elements.size > MAX_ELEMENTS && victims.length) this.dispose(victims.shift()[0]);
  }

  /** 專案變動後清掉已刪除片段的元素 */
  syncProject() {
    const ids = new Set(this.getProject().clips.map(c => c.id));
    for (const id of [...this.elements.keys()]) if (!ids.has(id)) this.dispose(id);
    this.requestRender();
  }

  setGain(rec, value) {
    if (this.silent) return;
    if (rec.gain) rec.gain.gain.value = value;
    else rec.el.volume = clamp(value, 0, 1);
  }

  // ---------- 時間控制 ----------
  get duration() { return getDuration(this.getProject()); }

  async play() {
    if (this.playing) return;
    const ctx = this.silent ? null : this.audio();
    if (ctx && ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* 沒有使用者手勢 */ } }
    if (this.time >= this.duration - 1e-3) this.time = 0;
    if (this.duration <= 0) return;
    this.playing = true;
    this.clockStart = performance.now();
    this.timeStart = this.time;
    this.onState(true);
    this.syncMedia(true);
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.loop);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    for (const rec of this.elements.values()) rec.el.pause();
    this.onState(false);
    this.seek(this.time);
  }

  toggle() { return this.playing ? this.pause() : this.play(); }

  seek(t) {
    this.time = clamp(t, 0, Math.max(0, this.duration));
    if (this.playing) {
      this.clockStart = performance.now();
      this.timeStart = this.time;
      this.syncMedia(true);
    } else {
      this.syncMedia(true);
      this.requestRender();
    }
    this.onTime(this.time);
  }

  loop(now) {
    if (!this.playing) return;
    const t = this.timeStart + (now - this.clockStart) / 1000;
    const end = this.duration;
    if (t >= end) {
      this.time = end;
      this.render();
      this.onTime(this.time);
      this.pause();
      return;
    }
    this.time = t;
    this.syncMedia(false);
    this.render();
    this.onTime(this.time);
    this.raf = requestAnimationFrame(this.loop);
  }

  /** 讓每個媒體元素對齊時間軸；force = true 時一定重新定位 */
  syncMedia(force) {
    const p = this.getProject();
    const t = this.time;
    const active = new Set();
    // 轉場時前後兩段都要有畫面：多出來的部分不出聲，素材不夠時停在第一格 / 最後一格
    for (const clip of visualClipsAt(p, t, { includeHidden: true })) {
      if (clip.type !== 'video' && clip.type !== 'audio') continue;
      const rec = this.element(clip);
      if (!rec) continue;
      active.add(clip.id);
      const el = rec.el;
      const inRange = t >= clip.start && t < clipEnd(clip);
      const target = visualSourceTime(p, clip, t);
      const frozen = Math.abs(target - sourceTime(clip, t)) > 1e-3;
      if (el.playbackRate !== clip.speed) el.playbackRate = clip.speed;
      this.setGain(rec, inRange ? clipGainAt(p, clip, t) : 0);
      if (frozen) {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - target) > 0.5 / p.fps) el.currentTime = target;
      } else if (this.playing) {
        if (force || el.paused || Math.abs(el.currentTime - target) > DRIFT_TOLERANCE) {
          if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
        }
        if (el.paused) el.play().catch(() => {});
      } else {
        if (!el.paused) el.pause();
        if (force && Math.abs(el.currentTime - target) > 0.5 / p.fps) el.currentTime = target;
      }
    }
    // 停掉不在畫面上的；預先定位即將出現的
    for (const [id, rec] of this.elements) {
      if (active.has(id)) continue;
      if (!rec.el.paused) rec.el.pause();
      this.setGain(rec, 0);
    }
    for (const clip of p.clips) {
      if ((clip.type !== 'video' && clip.type !== 'audio') || active.has(clip.id)) continue;
      const [vs] = visualRange(p, clip);
      if (vs > t && vs - t < PRELOAD_AHEAD) {
        const rec = this.element(clip);
        const at = visualSourceTime(p, clip, vs);
        if (rec && rec.el.paused && Math.abs(rec.el.currentTime - at) > 0.1) rec.el.currentTime = at;
      }
    }
  }

  // ---------- 畫面 ----------
  requestRender() {
    if (this.renderQueued || this.playing) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  /** 畫面上有影片正在跳到新的位置（這時畫不出東西） */
  seekingVideo(p) {
    return visualClipsAt(p, this.time).some(c => {
      const el = c.type === 'video' && this.elements.get(c.id)?.el;
      return el && el.seeking && el.readyState < 2;
    });
  }

  render(force = false) {
    const p = this.getProject();
    // 影片定位中先保留上一格，等 seeked 再畫，避免閃一下黑畫面（暫停、拖曳播放頭時）
    clearTimeout(this.fallbackRender);
    if (!force && this.seekingVideo(p)) {
      this.fallbackRender = setTimeout(() => this.render(true), 500);
      return;
    }
    this.layouts = drawFrame(this.ctx, p, this.time, {
      hideTextFor: this.hideTextFor, // 正在預覽上直接編輯的文字：字由輸入框顯示
      getSource: (clip) => {
        if (clip.type === 'image') return this.runtime.get(clip.mediaId)?.image;
        if (clip.type === 'video') return this.elements.get(clip.id)?.el;
        return null;
      },
      getMediaInfo: (clip) => p.media[clip.mediaId],
    });
    this.onFrame(this.layouts);
  }

  destroy() {
    clearTimeout(this.fallbackRender);
    this.pause();
    for (const id of [...this.elements.keys()]) this.dispose(id);
  }
}
