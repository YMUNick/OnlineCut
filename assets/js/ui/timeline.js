// 時間軸：繪製軌道與片段，處理拖曳移動、修剪、吸附、播放頭拖曳、縮放與素材拖放

import {
  clipEnd, getClip, getTrack, canHost, moveClip, placeClip, trimClip, mediaLimit, snapPoints, snapClipStart, snapTime,
  getDuration, sourceTime, TRACK_KIND_FOR_TYPE, updateTrack, removeTrack, updateClip, audioFadesOf,
} from '../core/project.js';
import { rulerStep, formatRulerLabel, clamp } from '../core/time.js';
import { icon } from './icons.js';
import { escapeHtml } from './dialogs.js';
import { _t } from '../i18n.js';

export const PAD = 16;             // 時間 0 左邊的留白（px）
const SNAP_PX = 8;                 // 吸附距離（px）
const MIN_PPS = 2, MAX_PPS = 600;  // 每秒像素範圍
const TYPE_ICON = { video: 'film', image: 'image', text: 'type', audio: 'music' };

// 從素材庫拖進時間軸時，dragover 讀不到 dataTransfer 的內容，所以另外記住
export const dragPayload = { media: null };

export const ppsToSlider = (pps) => Math.round(100 * Math.log(pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS));
export const sliderToPps = (v) => MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, v / 100);

export class Timeline {
  constructor({ store, runtime, els, getTime, onSeek, onScrubStart, onDropMedia }) {
    this.store = store;
    this.runtime = runtime;
    this.els = els;
    this.getTime = getTime;
    this.onSeek = onSeek;
    this.onScrubStart = onScrubStart || (() => {});
    this.onDropMedia = onDropMedia;
    this.rows = new Map();
    this.clipEls = new Map();
    this.drag = null;
    this.bgQueued = false;
    this.trackH = 64;

    this.bindScroll();
    this.bindRuler();
    this.bindTracks();
    this.bindDrop();
    runtime.onChange(() => this.queueBackgrounds());
    new ResizeObserver(() => { this.renderRuler(); this.layoutContent(); this.queueBackgrounds(); }).observe(els.scroll);
  }

  get pps() { return this.store.pxPerSec; }
  timeToX(t) { return PAD + t * this.pps; }
  xToTime(x) { return (x - PAD) / this.pps; }

  /** 滑鼠在捲動區內的 x → 時間 */
  clientXToTime(clientX) {
    const r = this.els.scroll.getBoundingClientRect();
    return this.xToTime(clientX - r.left + this.els.scroll.scrollLeft);
  }

  // ============================================================
  // 繪製
  // ============================================================
  render() {
    this.trackH = parseFloat(getComputedStyle(this.els.scroll).getPropertyValue('--track-h')) || 64;
    this.renderHeads();
    this.renderTracks();
    this.layoutContent();
    this.renderRuler();
    this.updatePlayhead(this.getTime());
    this.queueBackgrounds();
  }

  layoutContent() {
    const p = this.store.project;
    const viewW = this.els.scroll.clientWidth;
    const w = Math.max(viewW, this.timeToX(getDuration(p) + Math.max(30, viewW / this.pps * 0.5)));
    this.els.content.style.width = `${w}px`;
    const step = rulerStep(this.pps);
    this.els.tracks.style.setProperty('--grid', `${step * this.pps}px`);
  }

