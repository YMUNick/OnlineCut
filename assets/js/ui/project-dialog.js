// 下載專案檔（.onlinecut）對話框

import { openModal, toast, escapeHtml, busy } from './dialogs.js';
import { icon } from './icons.js';
import { formatBytes } from './media-panel.js';
import { packProject, EXTENSION } from '../core/project-file.js';
import { sanitizeFilename } from '../engine/exporter.js';
import { _t } from '../i18n.js';

export function openSaveProjectDialog({ project, runtime }) {
  const media = Object.values(project.media);
  const available = media.filter(m => runtime.has(m.id));
  const missing = media.filter(m => !runtime.has(m.id));
  const mediaBytes = available.reduce((s, m) => s + (runtime.get(m.id)?.file?.size || m.size || 0), 0);

  const body = document.createElement('div');
  body.innerHTML = `
    <div class="export-grid">
      <label class="export-row"><span>${_t('檔名')}</span><input class="text-input" id="pfName" spellcheck="false"></label>
      <label class="check" style="align-items:flex-start;line-height:1.55">
        <input type="checkbox" id="pfMedia" checked style="margin-top:2px">
        <span>${_t('包含素材檔（{n} 個，{size}）', { n: available.length, size: formatBytes(mediaBytes) })}<br>
        <small class="hint-line" style="margin:0">${_t('勾選後可以在另一台電腦直接開啟；不勾的話檔案很小，但開啟後要重新匯入素材。')}</small></span>
      </label>
      ${missing.length ? `<p class="hint-line" style="margin:0;color:#ff8a73">${icon('alert', 'icon-sm')} ${_t('有 {n} 個素材的檔案已經遺失，不會包含在專案檔裡。', { n: missing.length })}</p>` : ''}
      <div class="export-summary" id="pfSummary"></div>
    </div>`;
  const footer = document.createElement('div');
  footer.style.display = 'contents';
  footer.innerHTML = `<button class="ghost-btn" data-cancel>${_t('取消')}</button><button class="primary-btn" data-go>${icon('download')}${_t('下載專案檔')}</button>`;
  const m = openModal({ title: _t('下載專案檔'), content: body, footer });
  const $ = (s) => body.querySelector(s);
  $('#pfName').value = sanitizeFilename(project.name);
  const paint = () => {
    const withMedia = $('#pfMedia').checked;
    $('#pfSummary').innerHTML = `<span>${escapeHtml(sanitizeFilename($('#pfName').value))}${EXTENSION}</span><span>${_t('約 {size}', { size: formatBytes((withMedia ? mediaBytes : 0) + JSON.stringify(project).length) })}</span>`;
  };
  $('#pfMedia').onchange = paint;
  $('#pfName').oninput = paint;
  paint();
  footer.querySelector('[data-cancel]').onclick = () => m.close();
  footer.querySelector('[data-go]').onclick = async () => {
    const includeMedia = $('#pfMedia').checked;
    const name = `${sanitizeFilename($('#pfName').value)}${EXTENSION}`;
    m.setDismissible(false);
    m.body.innerHTML = `
      <p>${_t('正在打包…')}</p>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div id="pfBar"></div></div>
      <div class="progress-meta"><span id="pfPct">0%</span><span></span></div>`;
    footer.innerHTML = '';
    const bar = m.body.querySelector('#pfBar'), pct = m.body.querySelector('#pfPct');
    busy.start();
    try {
      const { blob, missing: skipped } = await packProject(project, async (id) => runtime.get(id)?.file ?? null, {
        includeMedia,
        onProgress: (done, total) => {
          const p = total ? done / total : 1;
          bar.style.width = `${(p * 100).toFixed(1)}%`;
          pct.textContent = `${Math.round(p * 100)}%`;
        },
      });
      const url = URL.createObjectURL(blob);
      m.setDismissible(true);
      m.body.innerHTML = `
        <div class="export-done">
          <div class="ok">${icon('check')}</div>
          <p style="margin:0 0 4px;color:var(--text);font-weight:600">${_t('專案檔已經準備好')}</p>
          <p class="hint-line" style="margin:0">${escapeHtml(name)} · ${formatBytes(blob.size)}${skipped.length ? ` · ${_t('{n} 個遺失的素材沒有包含在內', { n: skipped.length })}` : ''}</p>
          <p class="hint-line">${_t('之後在「專案 → 開啟專案檔」選這個檔案，或直接把它拖進編輯器就能繼續剪。')}</p>
        </div>`;
      footer.innerHTML = `<button class="ghost-btn" data-close2>${_t('關閉')}</button><a class="primary-btn" data-dl href="${url}" download="${escapeHtml(name)}" style="text-decoration:none">${icon('download')}${_t('再下載一次')}</a>`;
      footer.querySelector('[data-close2]').onclick = () => m.close();
      setTimeout(() => URL.revokeObjectURL(url), 30 * 60 * 1000);
      footer.querySelector('[data-dl]').click();
    } catch (e) {
      console.error(e);
      m.setDismissible(true);
      m.body.innerHTML = `<p style="color:#ff8a73">${icon('alert', 'icon-sm')} ${_t('無法建立專案檔：{reason}', { reason: escapeHtml(e.message || e) })}</p>`;
      footer.innerHTML = `<button class="ghost-btn" data-close2>${_t('關閉')}</button>`;
      footer.querySelector('[data-close2]').onclick = () => m.close();
      toast(_t('專案檔建立失敗'), { type: 'error' });
    } finally {
      busy.end();
    }
  };
}
