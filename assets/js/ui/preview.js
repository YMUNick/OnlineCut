// 預覽區：依畫面比例調整大小、在畫面上直接選取 / 移動 / 縮放 / 旋轉圖層

import { getClip, updateClip, getTrack, MIN_FRAME } from '../core/project.js';
import { hitTest } from '../engine/renderer.js';
import { TextEditor } from './text-editor.js';
import { clamp } from '../core/time.js';
import { _t } from '../i18n.js';
import { updateTextSynced } from './text-sync.js';

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
    els.overlay.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.textEditor = new TextEditor({ store, player, frame: els.frame, getLayouts: () => this.layouts, getScale: () => this.scale });
  }

  /**
   * 雙擊文字：直接在畫面上修改內容與字型（上面有圖片蓋住時也找得到文字）。
   * pointerdown 為了拖曳呼叫了 preventDefault，瀏覽器就不會送 dblclick，所以自己判斷：
   * 0.4 秒內在差不多同一個位置按兩下。
   */
  isDoubleClick(e) {
    const now = performance.now(), last = this.lastDown;
    this.lastDown = { t: now, x: e.clientX, y: e.clientY };
    if (!last || now - last.t > 400 || Math.hypot(e.clientX - last.x, e.clientY - last.y) > 6) return false;
    this.lastDown = null;
    return true;
  }

  textAt(pt) {
    for (const [id, L] of [...this.layouts.entries()].reverse()) {
      if (getClip(this.store.project, id)?.type === 'text' && hitTest(L, pt.x, pt.y)) return id;
    }
    return null;
  }

  startTextEdit(id) { return this.textEditor.start(id); }

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

  get editingText() { return this.textEditor?.editingId ?? null; }

  toProject(e) {
    const r = this.els.overlay.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.scale, y: (e.clientY - r.top) / this.scale };
  }

  drawOverlay() {
    this.textEditor?.sync();
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
    if (L.framed) {
      box.classList.add('framed');
      if (clip.frame?.shape === 'circle') box.classList.add('circle');
      box.title = _t('拖曳移動畫面框，拉角落調整大小；按住 Alt 拖曳或用滾輪調整取景');
    }
    const locked = getTrack(this.store.project, clip.trackId)?.locked;
    if (!locked) {
      box.innerHTML = ['nw', 'ne', 'sw', 'se'].map(h => `<span class="sel-handle ${h}" data-h="${h}"></span>`).join('');
      if (!L.framed) box.insertAdjacentHTML('beforeend', `<span class="sel-rotate" data-h="rot" title="${_t('旋轉（按住 Shift 以 15° 為單位）')}"></span>`);
    }
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
    if (this.isDoubleClick(e)) {
      const id = this.textAt(pt);
      if (id) { e.preventDefault(); this.textEditor.start(id); return; }
    }
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
    if (L.framed && clip.frame) return this.dragFrame(e, clip, handle, pt);
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
      // 字幕軌整軌同步時，拖曳一段字幕的位置、大小，其他段也一起動
      this.store.commit(clip.type === 'text' ? updateTextSynced(base, clip.id, patch) : updateClip(base, clip.id, patch), { key: `xf-${session}` });
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

  /**
   * 畫面框：拖曳移動（靠近畫面邊緣與中線會吸附）、拉角落改大小（Shift 或圓形保持比例），
   * 按住 Alt 拖曳是平移框裡的取景。
   */
  dragFrame(e, clip, handle, pt) {
    const base = this.store.project;
    const W = base.width, H = base.height;
    const f0 = { ...clip.frame };
    const t0 = { ...clip.transform };
    const session = Math.random().toString(36).slice(2);
    const mode = handle ? 'resize' : e.altKey ? 'pan' : 'move';
    const th = CENTER_SNAP_PX / this.scale;
    // 吸附：位置（像素）靠近目標時對齊
    const snap = (start, size, total, guide) => {
      for (const [edge, offset] of [[0, 0], [total, size], [total / 2, size / 2]]) {
        if (Math.abs(start + offset - edge) < th) {
          if (edge === total / 2) this.guides[guide] = true;
          return edge - offset;
        }
      }
      return start;
    };
    const move = (ev) => {
      const q = this.toProject(ev);
      const dx = q.x - pt.x, dy = q.y - pt.y;
      this.guides = { v: false, h: false };
      let patch;
      if (mode === 'pan') {
        patch = { transform: { x: Math.round(t0.x + dx), y: Math.round(t0.y + dy) } };
      } else if (mode === 'move') {
        let x = f0.x * W + dx, y = f0.y * H + dy;
        if (!ev.shiftKey) { x = snap(x, f0.w * W, W, 'v'); y = snap(y, f0.h * H, H, 'h'); }
        patch = { frame: { x: x / W, y: y / H } };
      } else {
        // 對角固定，拖曳的角跟著滑鼠
        const left = f0.x * W, top = f0.y * H, right = left + f0.w * W, bottom = top + f0.h * H;
        const ax = handle.includes('w') ? right : left, ay = handle.includes('n') ? bottom : top;
        let w = Math.abs(q.x - ax), h = Math.abs(q.y - ay);
        if (ev.shiftKey || f0.shape === 'circle') {
          const k = Math.max(w / (f0.w * W), h / (f0.h * H));
          w = f0.w * W * k; h = f0.h * H * k;
        }
        w = Math.max(w, MIN_FRAME * W); h = Math.max(h, MIN_FRAME * H);
        const x = handle.includes('w') ? ax - w : ax, y = handle.includes('n') ? ay - h : ay;
        patch = { frame: { x: x / W, y: y / H, w: w / W, h: h / H } };
      }
      this.store.commit(updateClip(base, clip.id, patch), { key: `fr-${session}` });
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

  /** 滾輪：調整畫面框裡的取景縮放 */
  onWheel(e) {
    const clip = this.store.selectedClip;
    const L = clip && this.layouts.get(clip.id);
    const q = this.toProject(e);
    if (!clip?.frame || !L || !hitTest(L, q.x, q.y)) return;
    if (getTrack(this.store.project, clip.trackId)?.locked) return;
    e.preventDefault();
    const scale = clamp(clip.transform.scale * Math.exp(-e.deltaY * 0.0015), 0.2, 10);
    // 停下來一陣子再滾就算新的一步（可以分開復原）
    clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => { this.wheelSession = null; }, 600);
    this.wheelSession ??= Math.random().toString(36).slice(2);
    const patch = { transform: { scale } };
    this.store.commit(clip.type === 'text' ? updateTextSynced(this.store.project, clip.id, patch) : updateClip(this.store.project, clip.id, patch), { key: `wheel-${this.wheelSession}` });
  }
}
