// OnlineCut 編輯器主程式：把各模組接起來

import {
  createProject, normalizeProject, addMedia, removeMedia, addClip, deleteClips, splitAtPlayhead,
  duplicateClip, getDuration, setAspect, ASPECT_PRESETS, addTrack, renameProject, DEFAULT_TEXT_DURATION,
} from './core/project.js';
import { formatTimecode, clamp } from './core/time.js';
import { Store } from './state.js';
import { store as db } from './media/store.js';
import { MediaRuntime, probe } from './media/library.js';
import { Player } from './engine/player.js';
import { Timeline, ppsToSlider, sliderToPps } from './ui/timeline.js';
import { MediaPanel } from './ui/media-panel.js';
import { Inspector } from './ui/inspector.js';
import { Preview } from './ui/preview.js';
import { openExportDialog } from './ui/export-dialog.js';
import { toast, confirmDialog, openModal, isModalOpen } from './ui/dialogs.js';
import { icon } from './ui/icons.js';
import { makeSampleFiles } from './samples.js';

const $ = (id) => document.getElementById(id);
const LS_TL_HEIGHT = 'onlinecut.timelineHeight';

// ---------- 圖示 ----------
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    if (el.dataset.iconDone) return;
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, el.classList.contains('icon-sm') ? 'icon-sm' : el.classList.contains('icon-lg') ? 'icon-lg' : ''));
    el.dataset.iconDone = '1';
  });
}
hydrateIcons();

// ---------- 核心物件 ----------
const store = new Store(createProject());
const runtime = new MediaRuntime();

const player = new Player({
  canvas: $('previewCanvas'),
  runtime,
  getProject: () => store.project,
  onTime: (t) => onTime(t),
  onState: (playing) => {
    const b = $('btnPlay');
    b.innerHTML = icon(playing ? 'pause' : 'play');
    b.setAttribute('aria-label', playing ? '暫停' : '播放');
    document.body.classList.toggle('is-playing', playing);
  },
  onFrame: (layouts) => preview.setLayouts(layouts),
});

const preview = new Preview({
  store, player,
  els: { viewport: $('viewport'), frame: $('frame'), canvas: $('previewCanvas'), overlay: $('overlay') },
});

const timeline = new Timeline({
  store, runtime,
  els: {
    scroll: $('tlScroll'), content: $('tlContent'), ruler: $('tlRuler'), tracks: $('tlTracks'),
    headList: $('tlHeadList'), playhead: $('tlPlayhead'), snapline: $('tlSnapline'),
  },
  getTime: () => player.time,
  onSeek: (t) => player.seek(t),
  onScrubStart: () => player.pause(),
  onDropMedia: (mediaId, trackId, t) => addMediaToTimeline(mediaId, { trackId, start: t }),
});
timeline.emitToast = (msg, { undo } = {}) => toast(msg, undo ? { action: { label: '復原', run: () => store.undo() } } : {});

const mediaPanel = new MediaPanel({
  store, runtime,
  els: {
    dropzone: $('dropzone'), fileInput: $('fileInput'), grid: $('mediaGrid'), empty: $('mediaEmpty'),
    tabs: [...document.querySelectorAll('.tab')], panels: [...document.querySelectorAll('.tab-panel')],
    textPresets: $('textPresets'),
  },
  onImport: (files) => importFiles(files),
  onAdd: (id) => addMediaToTimeline(id, { start: player.time }),
  onRemove: (id) => removeMediaItem(id),
  onAddText: (preset) => addText(preset),
});

const inspector = new Inspector({
  store, runtime,
  els: { inspector: $('inspector'), title: $('inspectorTitle') },
  actions: {
    split: () => splitSelected(),
    duplicate: () => duplicateSelected(),
    remove: () => deleteSelected(false),
    storageInfo: () => db.estimate(),
  },
});

window.__oc = { store, player, runtime, timeline }; // 給除錯與自動化測試用

