// 左側面板的「轉場」分頁：點一下把轉場加到接點上

import { TRANSITION_TYPES, DEFAULT_TRANSITION, effectiveTransition } from '../core/transitions.js';
import { icon } from './icons.js';
import { _t } from '../i18n.js';

export const TRANSITION_LABELS = {
  fade: _t('溶解'), black: _t('黑場過渡'), white: _t('白場閃光'), blur: _t('模糊溶接'), wipe: _t('擦除'),
  softwipe: _t('柔和漸層擦除'), push: _t('推移'), pushup: _t('往上推移'), iris: _t('圓形展開'), zoom: _t('放大溶接'),
};

const DURATIONS = [0.5, 0.8, 1.2, 2];

export class TransitionsPanel {
  /** getTarget() 回傳要套用的片段（接點後面那段）或 null */
  constructor({ store, el, getTarget, onApply, onApplyAll, onRemove }) {
    this.store = store;
    this.el = el;
    this.getTarget = getTarget;
    this.duration = DEFAULT_TRANSITION;
    this.built = false;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.transition) { this.picked = b.dataset.transition; onApply(this.picked, this.duration); }
      else if (b.dataset.dur) { this.duration = +b.dataset.dur; this.render(); }
      else if (b.dataset.act === 'all') onApplyAll(this.lastType(), this.duration);
      else if (b.dataset.act === 'remove') onRemove();
    });
  }

  /** 「套用到全部接點」用的類型：目前接點的類型，沒有就用溶解 */
  lastType() {
    const target = this.getTarget();
    return target?.transitionIn?.type || this.picked || 'fade';
  }

  render() {
    if (!this.built) {
      this.built = true;
      this.el.innerHTML = `
        <p class="panel-note">${_t('轉場會加在同一條軌上<b>緊接著的兩段</b>影片或圖片之間。選取後面那段（或把播放頭移到接點附近）再點一下。')}</p>
        <div class="tr-durs" role="group" aria-label="${_t('轉場長度')}"><span>${_t('長度')}</span>${DURATIONS.map(d => `<button class="chip" data-dur="${d}">${_t('{s} 秒', { s: d })}</button>`).join('')}</div>
        <div class="tr-grid">${TRANSITION_TYPES.map(id => `
          <button class="tr-opt" data-transition="${id}" title="${TRANSITION_LABELS[id]}">
            <span class="tr-thumb tr-${id}" aria-hidden="true"><i class="tr-a">A</i><i class="tr-b">B</i><i class="tr-c"></i></span>
            <small>${TRANSITION_LABELS[id]}</small>
          </button>`).join('')}</div>
        <div class="tr-actions">
          <button class="ghost-btn" data-act="all">${icon('copy', 'icon-sm')}${_t('套用到全部接點')}</button>
          <button class="ghost-btn" data-act="remove">${icon('close', 'icon-sm')}${_t('移除轉場')}</button>
        </div>
        <p class="panel-note" style="margin-top:14px">${_t('兩段會在接點前後重疊播放；素材不夠長時會停在第一格或最後一格。選取片段後可以在右側調整轉場長度。')}</p>`;
    }
    const target = this.getTarget();
    const tr = target && effectiveTransition(this.store.project, target);
    this.el.querySelectorAll('.tr-opt').forEach(b => b.classList.toggle('on', b.dataset.transition === tr?.type));
    this.el.querySelectorAll('[data-dur]').forEach(b => b.classList.toggle('on', Math.abs(+b.dataset.dur - this.duration) < 1e-6));
  }
}
