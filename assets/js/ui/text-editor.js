// 在預覽畫面上直接編輯文字：雙擊文字後出現輸入框（疊在文字的位置上）和一列小工具列
// （字型、字級、粗體、斜體、顏色）。打字時即時更新，Esc、Ctrl + Enter 或點外面結束。

import { getClip, getTrack } from '../core/project.js';
import { fontString, TEXT_LINE_HEIGHT } from '../engine/renderer.js';
import { FONTS, ensureFont } from './fonts.js';
import { parseColor } from './inspector.js';
import { escapeHtml } from './dialogs.js';
import { _t } from '../i18n.js';
import { updateTextSynced } from './text-sync.js';

export class TextEditor {
  constructor({ store, player, frame, getLayouts, getScale }) {
    this.store = store;
    this.player = player;
    this.frame = frame;
    this.getLayouts = getLayouts;
    this.getScale = getScale;
    this.state = null; // { id, wrap, area, bar, session }
  }

  get editingId() { return this.state?.id ?? null; }

  start(id) {
    const clip = getClip(this.store.project, id);
    if (!clip || clip.type !== 'text' || getTrack(this.store.project, clip.trackId)?.locked) return false;
    this.stop();
    this.player.pause();
    if (this.store.selection.length !== 1 || this.store.selection[0] !== id) this.store.select([id]);

    const wrap = document.createElement('div');
    wrap.className = 'text-edit';
    wrap.innerHTML = `
      <div class="text-edit-bar" role="toolbar" aria-label="${_t('文字樣式')}">
        <select class="te-font" aria-label="${_t('字型')}">${FONTS.map(f => `<option value="${escapeHtml(f.family)}">${escapeHtml(f.label)}</option>`).join('')}</select>
        <span class="te-sep"></span>
        <button type="button" data-act="smaller" title="${_t('字小一點')}" aria-label="${_t('字小一點')}">A<sup>−</sup></button>
        <input class="te-size" inputmode="numeric" aria-label="${_t('字級')}">
        <button type="button" data-act="bigger" title="${_t('字大一點')}" aria-label="${_t('字大一點')}">A<sup>+</sup></button>
        <span class="te-sep"></span>
        <button type="button" data-act="bold" title="${_t('粗體')}" aria-label="${_t('粗體')}"><b>B</b></button>
        <button type="button" data-act="italic" title="${_t('斜體')}" aria-label="${_t('斜體')}"><i>I</i></button>
        <label class="te-color" title="${_t('文字顏色')}"><input type="color" aria-label="${_t('文字顏色')}"></label>
        <span class="te-sep"></span>
        <button type="button" data-act="done" class="te-done">${_t('完成')}</button>
      </div>
      <textarea class="text-edit-area" spellcheck="false" aria-label="${_t('文字內容')}"></textarea>`;
    this.frame.appendChild(wrap);
    const area = wrap.querySelector('textarea');
    const bar = wrap.querySelector('.text-edit-bar');
    const session = Math.random().toString(36).slice(2);
    this.state = { id, wrap, area, bar, session };

    area.value = clip.text.content;
    area.addEventListener('input', () => this.commit({ content: area.value }, 'content'));
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); e.stopPropagation(); this.stop(); }
    });
    bar.querySelector('.te-font').addEventListener('change', (e) => {
      ensureFont(e.target.value, area.value);
      this.commit({ fontFamily: e.target.value }, 'font');
      area.focus();
    });
    const size = bar.querySelector('.te-size');
    size.addEventListener('change', () => { const v = parseFloat(size.value); if (isFinite(v)) this.commit({ fontSize: v }, 'size'); });
    size.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); size.blur(); area.focus(); } e.stopPropagation(); });
    bar.querySelector('.te-color input').addEventListener('input', (e) => this.commit({ color: e.target.value }, 'color'));
    bar.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      const t = this.clip()?.text;
      if (!t) return;
      if (act === 'done') { this.stop(); return; }
      if (act === 'smaller' || act === 'bigger') this.commit({ fontSize: Math.round(t.fontSize * (act === 'bigger' ? 1.15 : 1 / 1.15)) }, 'size');
      if (act === 'bold') this.commit({ fontWeight: t.fontWeight >= 700 ? 400 : 900 }, 'bold');
      if (act === 'italic') this.commit({ italic: !t.italic }, 'italic');
      area.focus();
    });
    // 按在工具列上不要讓輸入框失去焦點（除了下拉選單、數字欄、顏色）
    bar.addEventListener('pointerdown', (e) => { if (!e.target.closest('select, input, label')) e.preventDefault(); });

    // 點在編輯區以外就結束
    this.outside = (e) => { if (this.state && !wrap.contains(e.target)) this.stop(); };
    document.addEventListener('pointerdown', this.outside, true);

    this.player.hideTextFor = id;
    this.player.render();
    this.sync();
    area.focus();
    area.select();
    return true;
  }

  clip() { return this.state ? getClip(this.store.project, this.state.id) : null; }

  commit(patch, key) {
    const c = this.clip();
    if (!c) return;
    this.store.commit(updateTextSynced(this.store.project, c.id, { text: patch }), { key: `te-${this.state.session}-${key}` });
  }

  stop() {
    if (!this.state) return;
    const { wrap } = this.state;
    this.state = null;
    document.removeEventListener('pointerdown', this.outside, true);
    wrap.remove();
    this.player.hideTextFor = null;
    this.player.render();
  }

  /** 專案改變或重新繪製之後：更新工具列的數值，並把輸入框對齊文字 */
  sync() {
    if (!this.state) return;
    const c = this.clip();
    if (!c || c.type !== 'text') { this.stop(); return; }
    const { area, bar, wrap } = this.state;
    const t = c.text;
    if (document.activeElement !== area && area.value !== t.content) area.value = t.content;
    const font = bar.querySelector('.te-font');
    if (document.activeElement !== font) font.value = t.fontFamily;
    const size = bar.querySelector('.te-size');
    if (document.activeElement !== size) size.value = Math.round(t.fontSize);
    bar.querySelector('[data-act="bold"]').classList.toggle('on', t.fontWeight >= 700);
    bar.querySelector('[data-act="italic"]').classList.toggle('on', !!t.italic);
    bar.querySelector('.te-color input').value = parseColor(t.color).hex;

    const L = this.getLayouts().get(c.id);
    // 播放頭不在這段文字上（看不到）時先藏起來
    wrap.hidden = !L;
    if (!L) return;
    const s = this.getScale();
    const k = c.transform.scale * s;           // 專案像素 → 螢幕像素，再乘上文字的縮放
    const rad = (L.rotation * Math.PI) / 180;
    const { ox, oy, w, h } = L.text;
    const cx = (L.cx + ox * Math.cos(rad) - oy * Math.sin(rad)) * s;
    const cy = (L.cy + ox * Math.sin(rad) + oy * Math.cos(rad)) * s;
    // 多留一點寬度，打字時才不會先捲動再變寬
    const extra = t.fontSize * k * 0.8;
    const shift = t.align === 'left' ? extra / 2 : t.align === 'right' ? -extra / 2 : 0;
    const pad = t.background ? t.fontSize * 0.3 * k : 0;
    Object.assign(area.style, {
      left: `${cx + shift * Math.cos(rad)}px`,
      top: `${cy + shift * Math.sin(rad)}px`,
      width: `${w * s + extra}px`,
      height: `${h * s + 2}px`,
      transform: `translate(-50%, -50%) rotate(${L.rotation}deg)`,
      font: fontString(t, t.fontSize * k),
      lineHeight: String(TEXT_LINE_HEIGHT),
      padding: `${pad}px`,
      textAlign: t.align || 'center',
      color: t.color || '#fff',
      textShadow: t.glow ? `0 0 ${t.fontSize * 0.35 * k}px ${t.glow}, 0 0 ${t.fontSize * 0.35 * k}px ${t.glow}`
        : t.shadow ? `0 ${t.fontSize * 0.04 * k}px ${t.fontSize * 0.12 * k}px rgba(0,0,0,.55)` : 'none',
      webkitTextStroke: t.strokeWidth > 0 ? `${t.strokeWidth * 2 * k}px ${t.strokeColor}` : '0',
    });
    area.scrollLeft = 0;
    // 工具列放在文字上方；太靠近上緣就放到下方
    const fh = this.frame.clientHeight, fw = this.frame.clientWidth;
    const top = (L.cy - L.h / 2) * s - 48;
    const below = (L.cy + L.h / 2) * s + 10;
    bar.style.top = `${top >= 4 ? top : Math.min(below, fh - 44)}px`;
    const bw = bar.offsetWidth || 360;
    bar.style.left = `${Math.max(4, Math.min(fw - bw - 4, L.cx * s - bw / 2))}px`;
  }
}
