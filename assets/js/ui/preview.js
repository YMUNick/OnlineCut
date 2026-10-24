// 預覽區：依畫面比例調整大小、在畫面上直接選取 / 移動 / 縮放 / 旋轉圖層

import { getClip, updateClip, getTrack } from '../core/project.js';
import { hitTest } from '../engine/renderer.js';
import { clamp } from '../core/time.js';

const CENTER_SNAP_PX = 8;

export class Preview {
  constructor({ store, player, els }) {
    this.store = store;
    this.player = player;
    this.els = els;
    this.scale = 1; // 螢幕像素 / 專案像素
    this.layouts = new Map();
    this.guides = { v: false, h: false };
    new ResizeObserver(() => this.layout()).observe(els.viewport);
    els.overlay.addEventListener('pointerdown', (e) => this.onPointerDown(e));
  }

  /** 讓畫面在可用空間內保持比例、置中 */
  layout() {
    const p = this.store.project;
    const vp = this.els.viewport;
    const cs = getComputedStyle(vp);
    const availW = vp.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = vp.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (availW <= 0 || availH <= 0) return;
    const s = Math.min(availW / p.width, availH / p.height);
    const w = Math.floor(p.width * s), h = Math.floor(p.height * s);
    this.els.frame.style.width = `${w}px`;
    this.els.frame.style.height = `${h}px`;
    this.scale = w / p.width;
    // canvas 解析度：螢幕實際像素，但不超過專案解析度
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.max(2, Math.min(p.width, Math.round(w * dpr)));
    const ch = Math.max(2, Math.round(cw * p.height / p.width));
    const cv = this.els.canvas;
    if (cv.width !== cw || cv.height !== ch) {
      cv.width = cw;
      cv.height = ch;
      this.player.render();
    }
    this.drawOverlay();
  }

  setLayouts(layouts) {
    this.layouts = layouts;
    this.drawOverlay();
  }

  toProject(e) {
    const r = this.els.overlay.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.scale, y: (e.clientY - r.top) / this.scale };
  }

  drawOverlay() {
    const ov = this.els.overlay;
    ov.innerHTML = '';
    const s = this.scale;
    if (this.guides.v) ov.insertAdjacentHTML('beforeend', `<div class="guide v" style="left:${this.store.project.width / 2 * s}px"></div>`);
    if (this.guides.h) ov.insertAdjacentHTML('beforeend', `<div class="guide h" style="top:${this.store.project.height / 2 * s}px"></div>`);
    const clip = this.store.selectedClip;
    if (!clip || clip.type === 'audio') return;
    const L = this.layouts.get(clip.id);
    if (!L) return;
    const box = document.createElement('div');
    box.className = 'sel-box';
    box.style.cssText = `left:${(L.cx - L.w / 2) * s}px;top:${(L.cy - L.h / 2) * s}px;width:${L.w * s}px;height:${L.h * s}px;transform:rotate(${L.rotation}deg)`;
    const locked = getTrack(this.store.project, clip.trackId)?.locked;
    if (!locked) box.innerHTML = ['nw', 'ne', 'sw', 'se'].map(h => `<span class="sel-handle ${h}" data-h="${h}"></span>`).join('') + '<span class="sel-rotate" data-h="rot" title="旋轉（按住 Shift 以 15° 為單位）"></span>';
    ov.appendChild(box);
  }

  /** 從最上層往下找被點到的圖層 */
  pick(pt) {
    const entries = [...this.layouts.entries()].reverse();
    for (const [id, L] of entries) {
      const c = getClip(this.store.project, id);
      if (!c || c.opacity <= 0.02) continue;
      if (hitTest(L, pt.x, pt.y)) return id;
    }
    return null;
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    const pt = this.toProject(e);
    const handle = e.target.closest('[data-h]')?.dataset.h;
    let clip = this.store.selectedClip;
    const insideSelected = clip && this.layouts.get(clip.id) && hitTest(this.layouts.get(clip.id), pt.x, pt.y);
    if (!handle && !insideSelected) {
      const id = this.pick(pt);
      this.store.select(id ? [id] : []);
      clip = id ? getClip(this.store.project, id) : null;
      if (!clip) return;
    }
    if (getTrack(this.store.project, clip.trackId)?.locked) return;
    e.preventDefault();
    this.player.pause();
    const L = this.layouts.get(clip.id);
    if (!L) return;
    const base = this.store.project;
    const orig = { ...clip.transform };
    const session = Math.random().toString(36).slice(2);
    const mode = handle === 'rot' ? 'rotate' : handle ? 'scale' : 'move';
    const startDist = Math.hypot(pt.x - L.cx, pt.y - L.cy) || 1;
    const startAngle = Math.atan2(pt.y - L.cy, pt.x - L.cx);

    const move = (ev) => {
      const q = this.toProject(ev);
      let patch;
      this.guides = { v: false, h: false };
      if (mode === 'move') {
        let x = orig.x + (q.x - pt.x), y = orig.y + (q.y - pt.y);
        const th = CENTER_SNAP_PX / this.scale;
        if (!ev.altKey) {
          if (Math.abs(x) < th) { x = 0; this.guides.v = true; }
          if (Math.abs(y) < th) { y = 0; this.guides.h = true; }
        }
        patch = { transform: { x: Math.round(x), y: Math.round(y) } };
      } else if (mode === 'scale') {
        const d = Math.hypot(q.x - L.cx, q.y - L.cy);
        patch = { transform: { scale: clamp(orig.scale * d / startDist, 0.02, 10) } };
      } else {
        let a = orig.rotation + ((Math.atan2(q.y - L.cy, q.x - L.cx) - startAngle) * 180) / Math.PI;
        if (ev.shiftKey) a = Math.round(a / 15) * 15;
        else if (Math.abs(((a % 90) + 90) % 90) < 3 || Math.abs(((a % 90) + 90) % 90) > 87) a = Math.round(a / 90) * 90;
        patch = { transform: { rotation: a } };
      }
      this.store.commit(updateClip(base, clip.id, patch), { key: `xf-${session}` });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.guides = { v: false, h: false };
      this.drawOverlay();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
}