// ============================================================
// 狀態變動 → 畫面
// ============================================================
let lastAspect = store.project.aspect;
store.on('change', ({ type }) => {
  const p = store.project;
  if (type !== 'view') {
    timeline.render();
    mediaPanel.render();
    player.syncProject();
    if (!player.playing) player.seek(Math.min(player.time, getDuration(p)));
    scheduleSave();
  } else {
    timeline.render();
  }
  inspector.update(type === 'replace');
  if (p.aspect !== lastAspect || type === 'replace') { lastAspect = p.aspect; preview.layout(); }
  preview.drawOverlay();
  if (document.activeElement !== $('projectName')) $('projectName').value = p.name;
  $('tcTotal').textContent = formatTimecode(getDuration(p), p.fps);
  $('welcome').hidden = p.clips.length > 0;
  $('btnUndo').disabled = !store.history.canUndo;
  $('btnRedo').disabled = !store.history.canRedo;
  const hasSel = store.selection.length > 0;
  $('btnDelete').disabled = !hasSel;
  $('btnDuplicate').disabled = store.selection.length !== 1;
  $('btnSplit').disabled = !p.clips.length;
  $('aspectSelect').value = p.aspect;
});

function onTime(t) {
  timeline.updatePlayhead(t);
  if (player.playing) timeline.follow(t);
  $('tcNow').textContent = formatTimecode(t, store.project.fps);
}

// ============================================================
// 儲存 / 讀取
// ============================================================
let saveTimer = 0, saving = false, pendingSave = false;
function setSaveState(text, cls = '') {
  const el = $('saveState');
  el.className = `save-state ${cls}`;
  el.innerHTML = cls === '' && text ? `${icon('check', 'icon-sm')}${text}` : text;
}
function scheduleSave() {
  clearTimeout(saveTimer);
  setSaveState('儲存中…', 'saving');
  saveTimer = setTimeout(saveNow, 600);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (saving) { pendingSave = true; return; }
  saving = true;
  try {
    await db.saveProject(store.project);
    setSaveState('已自動儲存');
  } catch (e) {
    console.error(e);
    setSaveState('無法儲存', 'error');
  } finally {
    saving = false;
    if (pendingSave) { pendingSave = false; saveNow(); }
  }
}

async function loadSaved() {
  let raw = null;
  try { raw = await db.loadProject(); } catch (e) { console.warn(e); }
  const project = raw ? normalizeProject(raw) : null;
  if (!project) { store.replace(createProject()); setSaveState(''); return; }
  let missing = 0;
  for (const m of Object.values(project.media)) {
    let file = null;
    try { file = await db.getFile(m.id); } catch { /* 讀不到就當遺失 */ }
    if (file) await runtime.register(m, file);
    else missing++;
  }
  store.replace(project);
  setSaveState('已載入上次的專案');
  if (missing) toast(`有 ${missing} 個素材檔案沒能保存下來（可能是空間不足），請重新匯入`, { type: 'error', timeout: 8000 });
}

// ============================================================
// 匯入
// ============================================================
let importSeq = 0;
async function importFiles(files) {
  const list = [...files];
  if (!list.length) return;
  const wasEmpty = store.project.clips.length === 0;
  const imported = [];
  db.persist();
  await Promise.all(list.map(async (file) => {
    const key = `imp${++importSeq}`;
    mediaPanel.addLoading(key, file.name);
    try {
      const { info, url } = await probe(file);
      try { await db.saveFile(info.id, file); } catch (e) {
        console.warn(e);
        toast(`「${file.name}」太大，無法存到瀏覽器；重新整理後需要再匯入一次`, { type: 'error', timeout: 7000 });
      }
      await runtime.register(info, file, url);
      store.commit(addMedia(store.project, info));
      imported.push(info);
    } catch (e) {
      toast(e.message || `無法匯入 ${file.name}`, { type: 'error', timeout: 6000 });
    } finally {
      mediaPanel.removeLoading(key);
    }
  }));
  if (!imported.length) return;
  // 空專案：直接排進時間軸，並把畫面比例調成跟第一支影片一樣
  if (wasEmpty) {
    imported.sort((a, b) => list.findIndex(f => f.name === a.name) - list.findIndex(f => f.name === b.name));
    const first = imported.find(m => m.type === 'video' || m.type === 'image');
    if (first?.width) matchAspect(first);
    let p = store.project;
    for (const m of imported) p = addClip(p, m.type, { mediaId: m.id }).project;
    store.commit(p);
    toast(`已匯入 ${imported.length} 個素材並排到時間軸`, { type: 'success' });
    requestAnimationFrame(() => timeline.fit());
  } else {
    toast(`已匯入 ${imported.length} 個素材，拖到時間軸或按 ＋ 加入`, { type: 'success' });
  }
}

