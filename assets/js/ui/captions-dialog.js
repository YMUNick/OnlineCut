// 「AI 自動上字幕」對話框：設定服務商與 API Key、選聲音來源與語言，辨識完放到新的字幕軌

import { PROVIDERS, transcribe, speechRange, TranscribeError } from '../engine/transcribe.js';
import { buildCaptions, toSRT, lineUnitsFor } from '../core/captions.js';
import { formatDuration } from '../core/time.js';
import { openModal, escapeHtml, busy } from './dialogs.js';
import { icon } from './icons.js';
import { _t, isEn } from '../i18n.js';

const LS_KEY = 'onlinecut.ai';
let sessionKey = ''; // 不記住時，只留在這次開啟的分頁裡

export const LANGUAGES = [
  ['', _t('自動偵測')], ['zh', _t('中文（繁體）')], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'], // i18n-ignore：語言用原文名稱
  ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['th', 'ไทย'], ['vi', 'Tiếng Việt'], ['id', 'Bahasa Indonesia'],
];

export function loadAiSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch { /* 沒有或壞掉 */ }
  const provider = PROVIDERS[s.provider] ? s.provider : 'openai';
  return {
    provider,
    base: typeof s.base === 'string' ? s.base : '',
    model: typeof s.model === 'string' ? s.model : '',
    language: typeof s.language === 'string' ? s.language : (isEn ? '' : 'zh'),
    remember: s.remember !== false,
    apiKey: (s.remember !== false && typeof s.apiKey === 'string' ? s.apiKey : '') || sessionKey,
  };
}

function saveAiSettings(s) {
  sessionKey = s.apiKey;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...s, apiKey: s.remember ? s.apiKey : undefined }));
  } catch { /* 無痕模式等 */ }
}

/** 聲音來源：所有影片 / 所有聲音 / 選取的片段 */
function sourceClips(project, which, selection) {
  const has = (c) => c.type === 'video' || c.type === 'audio';
  if (which === 'selection') return project.clips.filter(c => selection.includes(c.id) && has(c)).map(c => c.id);
  if (which === 'all') return project.clips.filter(has).map(c => c.id);
  return project.clips.filter(c => c.type === 'video').map(c => c.id);
}

/**
 * 開啟對話框。onInsert(captions) 把字幕加到時間軸，回傳加入的段數。
 */