  renderHeads() {
    const p = this.store.project;
    const list = this.els.headList;
    list.innerHTML = '';
    const counts = { video: p.tracks.filter(t => t.kind === 'video').length, audio: p.tracks.filter(t => t.kind === 'audio').length };
    for (const t of p.tracks) {
      const row = document.createElement('div');
      row.className = 'tl-head';
      const vis = t.kind === 'video'
        ? `<button class="icon-btn ${t.hidden ? 'on' : ''}" data-act="hidden" title="${t.hidden ? _t('顯示軌道') : _t('隱藏軌道')}" aria-pressed="${t.hidden}">${icon(t.hidden ? 'eyeOff' : 'eye')}</button>`
        : '';
      row.innerHTML = `
        <span class="kind ${t.kind}"></span><span class="name">${escapeHtml(t.name)}</span>
        ${vis}
        <button class="icon-btn ${t.muted ? 'on' : ''}" data-act="muted" title="${t.muted ? _t('取消靜音') : _t('靜音')}" aria-pressed="${t.muted}">${icon(t.muted ? 'volumeOff' : 'volume')}</button>
        <button class="icon-btn ${t.locked ? 'on' : ''}" data-act="locked" title="${t.locked ? _t('解鎖') : _t('鎖定')}" aria-pressed="${t.locked}">${icon(t.locked ? 'lock' : 'unlock')}</button>
        <span class="spacer"></span>
        ${counts[t.kind] > 1 ? `<button class="icon-btn" data-act="remove" title="${_t('刪除軌道')}">${icon('close', 'icon-sm')}</button>` : ''}`;
      row.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        const proj = this.store.project;
        if (act === 'remove') {
          const n = proj.clips.filter(c => c.trackId === t.id).length;
          this.store.commit(removeTrack(proj, t.id));
          if (n) this.emitToast?.(_t('已刪除軌道 {track} 與 {n} 個片段', { track: t.name, n }), { undo: true });
        } else {
          this.store.commit(updateTrack(proj, t.id, { [act]: !t[act] }));
        }
      });
      list.appendChild(row);
    }
    list.scrollTop = this.els.scroll.scrollTop;
  }

  renderTracks() {
    const p = this.store.project;
    const sel = new Set(this.store.selection);
    const seenRows = new Set();
    p.tracks.forEach((t) => {
      let row = this.rows.get(t.id);
      if (!row) {
        row = document.createElement('div');
        row.className = 'tl-track';
        row.dataset.trackId = t.id;
        this.rows.set(t.id, row);
      }
      row.dataset.kind = t.kind;
      row.classList.toggle('locked', t.locked);
      row.classList.toggle('hidden-track', t.hidden);
      this.els.tracks.appendChild(row); // appendChild 會照順序搬動
      seenRows.add(t.id);
    });
    for (const [id, row] of this.rows) if (!seenRows.has(id)) { row.remove(); this.rows.delete(id); }

    const seenClips = new Set();
    for (const c of p.clips) {
      let el = this.clipEls.get(c.id);
      if (!el) {
        el = document.createElement('div');
        el.dataset.clipId = c.id;
        el.innerHTML = `<canvas class="clip-bg"></canvas><div class="clip-fade in"></div><div class="clip-fade out"></div><div class="clip-afade in"></div><div class="clip-afade out"></div><div class="clip-label"></div><div class="clip-handle l" data-edge="start"></div><div class="clip-handle r" data-edge="end"></div>`
          + `<span class="fade-dot" data-fade="in"></span><span class="fade-dot" data-fade="out"></span><span class="fade-dot audio" data-fade="in" data-audio></span><span class="fade-dot audio" data-fade="out" data-audio></span>`;
        this.clipEls.set(c.id, el);
      }
      el.className = `clip ${c.type}${sel.has(c.id) ? ' selected' : ''}`;
      el.style.left = `${this.timeToX(c.start)}px`;
      const w = c.duration * this.pps;
      el.style.width = `${Math.max(2, w)}px`;
      // 很短的片段：修剪把手變細，太短就拿掉，讓中間永遠抓得到可以移動
      el.classList.toggle('narrow', w < 48);
      el.classList.toggle('tiny', w < 18);
      el.querySelector('.clip-fade.in').style.width = `${c.fadeIn * this.pps}px`;
      el.querySelector('.clip-fade.out').style.width = `${c.fadeOut * this.pps}px`;
      // 影片下方的波形區：聲音的淡入淡出（可能跟畫面不同）
      const av = c.type === 'video' && this.runtime.get(c.mediaId)?.hasAudio !== false;
      el.classList.toggle('av', av);
      const af = audioFadesOf(c);
      el.querySelector('.clip-afade.in').style.width = `${af.in * this.pps}px`;
      el.querySelector('.clip-afade.out').style.width = `${af.out * this.pps}px`;
      // 淡入淡出的小圓點：離邊緣至少 12px，才不會跟修剪把手搶
      const dotX = (sec) => Math.max(12, sec * this.pps);
      const [pin, pout, ain, aout] = el.querySelectorAll('.fade-dot');
      const linked = c.type === 'video' && c.audioFades == null;
      pin.style.left = `${dotX(c.fadeIn)}px`;
      pout.style.left = `${w - dotX(c.fadeOut)}px`;
      ain.style.left = `${dotX(af.in)}px`;
      aout.style.left = `${w - dotX(af.out)}px`;
      pin.title = c.type === 'video' && !linked ? _t('拖曳調整畫面淡入') : _t('拖曳調整淡入');
      pout.title = c.type === 'video' && !linked ? _t('拖曳調整畫面淡出') : _t('拖曳調整淡出');
      ain.title = _t('拖曳調整聲音淡入（只有聲音）');
      aout.title = _t('拖曳調整聲音淡出（只有聲音）');
      const label = c.type === 'text' ? (c.text.content.split('\n')[0] || _t('文字')) : (c.name || p.media[c.mediaId]?.name || c.type);
      const speed = c.speed !== 1 ? `<span class="speed">${c.speed}×</span>` : '';
      const muted = c.muted ? icon('volumeOff') : '';
      el.querySelector('.clip-label').innerHTML = `${icon(TYPE_ICON[c.type])}<span>${escapeHtml(label)}</span>${speed}${muted}`;
      el.title = label;
      const row = this.rows.get(c.trackId);
      if (row && el.parentNode !== row) row.appendChild(el);
      seenClips.add(c.id);
    }
    for (const [id, el] of this.clipEls) if (!seenClips.has(id)) { el.remove(); this.clipEls.delete(id); }

    // 空狀態提示
    this.els.tracks.querySelectorAll('.tl-empty').forEach(n => n.remove());
    if (!p.clips.length) {
      const first = this.rows.get([...p.tracks].reverse().find(t => t.kind === 'video')?.id);
      if (first) {
        const hint = document.createElement('div');
        hint.className = 'tl-empty';
        hint.innerHTML = `${icon('upload', 'icon-sm')}${_t('把素材拖到這裡，或在素材卡片上按 ＋')}`;
        first.appendChild(hint);
      }
    }
  }

  renderRuler() {
    const cv = this.els.ruler;
    const dpr = window.devicePixelRatio || 1;
    const w = this.els.scroll.clientWidth;
    const h = 28;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`;
    }
    cv.style.left = '0px';
    cv.style.transform = `translateX(${this.els.scroll.scrollLeft}px)`;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const sl = this.els.scroll.scrollLeft;
    const step = rulerStep(this.pps);
    const minor = step / (step >= 1 ? 5 : 2);
    const t0 = Math.max(0, Math.floor(this.xToTime(sl) / minor) * minor);
    const t1 = this.xToTime(sl + w);
    ctx.font = '10.5px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'top';
    for (let t = t0; t <= t1 + minor; t += minor) {
      const x = Math.round(this.timeToX(t) - sl) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.strokeStyle = major ? 'rgba(255,255,255,.32)' : 'rgba(255,255,255,.12)';
      ctx.beginPath();
      ctx.moveTo(x, major ? h - 12 : h - 6);
      ctx.lineTo(x, h);
      ctx.stroke();
      if (major) {
        ctx.fillStyle = 'rgba(233,235,238,.62)';
        ctx.fillText(formatRulerLabel(Math.round(t * 1000) / 1000, step), x + 4, 5);
      }
    }
  }

  updatePlayhead(t) {
    this.els.playhead.style.transform = `translateX(${this.timeToX(t)}px)`;
  }

  /** 播放時讓播放頭保持在可見範圍 */
  follow(t) {
    const x = this.timeToX(t);
    const s = this.els.scroll;
    if (x > s.scrollLeft + s.clientWidth - 40 || x < s.scrollLeft) s.scrollLeft = Math.max(0, x - s.clientWidth * 0.2);
  }

  /** 用鍵盤或按鈕移動播放頭時，播放頭跑出畫面就捲過去（往右翻到左邊、往左翻到右邊） */
  reveal(t) {
    const x = this.timeToX(t);
    const s = this.els.scroll;
    if (x > s.scrollLeft + s.clientWidth - 40) s.scrollLeft = x - s.clientWidth * 0.2;
    else if (x < s.scrollLeft + 40) s.scrollLeft = Math.max(0, x - s.clientWidth * 0.8);
  }

  // ---------- 片段背景（縮圖膠卷 / 波形），只畫看得到的範圍 ----------
  queueBackgrounds() {
    if (this.bgQueued) return;
    this.bgQueued = true;
    requestAnimationFrame(() => { this.bgQueued = false; this.drawBackgrounds(); });
  }

  drawBackgrounds() {
    const p = this.store.project;
    const s = this.els.scroll;
    const viewL = s.scrollLeft, viewR = viewL + s.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    for (const c of p.clips) {
      const el = this.clipEls.get(c.id);
      if (!el) continue;
      const cv = el.querySelector('canvas.clip-bg');
      const left = this.timeToX(c.start), width = c.duration * this.pps;
      const visL = Math.max(left, viewL), visR = Math.min(left + width, viewR);
      if (visR <= visL || c.type === 'text') { cv.style.display = 'none'; continue; }
      const w = Math.ceil(visR - visL), h = el.clientHeight || this.trackH - 8;
      cv.style.display = '';
      cv.style.left = `${visL - left}px`;
      cv.style.width = `${w}px`;
      cv.style.right = 'auto';
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const item = this.runtime.get(c.mediaId);
      if (!item) continue;
      const tAt = (x) => this.xToTime(visL + x);
      if (c.type === 'video' || c.type === 'image') {
        const stripH = c.type === 'video' && item.peaks ? h * 0.72 : h;
        this.drawFilmstrip(ctx, c, item, w, stripH, tAt);
        if (c.type === 'video' && item.peaks) this.drawWave(ctx, c, item, w, stripH, h - stripH, tAt, 'rgba(255,255,255,.55)', true);
      } else if (c.type === 'audio' && item.peaks) {
        this.drawWave(ctx, c, item, w, 16, h - 18, tAt, 'rgba(255,255,255,.7)', false);
      }
    }
  }

  drawFilmstrip(ctx, clip, item, w, h, tAt) {
    const thumbs = item.thumbs;
    if (!thumbs?.length) return;
    const tw = Math.max(16, h * (thumbs[0].canvas.width / thumbs[0].canvas.height));
    ctx.save();
    ctx.globalAlpha = 0.9;
    // 讓縮圖格子對齊片段開頭，捲動時不會跳動
    const clipLeftX = this.timeToX(clip.start) - this.timeToX(tAt(0));
    const startIdx = Math.floor(-clipLeftX / tw);
    for (let i = startIdx; clipLeftX + i * tw < w; i++) {
      const x = clipLeftX + i * tw;
      let thumb = thumbs[0];
      if (clip.type === 'video' && thumbs.length > 1) {
        const st = sourceTime(clip, tAt(x + tw / 2));
        thumb = thumbs.reduce((best, th) => (Math.abs(th.t - st) < Math.abs(best.t - st) ? th : best), thumbs[0]);
      }
      ctx.drawImage(thumb.canvas, x, 0, tw, h);
    }
    ctx.restore();
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    ctx.fillRect(0, 0, w, 18);
  }

  drawWave(ctx, clip, item, w, top, h, tAt, color, mirrorBottom) {
    const { peaks, peaksPerSec } = item;
    if (h < 4) return;
    ctx.fillStyle = mirrorBottom ? 'rgba(0,0,0,.35)' : 'transparent';
    if (mirrorBottom) ctx.fillRect(0, top, w, h);
    ctx.fillStyle = color;
    const gain = Math.min(2, clip.muted ? 0 : clip.volume) || 0.05;
    const mid = mirrorBottom ? top + h : top + h / 2;
    for (let x = 0; x < w; x += 2) {
      const s0 = sourceTime(clip, tAt(x)), s1 = sourceTime(clip, tAt(x + 2));
      const i0 = Math.max(0, Math.floor(s0 * peaksPerSec)), i1 = Math.min(peaks.length, Math.max(i0 + 1, Math.ceil(s1 * peaksPerSec)));
      let v = 0;
      for (let i = i0; i < i1; i++) if (peaks[i] > v) v = peaks[i];
      const bh = Math.max(1, Math.min(1, v * gain) * (mirrorBottom ? h - 2 : h / 2));
      if (mirrorBottom) ctx.fillRect(x, mid - bh, 1.4, bh);
      else ctx.fillRect(x, mid - bh, 1.4, bh * 2);
    }
  }

  // ============================================================
  // 縮放
  // ============================================================
  setZoom(pps, anchorTime = null) {
    pps = clamp(pps, MIN_PPS, MAX_PPS);
    const s = this.els.scroll;
    const anchor = anchorTime ?? this.getTime();
    const anchorScreen = this.timeToX(anchor) - s.scrollLeft;
    this.store.setView({ pxPerSec: pps });
    this.render();
    s.scrollLeft = Math.max(0, this.timeToX(anchor) - anchorScreen);
    this.renderRuler();
    this.queueBackgrounds();
  }

  zoomBy(f, anchorTime) { this.setZoom(this.pps * f, anchorTime); }

  fit() {
    const d = getDuration(this.store.project) || 30;
    const w = this.els.scroll.clientWidth - PAD - 40;
    this.setZoom(w / d, 0);
    this.els.scroll.scrollLeft = 0;
  }

  // ============================================================
  // 互動
  // ============================================================
  bindScroll() {
    const s = this.els.scroll;
    s.addEventListener('scroll', () => {
      this.els.headList.scrollTop = s.scrollTop;
      this.renderRuler();
      this.queueBackgrounds();
    }, { passive: true });
    s.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.zoomBy(Math.exp(-e.deltaY * 0.01), this.clientXToTime(e.clientX));
        return;
      }
      // 一般滑鼠滾輪：左右捲動時間軸。觸控板橫向滑動交給瀏覽器；
      // 軌道多到需要上下捲時，在尺規上滾或按住 Shift 才左右捲
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      const canScrollDown = s.scrollHeight > s.clientHeight + 1;
      if (canScrollDown && !e.shiftKey && e.target !== this.els.ruler) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? s.clientWidth : 1;
      s.scrollLeft += e.deltaY * unit;
    }, { passive: false });
    this.els.headList.addEventListener('wheel', (e) => { s.scrollTop += e.deltaY; }, { passive: true });
  }

  /** 拖曳播放頭（尺規、播放頭把手、軌道空白處）。拖到左右邊緣會自動捲動 */
  startScrub(e) {
    e.preventDefault();
    this.onScrubStart();
    let last = e;
    const apply = (ev) => this.onSeek(Math.max(0, this.clientXToTime(ev.clientX)));
    const scroller = this.autoScroll(() => apply(last));
    const move = (ev) => { last = ev; scroller.track(ev); apply(ev); };
    apply(e);
    this.drag = { type: 'scrub' };
    window.addEventListener('pointermove', move);
    this.onDragEnd(() => {
      window.removeEventListener('pointermove', move);
      scroller.stop();
      this.drag = null;
    });
  }

  bindRuler() {
    const start = (e) => { if (e.button === 0) this.startScrub(e); };
    this.els.ruler.addEventListener('pointerdown', start);
    this.els.playhead.querySelector('.tl-playhead-cap').addEventListener('pointerdown', start);
  }

  trackAtClientY(clientY) {
    for (const [id, row] of this.rows) {
      const r = row.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return getTrack(this.store.project, id);
    }
    return null;
  }

  bindTracks() {
    // 雙擊文字片段：在預覽上直接編輯
    this.els.tracks.addEventListener('dblclick', (e) => {
      const id = e.target.closest('.clip')?.dataset.clipId;
      if (id && getClip(this.store.project, id)?.type === 'text') this.onEditText?.(id);
    });
    this.els.tracks.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const clipEl = e.target.closest('.clip');
      if (!clipEl) {
        // 點空白處：取消選取並移動播放頭（按住可以拖曳）
        this.store.select([]);
        this.startScrub(e);
        return;
      }
      e.preventDefault();
      const id = clipEl.dataset.clipId;
      const clip = getClip(this.store.project, id);
      if (!clip) return;
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      if (additive) { this.store.select(id, { add: true }); return; }
      if (!this.store.selection.includes(id)) this.store.select(id);
      const track = getTrack(this.store.project, clip.trackId);
      if (track?.locked) return;
      const dot = e.target.closest('.fade-dot');
      if (dot) { this.beginFade(e, clip, dot.dataset.fade, 'audio' in dot.dataset); return; }
      const edge = e.target.closest('.clip-handle')?.dataset.edge;
      if (edge) this.beginTrim(e, clip, edge);
      else this.beginMove(e, clip);
    });
  }

  snapPointsFor(excludeIds) {
    return snapPoints(this.store.project, { excludeIds, playhead: this.getTime() });
  }

  showSnap(t) {
    const line = this.els.snapline;
    if (t == null) { line.hidden = true; return; }
    line.hidden = false;
    line.style.left = `${this.timeToX(t)}px`;
  }

  /**
   * 拖曳時游標靠近時間軸左右邊緣就自動捲動，才能拖到畫面外更早或更晚的地方。
   * offset() 是開始拖曳後捲動了多少 px；捲動時呼叫 onScroll 重新計算位置。
   */
  autoScroll(onScroll) {
    const sc = this.els.scroll;
    const sl0 = sc.scrollLeft;
    const EDGE = 48, SPEED = 18;
    let x = null;
    let raf = requestAnimationFrame(function tick() {
      raf = requestAnimationFrame(tick);
      if (x == null) return;
      const r = sc.getBoundingClientRect();
      const v = x > r.right - EDGE ? Math.min(1, (x - r.right + EDGE) / EDGE)
        : x < r.left + EDGE ? -Math.min(1, (r.left + EDGE - x) / EDGE) : 0;
      if (!v) return;
      const before = sc.scrollLeft;
      sc.scrollLeft += v * SPEED;
      if (sc.scrollLeft !== before) onScroll();
    });
    return {
      track: (ev) => { x = ev.clientX; },
      offset: () => sc.scrollLeft - sl0,
      stop: () => cancelAnimationFrame(raf),
    };
  }

  /** 拖曳結束（放開、或指標被系統取消） */
  onDragEnd(fn) {
    const end = () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      fn();
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  beginTrim(e, clip, edge) {
    const session = Math.random().toString(36).slice(2);
    // 每次都從開始拖曳時的狀態計算，避免累積誤差
    const base = this.store.project;
    const origT = edge === 'start' ? clip.start : clipEnd(clip);
    const x0 = e.clientX;
    const points = this.snapPointsFor([clip.id]);
    let last = e, hinted = false;
    const apply = (ev) => {
      let t = origT + (ev.clientX - x0 + scroller.offset()) / this.pps;
      let snapped = null;
      if (this.store.snap && !ev.altKey) {
        const r = snapTime(t, points, SNAP_PX / this.pps);
        if (r.snapped) { t = r.time; snapped = r.point; }
      }
      this.showSnap(snapped);
      const next = trimClip(base, clip.id, edge, t);
      if (!hinted) hinted = this.explainTrimLimit(next, clip, edge, t);
      this.store.commit(next, { key: `trim-${session}` });
    };
    const scroller = this.autoScroll(() => apply(last));
    const move = (ev) => { last = ev; scroller.track(ev); apply(ev); };
    this.drag = { type: 'trim' };
    window.addEventListener('pointermove', move);
    this.onDragEnd(() => {
      window.removeEventListener('pointermove', move);
      scroller.stop();
      this.showSnap(null);
      this.drag = null;
    });
  }

  /** 修剪拉不動的時候說明原因（一次拖曳只說一次）。回傳是否說明了 */
  explainTrimLimit(next, clip, edge, wanted) {
    const c = getClip(next, clip.id);
    const got = edge === 'start' ? c.start : clipEnd(c);
    const outward = edge === 'start' ? wanted < got : wanted > got;
    if (!outward || Math.abs(wanted - got) * this.pps < 30) return false;
    const fromMedia = c.type === 'video' || c.type === 'audio';
    let msg;
    if (edge === 'start') msg = fromMedia && c.srcIn < 1e-6 ? _t('已經是素材的開頭，不能再往左拉長') : got <= 1e-6 ? _t('已經在時間軸最前面') : _t('前面有其他片段擋住');
    else msg = fromMedia && Math.abs(c.srcIn + c.duration * c.speed - mediaLimit(next, c)) < 1e-3 ? _t('已經是素材的結尾，不能再往右拉長') : _t('後面有其他片段擋住');
    this.emitToast?.(_t('{reason}。要移動整段片段，請按住片段中間拖曳。', { reason: msg }));
    return true;
  }

  /** 拖曳片段上方（或影片波形上）的小圓點，調整淡入 / 淡出的長度 */
  beginFade(e, clip, side, audio) {
    const base = this.store.project;
    const session = Math.random().toString(36).slice(2);
    const from = audio ? audioFadesOf(clip)[side] : side === 'in' ? clip.fadeIn : clip.fadeOut;
    const x0 = e.clientX;
    const linked = clip.type !== 'video' || clip.audioFades == null;
    const label = audio
      ? (side === 'in' ? _t('聲音淡入') : _t('聲音淡出'))
      : clip.type === 'video' && !linked ? (side === 'in' ? _t('畫面淡入') : _t('畫面淡出')) : (side === 'in' ? _t('淡入') : _t('淡出'));
    const tip = document.createElement('div');
    tip.className = 'fade-tip';
    this.clipEls.get(clip.id)?.appendChild(tip);
    const move = (ev) => {
      let v = from + (side === 'in' ? 1 : -1) * (ev.clientX - x0) / this.pps;
      v = clamp(Math.round(v * 20) / 20, 0, clip.duration);
      const patch = audio ? { audioFades: { [side]: v } } : { [side === 'in' ? 'fadeIn' : 'fadeOut']: v };
      this.store.commit(updateClip(base, clip.id, patch), { key: `fade-${session}` });
      tip.textContent = `${label} ${v.toFixed(1)}s`;
      // 重新繪製時片段元素可能被換位置，提示跟著放回去
      const el = this.clipEls.get(clip.id);
      if (el && tip.parentNode !== el) el.appendChild(tip);
    };
    this.drag = { type: 'fade' };
    window.addEventListener('pointermove', move);
    this.onDragEnd(() => {
      window.removeEventListener('pointermove', move);
      tip.remove();
      this.drag = null;
    });
  }

  beginMove(e, clip) {
    const base = this.store.project;
    const ids = this.store.selection.filter(id => {
      const c = getClip(base, id);
      return c && !getTrack(base, c.trackId)?.locked;
    });
    const group = ids.map(id => getClip(base, id));
    const single = group.length === 1;
    const x0 = e.clientX;
    const minStart = Math.min(...group.map(c => c.start));
    const points = this.snapPointsFor(ids);
    const session = Math.random().toString(36).slice(2);
    let moved = false, last = e;

    // 邊拖邊套用（跟修剪一樣），放開前就看得到片段會落在哪裡、哪些片段會被往後推
    const apply = (ev) => {
      let delta = (ev.clientX - x0 + scroller.offset()) / this.pps;
      delta = Math.max(delta, -minStart);
      let snapped = null;
      if (this.store.snap && !ev.altKey) {
        // 用拖曳的那個片段來吸附
        const r = snapClipStart(clip.start + delta, clip.duration, points, SNAP_PX / this.pps);
        if (r.point != null) { delta = Math.max(r.start - clip.start, -minStart); snapped = r.point; }
      }
      this.showSnap(snapped);
      let next = base;
      if (single) {
        const tr = this.trackAtClientY(ev.clientY);
        const target = tr && canHost(tr, clip.type) && !tr.locked ? tr : getTrack(base, clip.trackId);
        // 放在別的片段上：插進去並把後面的往後推（波紋模式下原本的位置會補起來）
        next = placeClip(base, clip.id, { start: clip.start + delta, trackId: target.id, closeGap: this.store.ripple });
      } else {
        const ordered = [...group].sort((a, b) => (delta > 0 ? b.start - a.start : a.start - b.start));
        for (const c of ordered) next = moveClip(next, c.id, { start: c.start + delta });
      }
      this.store.commit(next, { key: `move-${session}` });
    };
    const scroller = this.autoScroll(() => { if (moved) apply(last); });
    const move = (ev) => {
      last = ev;
      scroller.track(ev);
      if (!moved && Math.abs(ev.clientX - x0) < 3 && Math.abs(ev.clientY - e.clientY) < 3) return;
      moved = true;
      apply(ev);
    };
    this.drag = { type: 'move' };
    window.addEventListener('pointermove', move);
    this.onDragEnd(() => {
      window.removeEventListener('pointermove', move);
      scroller.stop();
      this.showSnap(null);
      this.drag = null;
    });
  }

  bindDrop() {
    const tracks = this.els.tracks;
    const clear = () => this.rows.forEach(r => r.classList.remove('drop-ok'));
    const scroll = this.els.scroll;
    scroll.addEventListener('dragover', (e) => {
      if (!dragPayload.media) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      clear();
      const tr = this.trackAtClientY(e.clientY);
      if (tr && canHost(tr, dragPayload.media.type) && !tr.locked) this.rows.get(tr.id).classList.add('drop-ok');
      const points = this.snapPointsFor([]);
      const t = Math.max(0, this.clientXToTime(e.clientX));
      const r = this.store.snap ? snapTime(t, points, SNAP_PX / this.pps) : { snapped: false };
      this.showSnap(r.snapped ? r.point : null);
    });
    scroll.addEventListener('dragleave', (e) => {
      if (!scroll.contains(e.relatedTarget)) { clear(); this.showSnap(null); }
    });
    scroll.addEventListener('drop', (e) => {
      if (!dragPayload.media) return;
      e.preventDefault();
      e.stopPropagation();
      clear();
      this.showSnap(null);
      const tr = this.trackAtClientY(e.clientY);
      let t = Math.max(0, this.clientXToTime(e.clientX));
      if (this.store.snap) {
        const r = snapTime(t, this.snapPointsFor([]), SNAP_PX / this.pps);
        if (r.snapped) t = r.time;
      }
      const media = dragPayload.media;
      dragPayload.media = null;
      const kind = TRACK_KIND_FOR_TYPE[media.type];
      this.onDropMedia(media.id, tr && tr.kind === kind ? tr.id : null, t);
    });
    tracks.addEventListener('dragend', () => { clear(); this.showSnap(null); });
  }
}
