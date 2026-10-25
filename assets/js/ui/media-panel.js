// 左側面板：素材卡片、匯入、拖到時間軸；文字樣板

import { formatDuration } from '../core/time.js';
import { icon } from './icons.js';
import { escapeHtml } from './dialogs.js';
import { dragPayload } from './timeline.js';
import { _t } from '../i18n.js';
import { ensureFont } from './fonts.js';

const TYPE_ICON = { video: 'film', image: 'image', audio: 'music' };
const TYPE_LABEL = { video: _t('影片'), image: _t('圖片'), audio: _t('音訊') };

export const TEXT_PRESETS = [
  { id: 'title', label: _t('大標題'), sample: _t('大標題'), text: { fontSize: 140, fontWeight: 900, color: '#ffffff', shadow: true } },
  { id: 'subtitle', label: _t('副標題'), sample: _t('副標題文字'), text: { fontSize: 72, fontWeight: 400, color: '#ffffff', shadow: true } },
  { id: 'caption', label: _t('字幕'), sample: _t('這是一行字幕'), text: { fontSize: 56, fontWeight: 700, color: '#ffffff', background: 'rgba(0,0,0,0.6)', shadow: false }, transform: { y: 400 } },
  { id: 'tag', label: _t('重點標籤'), sample: 'NEW', text: { fontSize: 64, fontWeight: 900, color: '#ffffff', background: '#ff5c39', shadow: false } },
  { id: 'outline', label: _t('描邊大字'), sample: _t('描邊大字'), text: { fontSize: 120, fontWeight: 900, color: '#ffd23f', strokeColor: '#000000', strokeWidth: 8, shadow: false } },
  { id: 'serif', label: _t('襯線引言'), sample: _t('「慢慢來，比較快」'), text: { fontSize: 84, fontWeight: 700, fontFamily: 'Noto Serif TC', color: '#f7efe2', shadow: true } },
  { id: 'neon', label: _t('霓虹字'), sample: 'NEON NIGHT', text: { fontSize: 150, fontWeight: 400, fontFamily: 'Bebas Neue', color: '#fff0fb', glow: '#ff4fd8', shadow: false } },
  { id: 'variety', label: _t('綜藝大字'), sample: _t('笑死我了'), text: { fontSize: 130, fontWeight: 400, fontFamily: 'Huninn', color: '#ffe14d', strokeColor: '#1b1440', strokeWidth: 10, shadow: false } },
  { id: 'cute', label: _t('可愛圓體'), sample: _t('好吃到哭'), text: { fontSize: 100, fontWeight: 400, fontFamily: 'Huninn', color: '#ff7aa2', strokeColor: '#ffffff', strokeWidth: 7, shadow: false } },
  { id: 'hand', label: _t('手寫筆記'), sample: _t('今天也辛苦了'), text: { fontSize: 84, fontWeight: 400, fontFamily: 'LXGW WenKai TC', color: '#ffffff', shadow: true } },
  { id: 'cinema', label: _t('電影字幕'), sample: _t('很久很久以前……'), text: { fontSize: 54, fontWeight: 400, fontFamily: 'Noto Serif TC', color: '#f2f2f2', shadow: true }, transform: { y: 420 } },
  { id: 'bignews', label: _t('英文大標'), sample: 'BIG NEWS', text: { fontSize: 200, fontWeight: 400, fontFamily: 'Bebas Neue', color: '#ffffff', shadow: true } },
  { id: 'script', label: _t('草寫標題'), sample: 'Summer Vibes', text: { fontSize: 110, fontWeight: 400, fontFamily: 'Pacifico', color: '#ffffff', shadow: true } },
  { id: 'marker', label: _t('麥克筆字'), sample: 'Wait for it…', text: { fontSize: 96, fontWeight: 400, fontFamily: 'Permanent Marker', color: '#ffd23f', shadow: true } },
  { id: 'counter', label: _t('數字倒數'), sample: '2132', text: { fontSize: 220, fontWeight: 900, fontFamily: 'Bebas Neue', color: '#ffffff', shadow: true, counter: { from: 2152, duration: 3, ease: 'out' } } },
  { id: 'typewriter', label: _t('打字機'), sample: 'Hello, world.', text: { fontSize: 56, fontWeight: 400, fontFamily: 'ui-monospace', color: '#d9ffe0', background: 'rgba(0,0,0,0.75)', shadow: false } },
];

