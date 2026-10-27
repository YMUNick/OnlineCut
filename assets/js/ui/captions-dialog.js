// AI 對話框：設定服務商與 API Key、選聲音來源與語言。
// 兩種模式：上字幕（辨識完放到新的字幕軌）、剪短影音（辨識後請語言模型挑出精華，接成約 30 秒的短影音）

import { PROVIDERS, transcribe, speechRange, TranscribeError, chatJSON } from '../engine/transcribe.js';
import { SHORT_LENGTHS, buildShortPrompt, parseShortReply, pickRanges, rangesDuration } from '../core/shorts.js';
import { getDuration } from '../core/project.js';
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
    chatModel: typeof s.chatModel === 'string' ? s.chatModel : '',
    shortLength: SHORT_LENGTHS.includes(s.shortLength) ? s.shortLength : 30,
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
export function openCaptionsDialog({ project, runtime, selection, onInsert, onShort, mode = 'captions' }) {
  const s = loadAiSettings();
  const short = mode === 'short';
  const hasMusic = project.clips.some(c => c.type === 'audio');
  const captionTracks = new Set(project.tracks.filter(t => t.name === _t('字幕')).map(t => t.id));
  const hasCaptions = project.clips.some(c => c.type === 'text' && captionTracks.has(c.trackId));
  const lineUnits = lineUnitsFor(project.width, Math.round(Math.min(project.width, project.height) * 0.052));
  const ranges = Object.fromEntries(['video', 'all', 'selection'].map(k => [k, speechRange(project, sourceClips(project, k, selection))]));
  const defaultSource = short ? (ranges.video ? 'video' : 'all') : ranges.selection && selection.length ? 'selection' : ranges.video ? 'video' : 'all';
  const len = (k) => (ranges[k] ? formatDuration(ranges[k][1] - ranges[k][0]) : _t('沒有'));

  const body = document.createElement('div');
  body.innerHTML = `
    <p class="hint-line" style="margin:0 0 14px">${short
      ? _t('AI 先聽懂影片在說什麼，再挑出最精彩的幾句接成一支短影音（YouTube Shorts、IG Reels、TikTok），開頭放最吸引人的那句。不滿意可以按 Ctrl+Z 回到原本的影片。')
      : _t('用語音辨識把影片裡說的話變成字幕，一句一段放到新的「字幕」軌，之後每一段都可以再修改。')}</p>
    <div class="export-grid">
      <div class="export-row"><span>${_t('服務商')}</span>
        <select class="select" id="aiProvider">${Object.entries(PROVIDERS).map(([id, p]) => `<option value="${id}">${escapeHtml(id === 'custom' ? _t('自訂（OpenAI 相容 API）') : `${p.label} · ${p.model}${short ? ` + ${p.chatModel}` : ''}`)}</option>`).join('')}</select></div>
      <label class="export-row" data-custom><span>${_t('API 網址')}</span><input class="text-input" id="aiBase" placeholder="https://example.com/v1" spellcheck="false"></label>
      <label class="export-row" data-custom><span>${_t('模型')}</span><input class="text-input" id="aiModel" placeholder="whisper-1" spellcheck="false"></label>
      ${short ? `<label class="export-row" data-custom><span>${_t('文字模型')}</span><input class="text-input" id="aiChatModel" placeholder="gpt-4o-mini" spellcheck="false"></label>` : ''}
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
      ${short ? `
      <div class="export-row"><span>${_t('長度')}</span><div class="seg" id="aiLen">${SHORT_LENGTHS.map(n => `<button class="seg-btn" type="button" data-v="${n}">${_t('約 {n} 秒', { n })}</button>`).join('')}</div></div>
      <label class="export-row"><span>${_t('重點')}</span><input class="text-input" id="aiHint" maxlength="200" placeholder="${_t('想強調的內容（可不填），例如：產品的三個優點')}"></label>
      <div class="export-row"><span></span><div class="ai-opts">
        <label class="check"><input type="checkbox" id="aiVertical" ${project.aspect === '9:16' ? 'disabled' : 'checked'}>${_t('改成直式 9:16，畫面放大填滿')}</label>
        <label class="check"><input type="checkbox" id="aiCaps" ${hasCaptions ? '' : 'checked'}>${_t('同時加上字幕')}</label>
        ${hasMusic ? `<label class="check"><input type="checkbox" id="aiMusic" checked>${_t('背景音樂不剪斷（連續播放、結尾淡出）')}</label>` : ''}
      </div></div>` : ''}
    </div>
    <p class="hint-line ai-privacy">${icon('shield', 'icon-sm')}<span id="aiPrivacy"></span></p>
    <p class="hint-line ai-error" id="aiError" role="alert" hidden></p>`;
  const footer = document.createElement('div');
  footer.style.display = 'contents';
  footer.innerHTML = `<button class="ghost-btn" data-cancel>${_t('取消')}</button><button class="primary-btn" data-go>${icon('sparkle')}${short ? _t('剪成短影音') : _t('產生字幕')}</button>`;
  const m = openModal({ title: short ? _t('AI 剪成短影音') : _t('AI 自動上字幕'), content: body, footer, width: 560 });
  const $ = (q) => body.querySelector(q);

  $('#aiProvider').value = s.provider;
  $('#aiBase').value = s.base;
  $('#aiModel').value = s.model;
  $('#aiKey').value = s.apiKey;
  $('#aiRemember').checked = s.remember;
  $('#aiSource').value = defaultSource;
  $('#aiLang').value = s.language;
  let shortLength = s.shortLength;
  if (short) {
    $('#aiChatModel').value = s.chatModel;
    const lenSeg = $('#aiLen');
    const paintLen = () => lenSeg.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('on', +b.dataset.v === shortLength));
    lenSeg.onclick = (e) => { const v = e.target.closest('[data-v]')?.dataset.v; if (v && !lenSeg.closest('.export-grid').inert) { shortLength = +v; paintLen(); } };
    paintLen();
  }
  const paint = () => {
    const id = $('#aiProvider').value, p = PROVIDERS[id];
    body.querySelectorAll('[data-custom]').forEach(el => { el.hidden = id !== 'custom'; });
    $('#aiKeyLink').hidden = !p.keyUrl;
    if (p.keyUrl) $('#aiKeyLink').href = p.keyUrl;
    const host = id === 'custom' ? ($('#aiBase').value.trim() || _t('你設定的網址')) : p.label;
    $('#aiPrivacy').textContent = short
      ? _t('按下「剪成短影音」後，這段聲音（不含畫面）會用你的 API Key 直接從瀏覽器傳到 {host} 做辨識，辨識出的文字再交給它的語言模型挑選精華，不會經過 OnlineCut。費用由服務商向你收取。', { host })
      : _t('按下「產生字幕」後，這段聲音（不含畫面）會用你的 API Key 直接從瀏覽器傳到 {host} 做辨識，不會經過 OnlineCut。費用由服務商向你收取。', { host });
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
      chatModel: short ? $('#aiChatModel').value.trim() : s.chatModel,
      shortLength,
    };
    const base = provider === 'custom' ? settings.base : p.base;
    const model = (provider === 'custom' && settings.model) || p.model;
    if (!settings.apiKey) { showError(_t('請輸入 API Key。')); $('#aiKey').focus(); return; }
    if (!/^https?:\/\//.test(base)) { showError(_t('請輸入 API 網址（例如 https://example.com/v1）。')); $('#aiBase').focus(); return; }
    saveAiSettings(settings);
    showError('');
    const clipIds = sourceClips(project, $('#aiSource').value, selection);
    if (short && getDuration(project) <= shortLength + 3) { showError(_t('影片本身只有 {s} 秒，已經夠短了。', { s: Math.round(getDuration(project)) })); return; }

    // 短影音的選項（下面會把表單鎖起來，先讀好）
    const shortOpts = short ? {
      vertical: $('#aiVertical').checked && project.aspect !== '9:16',
      captions: $('#aiCaps').checked,
      keepMusic: $('#aiMusic')?.checked ?? false,
      hint: $('#aiHint').value.trim(),
    } : null;

    // 進行中
    const form = body.querySelector('.export-grid');
    form.querySelectorAll('input, select').forEach(el => { el.disabled = true; });
    form.inert = true;
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
          // 混音（解碼）佔前 30%，辨識佔後 70%（剪短影音時辨識到 85%，剩下給 AI 挑選）
          const span = short ? 0.55 : 0.7;
          const f = stage === 'mix' ? 0.3 * (done / (total || 1)) : 0.3 + span * (done / (total || 1));
          bar.style.width = `${Math.min(100, f * 100).toFixed(1)}%`;
          label.textContent = stage === 'mix' ? _t('準備聲音…') : _t('辨識中…');
          detail.textContent = stage === 'upload' && total > 1 ? _t('第 {i} / {n} 段', { i: Math.min(done + 1, total), n: total }) : '';
        },
      });
      if (short) return await finishShort(segments, { base, settings, provider, p });
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
      form.inert = false;
      form.querySelectorAll('input, select').forEach(el => { el.disabled = false; });
      if (short && project.aspect === '9:16') $('#aiVertical').disabled = true;
      paint();
      footer.querySelector('[data-go]').disabled = false;
      footer.querySelector('[data-cancel]').textContent = _t('取消');
      m.setDismissible(true);
      showError(e.name === 'AbortError' ? _t('已停止。') : e.message || String(e));
    } finally {
      controller = null;
      busy.end();
    }

    /** 剪短影音：請語言模型挑段落 → 接成新的時間軸 */
    async function finishShort(segments, { base, settings, provider, p }) {
      if (!segments.length) throw new TranscribeError(_t('沒有辨識出任何文字（可能沒有人說話，或是語言選錯了）。'));
      bar.style.width = '88%';
      label.textContent = _t('AI 挑選精華…');
      detail.textContent = '';
      const chatModel = (provider === 'custom' && settings.chatModel) || p.chatModel;
      const reply = await chatJSON({
        base, apiKey: settings.apiKey, model: chatModel, signal: controller.signal,
        messages: buildShortPrompt(segments, { target: settings.shortLength, hint: shortOpts.hint, language: settings.language }),
      });
      const pick = parseShortReply(reply, segments.length);
      if (!pick) throw new TranscribeError(_t('AI 的回覆看不懂，請再試一次或換一個模型。'));
      const ranges = pickRanges(segments, pick.ids, { maxTotal: settings.shortLength * 1.3, limit: getDuration(project) });
      if (!ranges.length) throw new TranscribeError(_t('AI 的回覆看不懂，請再試一次或換一個模型。'));
      bar.style.width = '100%';
      onShort({ ranges, segments, vertical: shortOpts.vertical, captions: shortOpts.captions, keepMusic: shortOpts.keepMusic });
      const d = rangesDuration(ranges);
      m.setDismissible(true);
      m.body.innerHTML = `
        <div class="export-done">
          <div class="ok">${icon('check')}</div>
          <p style="margin:0 0 4px;color:var(--text);font-weight:600">${_t('已剪成 {s} 秒的短影音（{n} 段）', { s: Math.round(d), n: ranges.length })}</p>
          ${pick.reason ? `<p class="hint-line" style="margin:0 0 10px">${escapeHtml(pick.reason)}</p>` : ''}
          ${pick.title ? `<label class="export-row ai-title"><span>${_t('建議標題')}</span><input class="text-input" readonly value="${escapeHtml(pick.title)}"></label>` : ''}
          <p class="hint-line">${_t('按空白鍵播放看看。不滿意可以按 Ctrl+Z 回到原本的影片，再剪一次（每次挑的可能不一樣）。')}</p>
        </div>`;
      m.body.querySelector('.ai-title input')?.addEventListener('focus', (e) => e.target.select());
      footer.innerHTML = `<button class="primary-btn" data-done>${_t('完成')}</button>`;
      footer.querySelector('[data-done]').onclick = () => m.close();
      footer.querySelector('[data-done]').focus();
    }
  };
  return m;
}