export function openCaptionsDialog({ project, runtime, selection, onInsert }) {
  const s = loadAiSettings();
  const lineUnits = lineUnitsFor(project.width, Math.round(Math.min(project.width, project.height) * 0.052));
  const ranges = Object.fromEntries(['video', 'all', 'selection'].map(k => [k, speechRange(project, sourceClips(project, k, selection))]));
  const defaultSource = ranges.selection && selection.length ? 'selection' : ranges.video ? 'video' : 'all';
  const len = (k) => (ranges[k] ? formatDuration(ranges[k][1] - ranges[k][0]) : _t('沒有'));

  const body = document.createElement('div');
  body.innerHTML = `
    <p class="hint-line" style="margin:0 0 14px">${_t('用語音辨識把影片裡說的話變成字幕，一句一段放到新的「字幕」軌，之後每一段都可以再修改。')}</p>
    <div class="export-grid">
      <div class="export-row"><span>${_t('服務商')}</span>
        <select class="select" id="aiProvider">${Object.entries(PROVIDERS).map(([id, p]) => `<option value="${id}">${escapeHtml(id === 'custom' ? _t('自訂（OpenAI 相容 API）') : `${p.label} · ${p.model}`)}</option>`).join('')}</select></div>
      <label class="export-row" data-custom><span>${_t('API 網址')}</span><input class="text-input" id="aiBase" placeholder="https://example.com/v1" spellcheck="false"></label>
      <label class="export-row" data-custom><span>${_t('模型')}</span><input class="text-input" id="aiModel" placeholder="whisper-1" spellcheck="false"></label>
      <div class="export-row"><span>API Key</span>
        <div class="ai-key"><input class="text-input" id="aiKey" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…"><a id="aiKeyLink" target="_blank" rel="noopener">${_t('取得 API Key')}</a></div></div>
      <div class="export-row"><span></span><label class="check"><input type="checkbox" id="aiRemember">${_t('記住 API Key（只存在這個瀏覽器）')}</label></div>
      <div class="export-row"><span>${_t('聲音來源')}</span>
        <select class="select" id="aiSource">
          <option value="video" ${ranges.video ? '' : 'disabled'}>${_t('所有影片的聲音（{len}）', { len: len('video') })}</option>
          <option value="all" ${ranges.all ? '' : 'disabled'}>${_t('所有聲音，含音樂軌（{len}）', { len: len('all') })}</option>
          <option value="selection" ${ranges.selection ? '' : 'disabled'}>${_t('選取的片段（{len}）', { len: len('selection') })}</option>
        </select></div>
      <div class="export-row"><span>${_t('語言')}</span>
        <select class="select" id="aiLang">${LANGUAGES.map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join('')}</select></div>
    </div>
    <p class="hint-line ai-privacy">${icon('shield', 'icon-sm')}<span id="aiPrivacy"></span></p>
    <p class="hint-line ai-error" id="aiError" role="alert" hidden></p>`;
  const footer = document.createElement('div');
  footer.style.display = 'contents';
  footer.innerHTML = `<button class="ghost-btn" data-cancel>${_t('取消')}</button><button class="primary-btn" data-go>${icon('sparkle')}${_t('產生字幕')}</button>`;
  const m = openModal({ title: _t('AI 自動上字幕'), content: body, footer, width: 560 });
  const $ = (q) => body.querySelector(q);

  $('#aiProvider').value = s.provider;
  $('#aiBase').value = s.base;
  $('#aiModel').value = s.model;
  $('#aiKey').value = s.apiKey;
  $('#aiRemember').checked = s.remember;
  $('#aiSource').value = defaultSource;
  $('#aiLang').value = s.language;
  const paint = () => {
    const id = $('#aiProvider').value, p = PROVIDERS[id];
    body.querySelectorAll('[data-custom]').forEach(el => { el.hidden = id !== 'custom'; });
    $('#aiKeyLink').hidden = !p.keyUrl;
    if (p.keyUrl) $('#aiKeyLink').href = p.keyUrl;
    const host = id === 'custom' ? ($('#aiBase').value.trim() || _t('你設定的網址')) : p.label;
    $('#aiPrivacy').textContent = _t('按下「產生字幕」後，這段聲音（不含畫面）會用你的 API Key 直接從瀏覽器傳到 {host} 做辨識，不會經過 OnlineCut。費用由服務商向你收取。', { host });
  };
  $('#aiProvider').onchange = paint;
  $('#aiBase').oninput = paint;
  paint();
  requestAnimationFrame(() => (s.apiKey ? footer.querySelector('[data-go]') : $('#aiKey')).focus());

  const showError = (msg) => { $('#aiError').hidden = !msg; $('#aiError').textContent = msg || ''; };
  let controller = null;
  footer.querySelector('[data-cancel]').onclick = () => { if (controller) controller.abort(); else m.close(); };
  footer.querySelector('[data-go]').onclick = async () => {
    const provider = $('#aiProvider').value;
    const p = PROVIDERS[provider];
    const settings = {
      provider,
      base: $('#aiBase').value.trim(),
      model: $('#aiModel').value.trim(),
      language: $('#aiLang').value,
      remember: $('#aiRemember').checked,
      apiKey: $('#aiKey').value.trim(),
    };
    const base = provider === 'custom' ? settings.base : p.base;
    const model = (provider === 'custom' && settings.model) || p.model;
    if (!settings.apiKey) { showError(_t('請輸入 API Key。')); $('#aiKey').focus(); return; }
    if (!/^https?:\/\//.test(base)) { showError(_t('請輸入 API 網址（例如 https://example.com/v1）。')); $('#aiBase').focus(); return; }
    saveAiSettings(settings);
    showError('');
    const clipIds = sourceClips(project, $('#aiSource').value, selection);

    // 進行中
    const form = body.querySelector('.export-grid');
    form.querySelectorAll('input, select').forEach(el => { el.disabled = true; });
    footer.querySelector('[data-go]').disabled = true;
    footer.querySelector('[data-cancel]').textContent = _t('停止');
    m.setDismissible(false);
    const prog = document.createElement('div');
    prog.className = 'ai-progress';
    prog.innerHTML = `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div></div></div><div class="progress-meta"><span></span><span></span></div>`;
    form.after(prog);
    const bar = prog.querySelector('.progress > div');
    const [label, detail] = prog.querySelectorAll('.progress-meta span');
    controller = new AbortController();
    busy.start();
    try {
      const segments = await transcribe({
        project, runtime, clipIds, base, model, apiKey: settings.apiKey, language: settings.language, signal: controller.signal,
        onProgress: ({ stage, done, total }) => {
          // 混音（解碼）佔前 30%，辨識佔後 70%
          const f = stage === 'mix' ? 0.3 * (done / (total || 1)) : 0.3 + 0.7 * (done / (total || 1));
          bar.style.width = `${Math.min(100, f * 100).toFixed(1)}%`;
          label.textContent = stage === 'mix' ? _t('準備聲音…') : _t('辨識中…');
          detail.textContent = stage === 'upload' && total > 1 ? _t('第 {i} / {n} 段', { i: Math.min(done + 1, total), n: total }) : '';
        },
      });
      const captions = buildCaptions(segments, { lineUnits });
      if (!captions.length) throw new TranscribeError(_t('沒有辨識出任何文字（可能沒有人說話，或是語言選錯了）。'));
      const n = onInsert(captions);
      const srt = URL.createObjectURL(new Blob([toSRT(captions)], { type: 'application/x-subrip' }));
      m.setDismissible(true);
      m.body.innerHTML = `
        <div class="export-done">
          <div class="ok">${icon('check')}</div>
          <p style="margin:0 0 4px;color:var(--text);font-weight:600">${_t('已加入 {n} 段字幕', { n })}</p>
          <p class="hint-line">${_t('字幕放在時間軸最上面新的「字幕」軌。點兩下預覽上的字幕可以直接修改；選取任一段改字型、顏色或位置，整軌字幕會一起變。按 Ctrl+Z 可以整批復原。')}</p>
        </div>`;
      footer.innerHTML = `<a class="ghost-btn" download="${escapeHtml(project.name || 'captions')}.srt" href="${srt}" data-srt>${icon('download')}${_t('下載 SRT 字幕檔')}</a><button class="primary-btn" data-done>${_t('完成')}</button>`;
      footer.querySelector('[data-done]').onclick = () => m.close();
      footer.querySelector('[data-done]').focus();
    } catch (e) {
      prog.remove();
      form.querySelectorAll('input, select').forEach(el => { el.disabled = false; });
      paint();
      footer.querySelector('[data-go]').disabled = false;
      footer.querySelector('[data-cancel]').textContent = _t('取消');
      m.setDismissible(true);
      showError(e.name === 'AbortError' ? _t('已停止。') : e.message || String(e));
    } finally {
      controller = null;
      busy.end();
    }
  };
  return m;
}