function matchAspect(media) {
  const r = media.width / media.height;
  const best = Object.entries(ASPECT_PRESETS).sort((a, b) => Math.abs(Math.log((a[1].width / a[1].height) / r)) - Math.abs(Math.log((b[1].width / b[1].height) / r)))[0][0];
  if (best !== store.project.aspect) store.commit(setAspect(store.project, best));
}

function addMediaToTimeline(mediaId, { trackId = null, start = null } = {}) {
  const m = store.project.media[mediaId];
  if (!m) return;
  if (!runtime.has(mediaId)) { toast('這個素材的檔案遺失了，請重新匯入', { type: 'error' }); return; }
  if (!store.project.clips.length && (m.type === 'video' || m.type === 'image')) matchAspect(m);
  const { project, clip } = addClip(store.project, m.type, { mediaId, trackId, start: start ?? player.time, name: m.name });
  store.commit(project, { select: [clip.id] });
}

function addText(preset) {
  // 文字放在最上面一條沒鎖的影像軌；那條軌道在這段時間已經有東西的話，就在最上面新增一條
  let proj = store.project;
  const t = player.time;
  let track = proj.tracks.find(tr => tr.kind === 'video' && !tr.locked);
  const busy = track && proj.clips.some(c => c.trackId === track.id && t < c.start + c.duration && t + DEFAULT_TEXT_DURATION > c.start);
  if (!track || busy) {
    proj = addTrack(proj, 'video');
    track = proj.tracks[0];
  }
  const { project, clip } = addClip(proj, 'text', {
    trackId: track.id, start: t, text: { ...preset.text, content: preset.sample }, transform: preset.transform, name: preset.label,
  });
  store.commit(project, { select: [clip.id] });
}

async function removeMediaItem(id) {
  const m = store.project.media[id];
  if (!m) return;
  const n = store.project.clips.filter(c => c.mediaId === id).length;
  if (n && !(await confirmDialog({ title: '移除素材？', message: `「${m.name}」在時間軸上有 ${n} 個片段，會一起刪除。`, confirmText: '移除', danger: true }))) return;
  store.commit(removeMedia(store.project, id));
  // 檔案保留到下次清理才刪，讓「復原」還能用
  toast(`已移除「${m.name}」`, { action: { label: '復原', run: () => store.undo() } });
}

/** 清掉沒有被專案（含 undo 紀錄）用到的檔案 */
async function collectGarbage() {
  try {
    const keep = new Set(Object.keys(store.project.media));
    for (const s of [...store.history.past, ...store.history.future]) for (const id of Object.keys(s.media)) keep.add(id);
    for (const id of await db.listFileIds()) if (!keep.has(id)) await db.deleteFile(id);
  } catch { /* 下次再清 */ }
}

// ============================================================
// 編輯動作
// ============================================================
function splitSelected() {
  const { project, created } = splitAtPlayhead(store.project, player.time, store.selection);
  if (!created.length) { toast('播放頭沒有落在可以分割的片段上'); return; }
  store.commit(project);
}

function deleteSelected(ripple = store.ripple) {
  if (!store.selection.length) return;
  const n = store.selection.length;
  const next = deleteClips(store.project, store.selection, { ripple });
  if (next === store.project) { toast('鎖定的軌道不能刪除片段'); return; }
  store.commit(next, { select: [] });
  toast(`已刪除 ${n} 個片段${ripple ? '並自動補位' : ''}`, { action: { label: '復原', run: () => store.undo() } });
}

function duplicateSelected() {
  const c = store.selectedClip;
  if (!c) return;
  const r = duplicateClip(store.project, c.id);
  store.commit(r.project, { select: [r.clip.id] });
}

async function newProject() {
  const ok = !store.project.clips.length || await confirmDialog({
    title: '開新專案？', message: '目前的專案和匯入的素材會從這台裝置上刪除，這個動作無法復原。請先確認需要的影片已經匯出。', confirmText: '開新專案', danger: true,
  });
  if (!ok) return;
  player.destroy();
  runtime.releaseAll();
  try { await db.clearAll(); } catch { /* 忽略 */ }
  store.replace(createProject());
  player.seek(0);
  timeline.setZoom(60, 0);
  toast('已建立新專案');
}

