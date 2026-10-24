// 左側面板：素材卡片、匯入、拖到時間軸；文字樣板

import { formatDuration } from '../core/time.js';
import { icon } from './icons.js';
import { escapeHtml } from './dialogs.js';
import { dragPayload } from './timeline.js';

const TYPE_ICON = { video: 'film', image: 'image', audio: 'music' };
const TYPE_LABEL = { video: '影片', image: '圖片', audio: '音訊' };

export const TEXT_PRESETS = [
  { id: 'title', label: '大標題', sample: '大標題', text: { fontSize: 140, fontWeight: 900, color: '#ffffff', shadow: true } },
  { id: 'subtitle', label: '副標題', sample: '副標題文字', text: { fontSize: 72, fontWeight: 400, color: '#ffffff', shadow: true } },
  { id: 'caption', label: '字幕', sample: '這是一行字幕', text: { fontSize: 56, fontWeight: 700, color: '#ffffff', background: 'rgba(0,0,0,0.6)', shadow: false }, transform: { y: 400 } },
  { id: 'tag', label: '重點標籤', sample: 'NEW', text: { fontSize: 64, fontWeight: 900, color: '#ffffff', background: '#ff5c39', shadow: false } },
  { id: 'outline', label: '描邊大字', sample: '描邊大字', text: { fontSize: 120, fontWeight: 900, color: '#ffd23f', strokeColor: '#000000', strokeWidth: 8, shadow: false } },
  { id: 'serif', label: '襯線引言', sample: '「慢慢來，比較快」', text: { fontSize: 84, fontWeight: 700, fontFamily: 'Noto Serif TC', color: '#f7efe2', shadow: true } },
];

export function formatBytes(n) {
  if (!isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
}

export class MediaPanel {
  constructor({ store, runtime, els, onImport, onAdd, onRemove, onAddText }) {
    this.store = store;
    this.runtime = runtime;
    this.els = els;
    this.onAdd = onAdd;
    this.onRemove = onRemove;
    this.loading = new Map(); // 匯入中的暫存卡片
    this.cards = new Map();

    els.dropzone.addEventListener('click', () => els.fileInput.click());
    els.dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); } });
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
      const style = [
        `font-size:${Math.round(Math.min(30, t.fontSize / 3.6))}px`,
        `font-weight:${t.fontWeight}`,
        `color:${t.color}`,
        t.fontFamily ? `font-family:'${t.fontFamily}',serif` : 'font-family:var(--font-display)',
        t.background ? `background:${t.background};padding:3px 10px;border-radius:4px` : '',
        t.strokeWidth ? `-webkit-text-stroke:${Math.max(1, t.strokeWidth / 4)}px ${t.strokeColor};paint-order:stroke fill` : '',
        t.shadow ? 'text-shadow:0 2px 6px rgba(0,0,0,.6)' : '',
      ].filter(Boolean).join(';');
      return `<button class="text-preset" data-preset="${p.id}" title="加入「${p.label}」"><span><span style="${style}">${escapeHtml(p.sample)}</span><small>${p.label}</small></span></button>`;
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
    card.innerHTML = `<div class="media-thumb">${icon('upload')}</div><div class="media-meta"><div class="media-name"></div><div class="media-sub">讀取中…</div></div>`;
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
            <span class="media-missing">${icon('alert', 'icon-sm')}需要重新匯入</span>
          </div>
          <div class="media-actions">
            <button data-act="add" title="加到播放頭位置" aria-label="加到時間軸">${icon('plus')}</button>
            <button data-act="remove" title="從專案移除" aria-label="移除素材">${icon('trash')}</button>
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
      if (missing) card.title = `${m.name}\n檔案遺失：重新匯入同一個檔案（同名、同大小）就會自動接回`;
      card.querySelector('.media-sub').textContent = missing ? '檔案遺失' : [TYPE_LABEL[m.type], dims, formatBytes(m.size)].filter(Boolean).join(' · ');
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