export function formatBytes(n) {
  if (!isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
}

export class MediaPanel {
  constructor({ store, runtime, els, onImport, onPick, onAdd, onRemove, onAddText }) {
    this.store = store;
    this.runtime = runtime;
    this.els = els;
    this.onAdd = onAdd;
    this.onRemove = onRemove;
    this.loading = new Map(); // 匯入中的暫存卡片
    this.cards = new Map();

    els.dropzone.addEventListener('click', () => onPick());
    els.dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } });
    els.fileInput.addEventListener('change', () => {
      if (els.fileInput.files.length) onImport([...els.fileInput.files]);
      els.fileInput.value = '';
    });
    for (const ev of ['dragenter', 'dragover']) els.dropzone.addEventListener(ev, () => els.dropzone.classList.add('drag'));
    for (const ev of ['dragleave', 'drop']) els.dropzone.addEventListener(ev, () => els.dropzone.classList.remove('drag'));

    // 分頁
    els.tabs.forEach(tab => tab.addEventListener('click', () => this.showTab(tab.dataset.tab)));

    // 文字樣板
    els.textPresets.innerHTML = TEXT_PRESETS.map(p => {
      const t = p.text;
      // 縮圖的字級：依實際大小縮小，但長的樣本要放得進格子（中文字算一個字寬，英文約 0.6）
      const ems = [...p.sample].reduce((n, ch) => n + (/[\u2e80-\uffff]/.test(ch) ? 1 : 0.6), 0);
      const style = [
        `font-size:${Math.round(Math.max(12, Math.min(24, t.fontSize / 4.6, 112 / ems)))}px`,
        `font-weight:${t.fontWeight}`,
        `color:${t.color}`,
        t.fontFamily ? `font-family:'${t.fontFamily}',serif` : 'font-family:var(--font-display)',
        t.background ? `background:${t.background};padding:3px 10px;border-radius:4px` : '',
        t.strokeWidth ? `-webkit-text-stroke:${Math.max(1, t.strokeWidth / 4)}px ${t.strokeColor};paint-order:stroke fill` : '',
        t.glow ? `text-shadow:0 0 6px ${t.glow},0 0 14px ${t.glow}` : t.shadow ? 'text-shadow:0 2px 6px rgba(0,0,0,.6)' : '',
      ].filter(Boolean).join(';');
      return `<button class="text-preset" data-preset="${p.id}" title="${_t('加入「{name}」', { name: p.label })}"><span><span style="${style}">${escapeHtml(p.sample)}</span><small>${p.label}</small></span></button>`;
    }).join('');
    els.textPresets.addEventListener('click', (e) => {
      const id = e.target.closest('[data-preset]')?.dataset.preset;
      const preset = TEXT_PRESETS.find(p => p.id === id);
      if (preset) onAddText(preset);
    });

    els.grid.addEventListener('click', (e) => {
      const card = e.target.closest('.media-card');
      if (!card) return;
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'add') onAdd(card.dataset.mediaId);
      if (act === 'remove') onRemove(card.dataset.mediaId);
    });
    els.grid.addEventListener('dblclick', (e) => {
      const card = e.target.closest('.media-card');
      if (card && !e.target.closest('[data-act]')) onAdd(card.dataset.mediaId);
    });
    els.grid.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.media-card');
      if (!card) return;
      const m = this.store.project.media[card.dataset.mediaId];
      if (!m) return;
      dragPayload.media = m;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', m.name);
      const thumb = card.querySelector('.media-thumb');
      if (thumb) e.dataTransfer.setDragImage(thumb, 30, 20);
    });
    els.grid.addEventListener('dragend', () => { dragPayload.media = null; });

    runtime.onChange((id) => this.refreshThumb(id));
  }

  showTab(name) {
    // 文字樣板用到的字型：第一次打開「文字」分頁才載入
    if (name === 'text' && !this.presetFontsLoaded) {
      this.presetFontsLoaded = true;
      for (const p of TEXT_PRESETS) if (p.text.fontFamily) ensureFont(p.text.fontFamily, p.sample);
    }
    this.els.tabs.forEach(t => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on);
    });
    this.els.panels.forEach(p => { p.hidden = p.dataset.panel !== name; });
  }

  /** 顯示匯入中的卡片 */
  addLoading(key, name) {
    const card = document.createElement('div');
    card.className = 'media-card loading';
    card.innerHTML = `<div class="media-thumb">${icon('upload')}</div><div class="media-meta"><div class="media-name"></div><div class="media-sub">${_t('讀取中…')}</div></div>`;
    card.querySelector('.media-name').textContent = name;
    this.els.grid.prepend(card);
    this.loading.set(key, card);
    this.els.empty.hidden = true;
  }

  removeLoading(key) {
    this.loading.get(key)?.remove();
    this.loading.delete(key);
    this.updateEmpty();
  }

  updateEmpty() {
    this.els.empty.hidden = Object.keys(this.store.project.media).length > 0 || this.loading.size > 0;
  }

  render() {
    const p = this.store.project;
    const used = new Set(p.clips.map(c => c.mediaId));
    const list = Object.values(p.media).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    const seen = new Set();
    let prev = null;
    for (const m of list) {
      let card = this.cards.get(m.id);
      if (!card) {
        card = document.createElement('div');
        card.className = 'media-card';
        card.draggable = true;
        card.dataset.mediaId = m.id;
        card.tabIndex = 0;
        card.innerHTML = `
          <div class="media-visual">
            <div class="media-thumb">${icon(TYPE_ICON[m.type], 'icon-lg')}</div>
            <span class="media-badge"></span>
            <span class="media-missing">${icon('alert', 'icon-sm')}${_t('需要重新匯入')}</span>
          </div>
          <div class="media-actions">
            <button data-act="add" title="${_t('加到播放頭位置')}" aria-label="${_t('加到時間軸')}">${icon('plus')}</button>
            <button data-act="remove" title="${_t('從專案移除')}" aria-label="${_t('移除素材')}">${icon('trash')}</button>
          </div>
          <div class="media-meta"><div class="media-name"></div><div class="media-sub"></div></div>`;
        card.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.onAdd(m.id); });
        this.cards.set(m.id, card);
        this.refreshThumb(m.id, card);
      }
      card.querySelector('.media-badge').innerHTML = `${icon(TYPE_ICON[m.type])}${m.duration ? formatDuration(m.duration) : TYPE_LABEL[m.type]}`;
      card.querySelector('.media-name').textContent = m.name;
      card.title = m.name;
      const dims = m.width ? `${m.width}×${m.height}` : '';
      const missing = !this.runtime.has(m.id);
      if (missing) card.title = `${m.name}\n${_t('檔案遺失：重新匯入同一個檔案（同名、同大小）就會自動接回')}`;
      card.querySelector('.media-sub').textContent = missing ? _t('檔案遺失') : [TYPE_LABEL[m.type], dims, formatBytes(m.size)].filter(Boolean).join(' · ');
      card.classList.toggle('used', used.has(m.id));
      card.classList.toggle('missing', missing);
      // 依新增時間排序（loading 卡片保留在最前面）
      if (prev) { if (prev.nextSibling !== card) prev.after(card); }
      else {
        const firstNonLoading = [...this.els.grid.children].find(c => !c.classList.contains('loading'));
        if (firstNonLoading !== card) (firstNonLoading ? firstNonLoading.before(card) : this.els.grid.appendChild(card));
      }
      prev = card;
      seen.add(m.id);
    }
    for (const [id, card] of this.cards) if (!seen.has(id)) { card.remove(); this.cards.delete(id); }
    this.updateEmpty();
  }

  refreshThumb(id, card = this.cards.get(id)) {
    if (!card) return;
    const item = this.runtime.get(id);
    const box = card.querySelector('.media-thumb');
    if (!item) return;
    if (item.thumbs?.length) {
      const src = item.thumbs[Math.floor(item.thumbs.length / 3)]?.canvas || item.thumbs[0].canvas;
      const c = document.createElement('canvas');
      c.width = src.width; c.height = src.height;
      c.getContext('2d').drawImage(src, 0, 0);
      box.replaceChildren(c);
    } else if (item.info.type === 'audio' && item.peaks) {
      const c = document.createElement('canvas');
      c.className = 'wave';
      c.width = 240; c.height = 80;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#5ad18a';
      const n = 60, step = item.peaks.length / n;
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) v = Math.max(v, item.peaks[j]);
        const h = Math.max(2, v * 76);
        ctx.fillRect(i * 4, 40 - h / 2, 2.4, h);
      }
      box.replaceChildren(c);
    }
  }
}