async function loadSample() {
  const t = toast('正在產生範例素材…', { timeout: 0 });
  try {
    if (store.project.clips.length) {
      t();
      if (!(await confirmDialog({ title: '載入範例專案？', message: '範例會加到目前的專案裡（不會刪掉你的東西）。', confirmText: '加入範例' }))) return;
    }
    const { images, music } = await makeSampleFiles();
    const infos = [];
    for (const f of [...images, music]) {
      const { info, url } = await probe(f);
      try { await db.saveFile(info.id, f); } catch { /* 範例可重新產生 */ }
      await runtime.register(info, f, url);
      infos.push(info);
    }
    let p = store.project;
    if (!p.clips.length) p = setAspect(p, '16:9');
    for (const info of infos) p = addMedia(p, info);
    const base = Math.max(0, getDuration(p));
    const v1 = [...p.tracks].reverse().find(tr => tr.kind === 'video');
    const v2 = p.tracks.find(tr => tr.kind === 'video' && tr.id !== v1.id) ?? v1;
    infos.filter(i => i.type === 'image').forEach((info, i) => {
      p = addClip(p, 'image', { mediaId: info.id, trackId: v1.id, start: base + i * 4, duration: 4, fadeIn: i === 0 ? 0.8 : 0, fadeOut: i === 2 ? 1 : 0, name: info.name, transform: { scale: 1.06 } }).project;
    });
    const musicInfo = infos.find(i => i.type === 'audio');
    p = addClip(p, 'audio', { mediaId: musicInfo.id, start: base, duration: 12, fadeOut: 2, volume: 0.8, name: musicInfo.name }).project;
    p = addClip(p, 'text', { trackId: v2.id, start: base + 0.4, duration: 3.2, fadeIn: 0.5, fadeOut: 0.5, text: { content: 'OnlineCut', fontSize: 170, fontWeight: 900 }, name: '標題' }).project;
    p = addClip(p, 'text', { trackId: v2.id, start: base + 4.4, duration: 3.2, fadeIn: 0.3, fadeOut: 0.3, text: { content: '免費、免安裝、不上傳', fontSize: 64, fontWeight: 700, background: 'rgba(0, 0, 0, 0.55)' }, transform: { y: 380 }, name: '字幕' }).project;
    p = addClip(p, 'text', { trackId: v2.id, start: base + 8.4, duration: 3.2, fadeIn: 0.4, fadeOut: 0.8, text: { content: '開始剪你的故事', fontSize: 110, fontWeight: 900, color: '#ffd23f', strokeColor: '#1b1440', strokeWidth: 6, shadow: false }, name: '結尾' }).project;
    if (p.name === '未命名專案') p = renameProject(p, '我的第一支影片');
    store.commit(p);
    player.seek(base + 1.2);
    requestAnimationFrame(() => timeline.fit());
    t();
    toast('範例專案已載入，按空白鍵播放看看', { type: 'success' });
  } catch (e) {
    t();
    console.error(e);
    toast(`無法產生範例：${e.message}`, { type: 'error' });
  }
}

// ============================================================
// 按鈕
// ============================================================
$('btnPlay').onclick = () => player.toggle();
$('btnStart').onclick = () => player.seek(0);
$('btnEnd').onclick = () => player.seek(getDuration(store.project));
$('btnPrev').onclick = () => stepFrames(-1);
$('btnNext').onclick = () => stepFrames(1);
$('btnUndo').onclick = () => store.undo();
$('btnRedo').onclick = () => store.redo();
$('btnSplit').onclick = splitSelected;
$('btnDelete').onclick = (e) => deleteSelected(e.shiftKey || store.ripple);
$('btnDuplicate').onclick = duplicateSelected;
$('btnExport').onclick = () => openExportDialog({ project: store.project, runtime, player });
$('btnNew').onclick = newProject;
$('btnShortcuts').onclick = showShortcuts;
$('btnSample').onclick = loadSample;
$('welcomeSample').onclick = loadSample;
$('welcomeImport').onclick = () => $('fileInput').click();
$('btnAddVideoTrack').onclick = () => store.commit(addTrack(store.project, 'video'));
$('btnAddAudioTrack').onclick = () => store.commit(addTrack(store.project, 'audio'));
$('btnFullscreen').onclick = () => $('frame').requestFullscreen?.().catch(() => toast('瀏覽器不允許全螢幕'));

