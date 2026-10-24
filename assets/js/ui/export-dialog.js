// 匯出對話框：設定 → 進度 → 完成（預覽 + 下載）

import { openModal, toast, escapeHtml } from './dialogs.js';
import { icon } from './icons.js';
import { exportVideo, detectExportSupport, outputSize, estimateBitrate, RESOLUTIONS, sanitizeFilename } from '../engine/exporter.js';
import { getDuration } from '../core/project.js';
import { formatDuration } from '../core/time.js';
import { formatBytes } from './media-panel.js';

const PREF_KEY = 'onlinecut.export';

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* 私密模式 */ }
}

export function openExportDialog({ project, runtime, player }) {
  const duration = getDuration(project);
  if (duration <= 0) {
    toast('時間軸還是空的，先加入一些素材吧', { type: 'error' });
    return;
  }
  const missing = project.clips.filter(c => c.mediaId && !runtime.has(c.mediaId));
  if (missing.length) {
    toast(`有 ${new Set(missing.map(c => c.mediaId)).size} 個素材檔案遺失，請重新匯入同一個檔案後再匯出`, { type: 'error', timeout: 7000 });
    return;
  }
  player.pause();
  const prefs = { res: '1080', fps: project.fps, quality: 'high', ...loadPrefs() };

  const body = document.createElement('div');
  body.innerHTML = `
    <div class="export-grid">
      <label class="export-row"><span>檔名</span><input class="text-input" id="exName" spellcheck="false"></label>
      <div class="export-row"><span>解析度</span><div class="seg" id="exRes">${RESOLUTIONS.map(r => `<button class="seg-btn" data-v="${r.id}">${r.label}</button>`).join('')}</div></div>
      <div class="export-row"><span>畫面更新率</span><div class="seg" id="exFps">${[24, 30, 60].map(f => `<button class="seg-btn" data-v="${f}">${f} fps</button>`).join('')}</div></div>
      <div class="export-row"><span>畫質</span><div class="seg" id="exQ"><button class="seg-btn" data-v="high">高</button><button class="seg-btn" data-v="medium">標準</button><button class="seg-btn" data-v="low">檔案小</button></div></div>
      <div class="export-summary" id="exSummary"></div>
      <p class="hint-line" id="exMethod" style="margin:0"></p>
    </div>`;
  const footer = document.createElement('div');
  footer.style.display = 'contents';
  footer.innerHTML = `<button class="ghost-btn" data-cancel>取消</button><button class="primary-btn" data-go>${icon('download')}開始匯出</button>`;
  const m = openModal({ title: '匯出影片', content: body, footer });
  const $ = (s) => body.querySelector(s);
  $('#exName').value = sanitizeFilename(project.name);

  const segs = { res: $('#exRes'), fps: $('#exFps'), quality: $('#exQ') };
  const paint = () => {
    for (const [k, el] of Object.entries(segs)) el.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('on', b.dataset.v === String(prefs[k])));
    const short = RESOLUTIONS.find(r => r.id === prefs.res)?.short ?? null;
    const { width, height } = outputSize(project, short);
    const br = estimateBitrate(width, height, +prefs.fps, prefs.quality);
    const size = (br + 192000) / 8 * duration;
    $('#exSummary').innerHTML = `<span>${width}×${height}</span><span>${prefs.fps} fps</span><span>${formatDuration(duration)}</span><span>約 ${formatBytes(size)}</span>`;
    detectExportSupport(project, { short, fps: +prefs.fps, quality: prefs.quality }).then(s => {
      const el = $('#exMethod');
      if (!el) return;
      if (s.method === 'webcodecs') el.innerHTML = `${icon('bolt', 'icon-sm')} MP4（H.264${s.audio ? ` + ${s.audio === 'aac' ? 'AAC' : 'Opus'}` : ''}），逐格渲染，切到別的分頁也會繼續。`;
      else if (s.method === 'recorder') el.innerHTML = `${icon('info', 'icon-sm')} 這個瀏覽器會用即時錄製輸出 ${s.container.toUpperCase()}：需要 ${formatDuration(duration)}，匯出時請留在這個分頁。`;
      else el.innerHTML = `${icon('alert', 'icon-sm')} 這個瀏覽器不支援匯出影片，請改用最新版 Chrome、Edge 或 Safari。`;
      footer.querySelector('[data-go]').disabled = !s.method;
      el.querySelectorAll('.icon').forEach(i => { i.style.display = 'inline'; i.style.verticalAlign = '-3px'; });
    });
  };
  for (const [k, el] of Object.entries(segs)) {
    el.addEventListener('click', (e) => {
      const v = e.target.closest('[data-v]')?.dataset.v;
      if (!v) return;
      prefs[k] = k === 'fps' ? +v : v;
      savePrefs({ res: prefs.res, fps: prefs.fps, quality: prefs.quality });
      paint();
    });
  }
  paint();
  footer.querySelector('[data-cancel]').onclick = () => m.close();
  footer.querySelector('[data-go]').onclick = () => run();

  async function run() {
    const filename = sanitizeFilename($('#exName').value);
    const short = RESOLUTIONS.find(r => r.id === prefs.res)?.short ?? null;
    const ctrl = new AbortController();
    m.setDismissible(false);
    m.body.innerHTML = `
      <p id="exPhase">準備中…</p>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div id="exBar"></div></div>
      <div class="progress-meta"><span id="exPct">0%</span><span id="exEta"></span></div>
      <p class="hint-line">全部在你的電腦上處理，不會上傳任何檔案。</p>`;
    footer.innerHTML = '<button class="ghost-btn" data-stop>取消匯出</button>';
    footer.querySelector('[data-stop]').onclick = () => ctrl.abort();
    const bar = m.body.querySelector('#exBar'), pct = m.body.querySelector('#exPct'), eta = m.body.querySelector('#exEta'), phase = m.body.querySelector('#exPhase');
    const pb = m.body.querySelector('.progress');
    const t0 = performance.now();
    try {
      const res = await exportVideo({
        project, runtime, signal: ctrl.signal,
        settings: { short, fps: prefs.fps, quality: prefs.quality },
        onProgress: (p) => {
          const total = p.phase === 'audio' ? p.progress * 0.05 : p.phase === 'video' ? 0.05 + p.progress * 0.93 : 0.99;
          bar.style.width = `${(total * 100).toFixed(1)}%`;
          pb.setAttribute('aria-valuenow', Math.round(total * 100));
          pct.textContent = `${Math.round(total * 100)}%`;
          phase.textContent = p.phase === 'audio' ? '混合聲音…' : p.phase === 'video' ? (p.frames ? `渲染畫面 ${p.frame} / ${p.frames}` : '錄製中…') : '封裝檔案…';
          eta.textContent = p.eta != null && isFinite(p.eta) ? `剩下約 ${formatDuration(Math.ceil(p.eta))}` : '';
        },
      });
      const secs = (performance.now() - t0) / 1000;
      showDone(res, filename, secs);
    } catch (e) {
      m.setDismissible(true);
      if (e.name === 'AbortError') { m.close(); toast('已取消匯出'); return; }
      console.error(e);
      m.body.innerHTML = `<p style="color:#ff8a73">${icon('alert', 'icon-sm')} 匯出失敗：${escapeHtml(e.message || e)}</p><p class="hint-line">如果一直失敗，可以試著降低解析度，或改用最新版 Chrome。</p>`;
      footer.innerHTML = '<button class="ghost-btn" data-close2>關閉</button>';
      footer.querySelector('[data-close2]').onclick = () => m.close();
    }
  }

  function showDone(res, filename, secs) {
    m.setDismissible(true);
    const url = URL.createObjectURL(res.blob);
    const name = `${filename}.${res.ext}`;
    m.body.innerHTML = `
      <div class="export-done">
        <div class="ok">${icon('check')}</div>
        <p style="margin:0 0 4px;color:var(--text);font-weight:600">影片完成了</p>
        <p style="margin:0" class="hint-line">${escapeHtml(name)} · ${formatBytes(res.blob.size)} · ${res.width}×${res.height} · 花了 ${formatDuration(Math.max(1, secs))}</p>
        <video controls playsinline src="${url}"></video>
      </div>`;
    footer.innerHTML = `<button class="ghost-btn" data-close2>關閉</button><a class="primary-btn" data-dl href="${url}" download="${escapeHtml(name)}" style="text-decoration:none">${icon('download')}下載影片</a>`;
    footer.querySelector('[data-close2]').onclick = () => m.close();
    // 保留一段時間讓使用者可以再次下載，之後釋放記憶體
    setTimeout(() => URL.revokeObjectURL(url), 30 * 60 * 1000);
    footer.querySelector('[data-dl]').click();
  }
}
