// 左側面板的「版型」與「圖案」分頁

import { LAYOUTS, layoutFrames, matchLayout } from '../core/layouts.js';
import { GRAPHICS, GRAPHIC_CATEGORIES, renderGraphic } from '../graphics.js';
import { escapeHtml } from './dialogs.js';
import { icon } from './icons.js';

/** 版型的小示意圖 */
function layoutDiagram(id, W, H) {
  const vw = 64, vh = Math.round(64 * H / W);
  const box = vh > 44 ? { w: Math.round(44 * W / H), h: 44 } : { w: vw, h: vh };
  const shapes = layoutFrames(id, W, H).map((f, i) => {
    const x = f.x * box.w, y = f.y * box.h, w = f.w * box.w, h = f.h * box.h;
    const fill = i === 0 ? 'var(--lay-main)' : 'var(--lay-sub)';
    if (f.shape === 'circle') return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${fill}" stroke="var(--lay-line)" stroke-width="1"/>`;
    const rx = f.shape === 'round' ? Math.min(w, h) * 0.12 : 0;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"${i ? ' stroke="var(--lay-line)" stroke-width="1"' : ''}/>`;
  }).join('');
  return `<svg viewBox="0 0 ${box.w} ${box.h}" width="${box.w}" height="${box.h}" aria-hidden="true"><rect width="${box.w}" height="${box.h}" rx="2" fill="var(--lay-bg)"/>${shapes}</svg>`;
}

export class LayoutPanel {
  constructor({ store, el, onApply }) {
    this.store = store;
    this.el = el;
    this.aspect = null;
    el.addEventListener('click', (e) => {
      const id = e.target.closest('[data-layout]')?.dataset.layout;
      if (id) onApply(id);
    });
  }

  render() {
    const p = this.store.project;
    const current = matchLayout(p, this.store.selectedClip);
    if (this.aspect !== p.aspect) {
      this.aspect = p.aspect;
      const group = (g, title) => `<h4 class="panel-sub">${title}</h4><div class="layout-grid">${LAYOUTS.filter(l => l.group === g).map(l => `
        <button class="layout-opt" data-layout="${l.id}" title="${l.label}">${layoutDiagram(l.id, p.width, p.height)}<small>${l.label}</small></button>`).join('')}</div>`;
      this.el.innerHTML = `
        <p class="panel-note">把兩段影片放在<b>上下兩條影像軌</b>、時間重疊，選取其中一段（或把播放頭停在那裡）再點版型。<b>下面那條軌</b>是主畫面。</p>
        ${group('pip', '子母畫面')}
        ${group('split', '分割畫面')}
        <button class="ghost-btn layout-cancel" data-layout="none">${icon('close', 'icon-sm')}取消版型（回到原本的大小）</button>
        <p class="panel-note" style="margin-top:14px">套用後可以在右側調整形狀、邊框、陰影；在預覽上拖曳移動、拉角落改大小，按住 <kbd>Alt</kbd> 拖曳或用滾輪調整框裡的取景。</p>`;
    }
    this.el.querySelectorAll('.layout-opt').forEach(b => b.classList.toggle('on', b.dataset.layout === current));
  }
}

export class GraphicsPanel {
  constructor({ store, el, onAdd }) {
    this.store = store;
    this.el = el;
    this.key = null;
    el.addEventListener('click', (e) => {
      const id = e.target.closest('[data-graphic]')?.dataset.graphic;
      if (id) onAdd(id);
    });
  }

  render() {
    const p = this.store.project;
    // 分頁打開時才產生縮圖；背景與邊框跟畫面比例有關，比例改了才重畫
    if (this.el.hidden || this.key === p.aspect) return;
    this.key = p.aspect;
    const thumb = (g) => {
      const art = renderGraphic(g, p.width, p.height);
      return `<img alt="" draggable="false" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(art.svg)}">`;
    };
    this.el.innerHTML = `<p class="panel-note">點一下加到播放頭的位置。背景會放在最下面，貼圖和邊框放在最上面。</p>`
      + GRAPHIC_CATEGORIES.map(cat => `<h4 class="panel-sub">${cat.label}</h4>
        <div class="graphic-grid ${cat.id}" style="--ratio:${p.width}/${p.height}">${GRAPHICS.filter(g => g.category === cat.id).map(g => `
          <button class="graphic-opt" data-graphic="${g.id}" title="加入「${escapeHtml(g.label)}」"><span class="graphic-thumb">${thumb(g)}</span><small>${escapeHtml(g.label)}</small></button>`).join('')}
        </div>`).join('');
  }
}