function toggleBtn(id, key) {
  const b = $(id);
  const paint = () => { b.classList.toggle('on', !!store[key]); b.setAttribute('aria-pressed', !!store[key]); };
  b.onclick = () => { store.setView({ [key]: !store[key] }); paint(); };
  paint();
  return paint;
}
const paintSnap = toggleBtn('btnSnap', 'snap');
toggleBtn('btnRipple', 'ripple');

const zoom = $('zoomRange');
const paintZoom = () => { zoom.value = ppsToSlider(store.pxPerSec); zoom.style.setProperty('--fill', `${zoom.value}%`); };
zoom.oninput = () => { timeline.setZoom(sliderToPps(+zoom.value)); zoom.style.setProperty('--fill', `${zoom.value}%`); };
$('btnZoomIn').onclick = () => timeline.zoomBy(1.4);
$('btnZoomOut').onclick = () => timeline.zoomBy(1 / 1.4);
$('btnZoomFit').onclick = () => timeline.fit();
store.on('change', ({ type }) => { if (type === 'view') paintZoom(); });

const vol = $('masterVol');
const paintVol = () => {
  vol.style.setProperty('--fill', `${vol.value * 100}%`);
  $('volIcon').innerHTML = icon(+vol.value === 0 ? 'volumeOff' : 'volume');
};
vol.oninput = () => { player.setMasterVolume(+vol.value); paintVol(); };
paintVol();

const aspectSel = $('aspectSelect');
aspectSel.innerHTML = Object.entries(ASPECT_PRESETS).map(([k, a]) => `<option value="${k}">${k}</option>`).join('');
aspectSel.onchange = () => store.commit(setAspect(store.project, aspectSel.value));

const nameInput = $('projectName');
nameInput.addEventListener('input', () => store.commit(renameProject(store.project, nameInput.value), { key: 'rename' }));
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') nameInput.blur(); });

function stepFrames(n) {
  player.pause();
  const fps = store.project.fps;
  player.seek(Math.round(player.time * fps + n) / fps);
}

// ============================================================
// 快捷鍵
// ============================================================
const SHORTCUTS = [
  ['播放', [
    ['播放 / 暫停', ['空白鍵']],
    ['上一格 / 下一格', ['←', '→']],
    ['往前 / 往後 1 秒', ['Shift', '← →']],
    ['跳到開頭 / 結尾', ['Home', 'End']],
  ]],
  ['剪輯', [
    ['在播放頭分割', ['S']],
    ['刪除', ['Delete']],
    ['刪除並補位（波紋刪除）', ['Shift', 'Delete']],
    ['複製片段', ['Ctrl', 'D']],
    ['全選', ['Ctrl', 'A']],
    ['取消選取', ['Esc']],
    ['復原 / 重做', ['Ctrl', 'Z', '/', 'Ctrl', 'Shift', 'Z']],
  ]],
  ['時間軸', [
    ['放大 / 縮小', ['Ctrl', '+', '/', '-']],
    ['符合視窗', ['Shift', 'Z']],
    ['開關吸附', ['N']],
    ['暫時不吸附（拖曳時）', ['按住 Alt']],
  ]],
  ['其他', [
    ['匯出', ['Ctrl', 'E']],
    ['顯示快捷鍵', ['?']],
  ]],
];

function showShortcuts() {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const html = `<dl class="shortcut-list">${SHORTCUTS.map(([g, items]) => `<div class="shortcut-group">${g}</div>${items.map(([label, keys]) =>
    `<dt>${label}</dt><dd>${keys.map(k => (k === '/' ? '<span style="color:var(--text-3)">/</span>' : `<kbd>${isMac && k === 'Ctrl' ? '⌘' : k}</kbd>`)).join('')}</dd>`).join('')}`).join('')}</dl>`;
  openModal({ title: '鍵盤快捷鍵', content: html });
}

function isTyping(e) {
  const t = e.target;
  return t.closest?.('input, textarea, select, [contenteditable="true"]') && !(t.type === 'range' || t.type === 'checkbox');
}

document.addEventListener('keydown', (e) => {
  if (isModalOpen()) return;
  if (isTyping(e)) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  const fps = store.project.fps;
  const handled = () => e.preventDefault();

  if (k === ' ' || k === 'k' || k === 'K') { handled(); player.toggle(); return; }
  if (mod && (k === 'z' || k === 'Z')) { handled(); e.shiftKey ? store.redo() : store.undo(); return; }
  if (mod && (k === 'y' || k === 'Y')) { handled(); store.redo(); return; }
  if (mod && (k === 'd' || k === 'D')) { handled(); duplicateSelected(); return; }
  if (mod && (k === 'a' || k === 'A')) { handled(); store.select(store.project.clips.map(c => c.id)); return; }
  if (mod && (k === 'e' || k === 'E')) { handled(); $('btnExport').click(); return; }
  if (mod && (k === 'b' || k === 'B')) { handled(); splitSelected(); return; }
  if (mod && (k === '=' || k === '+')) { handled(); timeline.zoomBy(1.4); return; }
  if (mod && k === '-') { handled(); timeline.zoomBy(1 / 1.4); return; }
  if (mod && k === '0') { handled(); timeline.fit(); return; }
  if (mod || e.altKey) return;

  if (k === 'ArrowLeft' || k === 'ArrowRight') {
    handled();
    player.pause();
    const dir = k === 'ArrowLeft' ? -1 : 1;
    player.seek(e.shiftKey ? player.time + dir : Math.round(player.time * fps + dir) / fps);
    return;
  }
  if (k === 'Home') { handled(); player.seek(0); return; }
  if (k === 'End') { handled(); player.seek(getDuration(store.project)); return; }
  if (k === 's' || k === 'S') { handled(); splitSelected(); return; }
  if (k === 'Delete' || k === 'Backspace') { handled(); deleteSelected(e.shiftKey || store.ripple); return; }
  if (k === 'Escape') { store.select([]); return; }
  if (k === 'n' || k === 'N') { store.setView({ snap: !store.snap }); paintSnap(); toast(store.snap ? '吸附：開' : '吸附：關'); return; }
  if (k === 'Z' && e.shiftKey) { handled(); timeline.fit(); return; }
  if (k === '?') { handled(); showShortcuts(); }
});

// ============================================================
// 拖放檔案到視窗
// ============================================================
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; $('dropOverlay').hidden = false; });
window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropOverlay').hidden = true; });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').hidden = true;
  importFiles(e.dataTransfer.files);
});

// ============================================================
// 時間軸高度
// ============================================================
(function resizer() {
  const app = $('app');
  const saved = +localStorage.getItem(LS_TL_HEIGHT);
  const apply = (h) => {
    const max = window.innerHeight - 52 - 220;
    h = clamp(h, 160, Math.max(160, max));
    app.style.setProperty('--tl-h', `${h}px`);
    document.documentElement.style.setProperty('--tl-h', `${h}px`);
    return h;
  };
  if (saved) apply(saved);
  const r = $('resizer');
  r.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    r.classList.add('drag');
    const y0 = e.clientY;
    const h0 = $('timelineWrap').getBoundingClientRect().height;
    const move = (ev) => { const h = apply(h0 - (ev.clientY - y0)); try { localStorage.setItem(LS_TL_HEIGHT, h); } catch { /* 忽略 */ } };
    const up = () => { r.classList.remove('drag'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
})();

// ============================================================
// 其他
// ============================================================
$('mobileNoteClose').onclick = () => $('mobileNote').classList.add('dismissed');
window.addEventListener('beforeunload', () => { if (saveTimer) saveNow(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { player.pause(); saveNow(); } });
runtime.onChange(() => { if (!player.playing) player.requestRender(); });

// 啟動
(async () => {
  await loadSaved();
  timeline.render();
  paintZoom();
  preview.layout();
  player.seek(0);
  if (store.project.clips.length) requestAnimationFrame(() => timeline.fit());
  setTimeout(collectGarbage, 5000);
  if (new URLSearchParams(location.search).has('sample') && !store.project.clips.length) loadSample();
})();
