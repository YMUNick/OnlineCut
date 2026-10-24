// OnlineCut 編輯器主程式：把各模組接起來

import {
  createProject, normalizeProject, addMedia, removeMedia, addClip, deleteClips, splitAtPlayhead,
  duplicateClip, getDuration, setAspect, ASPECT_PRESETS, addTrack, renameProject, DEFAULT_TEXT_DURATION,
  DEFAULT_IMAGE_DURATION, getClip, getTrack,
} from './core/project.js';
import { LAYOUTS, layoutFrames, layoutCandidates, applyLayout } from './core/layouts.js';
import { getGraphic, renderGraphic, getTextGraphic } from './graphics.js';
import { textBox, textOuter, clearTextMeasureCache } from './engine/renderer.js';
import { ensureProjectFonts } from './ui/fonts.js';
import { LayoutPanel, GraphicsPanel } from './ui/extras-panel.js';
import { formatTimecode, clamp } from './core/time.js';
import { Store } from './state.js';
import { store as db, storageSettings } from './media/store.js';
import { MediaRuntime, probe, VIDEO_EXTS, AUDIO_EXTS, IMAGE_EXTS } from './media/library.js';
import { Player } from './engine/player.js';
import { Timeline, ppsToSlider, sliderToPps } from './ui/timeline.js';
import { MediaPanel } from './ui/media-panel.js';
import { Inspector } from './ui/inspector.js';
import { Preview } from './ui/preview.js';
import { openExportDialog } from './ui/export-dialog.js';
import { toast, confirmDialog, openModal, isModalOpen, busy } from './ui/dialogs.js';
import { icon } from './ui/icons.js';
import { makeSampleFiles } from './samples.js';
import { unpackProject, isProjectFileName, findRelinkTarget } from './core/project-file.js';
import { openSaveProjectDialog } from './ui/project-dialog.js';
import { _t, translateDom, languageSwitch } from './i18n.js';

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
translateDom();
hydrateIcons();
$('btnShortcuts').before(languageSwitch('ghost-btn lang-btn'));
document.documentElement.classList.remove('i18n-pending');

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
    b.setAttribute('aria-label', playing ? _t('暫停') : _t('播放'));
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
// 雙擊時間軸上的文字片段：播放頭不在片段上就先移過去，再打開預覽上的編輯框
timeline.onEditText = (id) => {
  const c = getClip(store.project, id);
  if (!c) return;
  if (player.time < c.start || player.time >= c.start + c.duration) player.seek(c.start + Math.min(0.5, c.duration / 2));
  preview.startTextEdit(id);
};
timeline.emitToast = (msg, { undo } = {}) => toast(msg, undo ? { action: { label: _t('復原'), run: () => store.undo() } } : {});

const mediaPanel = new MediaPanel({
  store, runtime,
  els: {
    dropzone: $('dropzone'), fileInput: $('fileInput'), grid: $('mediaGrid'), empty: $('mediaEmpty'),
    tabs: [...document.querySelectorAll('.tab')], panels: [...document.querySelectorAll('.tab-panel')],
    textPresets: $('textPresets'),
  },
  onImport: (files) => importFiles(files),
  onPick: () => pickMediaFiles(),
  onAdd: (id) => addMediaToTimeline(id, { start: player.time }),
  onRemove: (id) => removeMediaItem(id),
  onAddText: (preset) => addText(preset),
});

const layoutPanel = new LayoutPanel({ store, el: $('layoutPanel'), onApply: (id) => applyLayoutAction(id) });
const graphicsPanel = new GraphicsPanel({ store, el: $('graphicsPanel'), onAdd: (id) => addGraphic(id) });
document.querySelector('.tab[data-tab="graphics"]').addEventListener('click', () => graphicsPanel.render());

const inspector = new Inspector({
  store, runtime,
  els: { inspector: $('inspector'), title: $('inspectorTitle') },
  actions: {
    split: () => splitSelected(),
    duplicate: () => duplicateSelected(),
    remove: () => deleteSelected(false),
    storageInfo: () => db.estimate(),
    showLayouts: () => mediaPanel.showTab('layout'),
  },
});

// 給除錯與自動化測試用
window.__oc = {
  store, player, runtime, timeline,
  importEntries: (e) => importEntries(e),
  addGraphic: (id) => addGraphic(id),
  applyLayout: (id) => applyLayoutAction(id),
  /** 模擬關掉再開啟：放掉所有素材，從瀏覽器儲存重新載入 */
  simulateRestart: async () => { player.destroy(); runtime.releaseAll(); pendingHandles.length = 0; await loadSaved(); },
};

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
  layoutPanel.render();
  graphicsPanel.render();
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

// 文字用到的字型：用到時才載入；載入完成後重畫（量字的快取要清掉）
let fontTimer = 0;
store.on('change', ({ type }) => {
  if (type === 'view') return;
  clearTimeout(fontTimer);
  fontTimer = setTimeout(() => ensureProjectFonts(store.project), 200);
});
document.fonts?.addEventListener?.('loadingdone', () => {
  clearTextMeasureCache();
  player.render();
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
  setSaveState(_t('儲存中…'), 'saving');
  saveTimer = setTimeout(saveNow, 600);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (saving) { pendingSave = true; return; }
  saving = true;
  try {
    await db.saveProject(store.project);
    setSaveState(_t('已自動儲存'));
  } catch (e) {
    console.error(e);
    setSaveState(_t('無法儲存'), 'error');
  } finally {
    saving = false;
    if (pendingSave) { pendingSave = false; saveNow(); }
  }
}

// ------------------------------------------------------------
// 素材的保存（讓重新整理後還在）
// 小檔案：在背景複製一份到瀏覽器。大檔案：不複製（不多佔硬碟），
// 有檔案代號（Chrome / Edge）就記住位置，下次請使用者允許讀取；沒有就需要重新匯入。
// ------------------------------------------------------------
const isLarge = (file) => file.size > storageSettings.copyLimitBytes;

/** 回傳 'copied' | 'handle' | 'none' */
async function persistMedia(id, file, handle) {
  if (!isLarge(file)) {
    busy.start();
    db.saveFile(id, file)
      .catch((e) => {
        console.warn(e);
        toast(_t('「{name}」無法存到瀏覽器（空間可能不足）；重新整理後需要再匯入一次', { name: file.name }), { type: 'error', timeout: 7000 });
      })
      .finally(() => busy.end());
    return 'copied';
  }
  if (handle) {
    try { await db.saveHandle(id, handle); return 'handle'; } catch (e) { console.warn(e); }
  }
  return 'none';
}

function explainLargeFiles(results) {
  const none = results.filter(r => r.how === 'none').map(r => r.name);
  const handled = results.filter(r => r.how === 'handle');
  if (none.length) {
    const msg = none.length > 1
      ? _t('「{name}」等 {n} 個大型檔案沒有複製到瀏覽器，不會多佔硬碟空間。重新整理或下次開啟時需要再匯入一次（會自動接回）。', { name: none[0], n: none.length })
      : _t('「{name}」是大型檔案，沒有複製到瀏覽器，不會多佔硬碟空間。重新整理或下次開啟時需要再匯入一次（會自動接回）。', { name: none[0] });
    toast(msg, { timeout: 10000 });
  }
  let tipShown = false;
  try { tipShown = localStorage.getItem('onlinecut.handleTip') === '1'; } catch { /* 私密模式 */ }
  if (handled.length && !tipShown) {
    toast(_t('大型檔案只記住它在電腦上的位置，沒有複製，不會多佔硬碟空間。下次開啟時會請你允許讀取。'), { timeout: 10000 });
    try { localStorage.setItem('onlinecut.handleTip', '1'); } catch { /* 私密模式 */ }
  }
}

/** 用記住的檔案代號接回素材。ask = true 時可以跳出權限詢問（需要使用者點擊） */
async function restoreFromHandle(info, handle, ask) {
  try {
    let perm = (await handle.queryPermission?.({ mode: 'read' })) ?? 'granted';
    if (perm !== 'granted') {
      if (!ask) return 'prompt';
      perm = await handle.requestPermission({ mode: 'read' });
      if (perm !== 'granted') return 'denied';
    }
    const file = await handle.getFile();
    if (info.size != null && file.size !== info.size) return 'changed';
    await runtime.register(info, file);
    return 'ok';
  } catch (e) {
    console.warn(e);
    return 'gone';
  }
}

const pendingHandles = []; // 等使用者允許讀取的大型素材 { info, handle }
async function grantPendingHandles() {
  const list = pendingHandles.splice(0);
  const results = [];
  for (const { info, handle } of list) results.push(await restoreFromHandle(info, handle, true));
  store.emit('change', { type: 'media' });
  const ok = results.filter(r => r === 'ok').length;
  const gone = results.filter(r => r === 'gone' || r === 'changed').length;
  const denied = results.filter(r => r === 'denied' || r === 'prompt').length;
  if (ok) toast(_t('已接回 {n} 個大型素材', { n: ok }), { type: 'success' });
  if (gone) toast(_t('有 {n} 個大型素材找不到原始檔案（可能被移動、改名或修改過），請重新匯入', { n: gone }), { type: 'error', timeout: 9000 });
  if (denied) {
    list.filter((_, i) => results[i] === 'denied' || results[i] === 'prompt').forEach(x => pendingHandles.push(x));
    askForHandlePermission();
  }
}

function askForHandlePermission() {
  if (!pendingHandles.length) return;
  const n = pendingHandles.length;
  toast(_t('有 {n} 個大型素材沒有複製到瀏覽器，需要你允許讀取電腦上的原始檔案', { n }), { timeout: 0, action: { label: _t('允許讀取'), run: grantPendingHandles } });
}

async function loadSaved() {
  let raw = null;
  try { raw = await db.loadProject(); } catch (e) { console.warn(e); }
  const project = raw ? normalizeProject(raw) : null;
  if (!project) { store.replace(createProject()); setSaveState(''); return; }
  let missing = 0, gone = 0;
  for (const m of Object.values(project.media)) {
    let file = null;
    try { file = await db.getFile(m.id); } catch { /* 讀不到就當遺失 */ }
    if (file) { await runtime.register(m, file); continue; }
    let handle = null;
    try { handle = await db.getHandle(m.id); } catch { /* 沒有 */ }
    if (!handle) { missing++; continue; }
    const r = await restoreFromHandle(m, handle, false);
    if (r === 'prompt') pendingHandles.push({ info: m, handle });
    else if (r !== 'ok') gone++;
  }
  store.replace(project);
  setSaveState(_t('已載入上次的專案'));
  if (missing) toast(_t('有 {n} 個素材需要重新匯入（大型檔案或空間不足時沒有存到瀏覽器），匯入同一個檔案就會自動接回', { n: missing }), { type: 'error', timeout: 9000 });
  if (gone) toast(_t('有 {n} 個大型素材找不到原始檔案（可能被移動、改名或修改過），請重新匯入', { n: gone }), { type: 'error', timeout: 9000 });
  askForHandlePermission();
}

// ============================================================
// 匯入
// ============================================================
const MEDIA_ACCEPT = { 'video/*': VIDEO_EXTS, 'audio/*': AUDIO_EXTS, 'image/*': IMAGE_EXTS };

/** 選檔：支援的瀏覽器用 showOpenFilePicker（拿得到檔案代號，大檔案就不用複製） */
async function pickMediaFiles() {
  if (typeof window.showOpenFilePicker !== 'function') { $('fileInput').click(); return; }
  let handles;
  try {
    handles = await window.showOpenFilePicker({ multiple: true, id: 'onlinecut-media', types: [{ description: _t('影片、音樂、圖片'), accept: MEDIA_ACCEPT }] });
  } catch (e) {
    if (e?.name !== 'AbortError') $('fileInput').click(); // 不是使用者取消：退回一般選檔
    return;
  }
  const entries = [];
  for (const h of handles) {
    try { entries.push({ file: await h.getFile(), handle: h }); } catch (e) { toast(_t('無法讀取「{name}」', { name: h.name }), { type: 'error' }); }
  }
  importEntries(entries);
}

let importSeq = 0;
function importFiles(files) {
  return importEntries([...files].map(file => ({ file, handle: null })));
}

/** entries: [{ file, handle(可能沒有) }] */
async function importEntries(entries) {
  let list = entries.filter(e => e && e.file);
  if (!list.length) return;
  // 專案檔另外處理（一次只開一個）
  const projectFiles = list.filter(e => isProjectFileName(e.file.name));
  if (projectFiles.length) {
    if (projectFiles.length > 1 || list.length > projectFiles.length) toast(_t('一次只能開啟一個專案檔，其他檔案沒有匯入'), { timeout: 6000 });
    await openProjectFile(projectFiles[0].file);
    return;
  }
  db.persist();
  const persisted = [];
  // 檔名與大小都跟「遺失的素材」一樣：直接接回去，不新增素材
  const relinked = [];
  const rest = [];
  for (const e of list) {
    const target = findRelinkTarget(store.project, e.file, (id) => !runtime.has(id) && !relinked.includes(id));
    if (!target) { rest.push(e); continue; }
    relinked.push(target.id);
    const i = pendingHandles.findIndex(p => p.info.id === target.id);
    if (i >= 0) pendingHandles.splice(i, 1);
    await runtime.register(target, e.file);
    persisted.push({ name: e.file.name, how: await persistMedia(target.id, e.file, e.handle) });
  }
  if (relinked.length) {
    store.emit('change', { type: 'media' });
    toast(_t('已接回 {n} 個遺失的素材', { n: relinked.length }), { type: 'success' });
  }
  list = rest;
  if (!list.length) { explainLargeFiles(persisted); return; }
  const wasEmpty = store.project.clips.length === 0;
  const imported = [];
  await Promise.all(list.map(async ({ file, handle }) => {
    const key = `imp${++importSeq}`;
    mediaPanel.addLoading(key, file.name);
    try {
      const { info, url } = await probe(file);
      // 不等複製完成：素材馬上可以用
      await runtime.register(info, file, url);
      store.commit(addMedia(store.project, info));
      imported.push(info);
      persisted.push({ name: file.name, how: await persistMedia(info.id, file, handle) });
    } catch (e) {
      toast(e.message || _t('無法匯入 {name}', { name: file.name }), { type: 'error', timeout: 6000 });
    } finally {
      mediaPanel.removeLoading(key);
    }
  }));
  explainLargeFiles(persisted);
  if (!imported.length) return;
  // 空專案：直接排進時間軸，並把畫面比例調成跟第一支影片一樣
  if (wasEmpty) {
    imported.sort((a, b) => list.findIndex(e => e.file.name === a.name) - list.findIndex(e => e.file.name === b.name));
    const first = imported.find(m => m.type === 'video' || m.type === 'image');
    if (first?.width) matchAspect(first);
    let p = store.project;
    for (const m of imported) p = addClip(p, m.type, { mediaId: m.id }).project;
    store.commit(p);
    toast(_t('已匯入 {n} 個素材並排到時間軸', { n: imported.length }), { type: 'success' });
    requestAnimationFrame(() => timeline.fit());
  } else {
    toast(_t('已匯入 {n} 個素材，拖到時間軸或按 ＋ 加入', { n: imported.length }), { type: 'success' });
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
  if (!runtime.has(mediaId)) { toast(_t('這個素材的檔案遺失了，請重新匯入'), { type: 'error' }); return; }
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

/** 套用雙畫面版型到選取的片段（不夠時補上播放頭位置的其他畫面） */
function applyLayoutAction(id) {
  const p = store.project, t = player.time;
  const unlocked = (c) => !getTrack(p, c.trackId)?.locked;
  if (id === 'none') {
    let clips = store.selection.map(cid => getClip(p, cid)).filter(c => c?.frame && unlocked(c));
    if (!clips.length) clips = p.clips.filter(c => c.frame && unlocked(c) && t >= c.start && t < c.start + c.duration);
    if (!clips.length) { toast(_t('播放頭這裡沒有套用版型的畫面')); return; }
    store.commit(applyLayout(p, clips.map(c => c.id), 'none').project);
    toast(_t('已取消 {n} 個畫面的版型', { n: clips.length }), { action: { label: _t('復原'), run: () => store.undo() } });
    return;
  }
  const layout = LAYOUTS.find(l => l.id === id);
  const slots = layoutFrames(id, p.width, p.height)?.length ?? 0;
  if (!layout || !slots) return;
  const clips = layoutCandidates(p, store.selection.filter(cid => { const c = getClip(p, cid); return c && unlocked(c); }), t, slots);
  if (clips.length < 2) {
    toast(_t('版型需要兩段同時出現的影片或圖片：把第二段放到上面的影像軌、跟第一段時間重疊，再點一次版型。'), { timeout: 8000 });
    return;
  }
  const { project, applied } = applyLayout(p, clips.map(c => c.id), id);
  const top = clips[clips.length - 1];
  store.commit(project, { select: [top.id] });
  const msg = slots > applied
    ? _t('已套用「{name}」（這個版型有 {slots} 格，目前只有 {n} 個畫面）', { name: layout.label, slots, n: applied })
    : _t('已套用「{name}」', { name: layout.label });
  toast(msg, { type: 'success', action: { label: _t('復原'), run: () => store.undo() } });
}

/** 加入內建圖案：背景放最下面，貼圖和邊框放最上面 */
async function addGraphic(id) {
  const tg = getTextGraphic(id);
  if (tg) { addTextGraphic(tg); return; }
  const g = getGraphic(id);
  if (!g) return;
  const t = player.time;
  let p = store.project;
  const art = renderGraphic(g, p.width, p.height);
  // 同一個圖案（同尺寸）已經在專案裡就重複使用
  let info = Object.values(p.media).find(m => m.type === 'image' && m.name === art.name && m.width === art.width && m.height === art.height && runtime.has(m.id));
  if (!info) {
    const file = new File([art.svg], art.name, { type: 'image/svg+xml' });
    try {
      const r = await probe(file);
      await runtime.register(r.info, file, r.url);
      info = r.info;
      persistMedia(info.id, file, null);
    } catch (e) {
      toast(_t('無法加入圖案：{reason}', { reason: e.message }), { type: 'error' });
      return;
    }
    p = addMedia(store.project, info);
  }
  const W = p.width, H = p.height, short = Math.min(W, H);
  // 背景與邊框蓋住播放頭之後的整段影片（至少預設長度）
  const rest = getDuration(p) - t;
  const longDur = rest > 0.5 ? rest : DEFAULT_IMAGE_DURATION;
  const busyOn = (track, dur) => p.clips.some(c => c.trackId === track.id && t < c.start + c.duration && t + dur > c.start);
  let track, fields;
  if (g.category === 'bg') {
    track = [...p.tracks].reverse().find(tr => tr.kind === 'video' && !tr.locked);
    if (!track || busyOn(track, longDur)) {
      p = addTrack(p, 'video', { position: 'bottom' });
      track = [...p.tracks].reverse().find(tr => tr.kind === 'video');
    }
    fields = { duration: longDur };
  } else {
    track = p.tracks.find(tr => tr.kind === 'video' && !tr.locked);
    // 貼圖預設 5 秒，但不超過播放頭之後的影片長度
    const dur = g.category === 'frame' ? longDur : rest > 0.5 ? Math.min(DEFAULT_IMAGE_DURATION, rest) : DEFAULT_IMAGE_DURATION;
    if (!track || busyOn(track, dur)) {
      p = addTrack(p, 'video');
      track = p.tracks[0];
    }
    if (g.category === 'frame') fields = { duration: dur };
    else {
      // 貼圖放在右上角，大約短邊的三分之一
      const scale = 0.32, size = short * scale, m = short * 0.07;
      fields = { duration: dur, transform: { scale, x: Math.round(W / 2 - m - size / 2), y: Math.round(-(H / 2 - m - size / 2)) } };
    }
  }
  const { project, clip } = addClip(p, 'image', { mediaId: info.id, trackId: track.id, start: t, name: g.label, ...fields });
  store.commit(project, { select: [clip.id] });
}

/** 加入文字貼圖（有外框造型的文字），放在最上面的影像軌，依樣板放到畫面的角落或中間 */
let textEditHintShown = false;
function addTextGraphic(g) {
  let proj = store.project;
  const t = player.time;
  const rest = getDuration(proj) - t;
  const duration = rest > 0.5 ? Math.min(DEFAULT_TEXT_DURATION, rest) : DEFAULT_TEXT_DURATION;
  let track = proj.tracks.find(tr => tr.kind === 'video' && !tr.locked);
  const busy = track && proj.clips.some(c => c.trackId === track.id && t < c.start + c.duration && t + duration > c.start);
  if (!track || busy) {
    proj = addTrack(proj, 'video');
    track = proj.tracks[0];
  }
  // 依實際大小放到角落（量字要用 canvas）
  const ctx = document.createElement('canvas').getContext('2d');
  const box = textBox(g.text, (font, line) => { ctx.font = font; return ctx.measureText(line).width; });
  const outer = textOuter(g.text, box);
  const W = proj.width, H = proj.height, m = Math.min(W, H) * 0.06;
  const pos = {
    tr: { x: W / 2 - m - outer.w / 2, y: -(H / 2 - m - outer.h / 2) },
    tl: { x: -(W / 2 - m - outer.w / 2), y: -(H / 2 - m - outer.h / 2) },
    bl: { x: -(W / 2 - m - outer.w / 2), y: H / 2 - m * 1.6 - outer.h / 2 },
    bottom: { x: 0, y: H / 2 - m * 1.6 - outer.h / 2 },
  }[g.place] ?? { x: 0, y: 0 };
  const { project, clip } = addClip(proj, 'text', {
    trackId: track.id, start: t, duration, name: g.label, text: { ...g.text },
    transform: { x: Math.round(pos.x), y: Math.round(pos.y), rotation: g.rotation || 0 },
  });
  store.commit(project, { select: [clip.id] });
  if (!textEditHintShown) {
    textEditHintShown = true;
    toast(_t('在預覽畫面上點兩下，就能直接改字、換字型'), { timeout: 6000 });
  }
}

async function removeMediaItem(id) {
  const m = store.project.media[id];
  if (!m) return;
  const n = store.project.clips.filter(c => c.mediaId === id).length;
  if (n && !(await confirmDialog({ title: _t('移除素材？'), message: _t('「{name}」在時間軸上有 {n} 個片段，會一起刪除。', { name: m.name, n }), confirmText: _t('移除'), danger: true }))) return;
  store.commit(removeMedia(store.project, id));
  // 檔案保留到下次清理才刪，讓「復原」還能用
  toast(_t('已移除「{name}」', { name: m.name }), { action: { label: _t('復原'), run: () => store.undo() } });
}

/** 清掉沒有被專案（含 undo 紀錄）用到的檔案 */
async function collectGarbage() {
  try {
    const keep = new Set(Object.keys(store.project.media));
    for (const s of [...store.history.past, ...store.history.future]) for (const id of Object.keys(s.media)) keep.add(id);
    for (const id of await db.listFileIds()) if (!keep.has(id)) await db.deleteFile(id);
    for (const id of await db.listHandleIds()) if (!keep.has(id)) await db.deleteHandle(id);
  } catch { /* 下次再清 */ }
}

// ============================================================
// 編輯動作
// ============================================================
function splitSelected() {
  const { project, created } = splitAtPlayhead(store.project, player.time, store.selection);
  if (!created.length) { toast(_t('播放頭沒有落在可以分割的片段上')); return; }
  store.commit(project);
}

function deleteSelected(ripple = store.ripple) {
  if (!store.selection.length) return;
  const n = store.selection.length;
  const next = deleteClips(store.project, store.selection, { ripple });
  if (next === store.project) { toast(_t('鎖定的軌道不能刪除片段')); return; }
  store.commit(next, { select: [] });
  toast(ripple ? _t('已刪除 {n} 個片段並自動補位', { n }) : _t('已刪除 {n} 個片段', { n }), { action: { label: _t('復原'), run: () => store.undo() } });
}

function duplicateSelected() {
  const c = store.selectedClip;
  if (!c) return;
  const r = duplicateClip(store.project, c.id);
  store.commit(r.project, { select: [r.clip.id] });
}

function hasWork() {
  return store.project.clips.length > 0 || Object.keys(store.project.media).length > 0;
}

/** 清掉目前的專案（素材檔也從瀏覽器刪除） */
async function resetWorkspace() {
  player.destroy();
  runtime.releaseAll();
  try { await db.clearAll(); } catch { /* 忽略 */ }
}

async function newProject() {
  const ok = !hasWork() || await confirmDialog({
    title: _t('開新專案？'), message: _t('目前的專案和匯入的素材會從這台裝置上刪除，這個動作無法復原。請先確認需要的影片已經匯出。'), confirmText: _t('開新專案'), danger: true,
  });
  if (!ok) return;
  await resetWorkspace();
  store.replace(createProject());
  player.seek(0);
  timeline.setZoom(60, 0);
  toast(_t('已建立新專案'));
}

// ============================================================
// 專案檔
// ============================================================
let opening = false;
async function openProjectFile(file) {
  if (opening) return;
  opening = true;
  player.pause();
  const dismiss = toast(_t('正在讀取「{name}」…', { name: file.name }), { timeout: 0 });
  try {
    let data;
    try {
      data = await unpackProject(file);
    } catch (e) {
      toast(e.message || _t('無法開啟專案檔'), { type: 'error', timeout: 8000 });
      return; // 目前的專案不受影響
    } finally {
      dismiss();
    }
    if (hasWork() && !(await confirmDialog({
      title: _t('開啟專案檔？'),
      message: _t('「{name}」會取代目前的專案，目前的專案和素材會從這台裝置上刪除。需要保留的話，請先從「專案 → 下載專案檔」備份。', { name: data.project.name }),
      confirmText: _t('開啟'), danger: true,
    }))) return;

    await resetWorkspace();
    let notStored = 0, large = 0;
    for (const [id, f] of data.files) {
      await runtime.register(data.project.media[id], f);
      // 大檔案一樣不複製到瀏覽器（專案檔裡的檔案沒有檔案代號可以記）
      if (isLarge(f)) { large++; continue; }
      try { await db.saveFile(id, f); } catch { notStored++; }
    }
    store.replace(data.project);
    await saveNow();
    player.seek(0);
    requestAnimationFrame(() => timeline.fit());
    toast(_t('已開啟「{name}」', { name: data.project.name }), { type: 'success' });
    const lost = data.missing.length + data.corrupted.length;
    if (lost) {
      const msg = data.corrupted.length
        ? _t('有 {n} 個素材需要重新匯入（其中 {bad} 個在專案檔裡已損毀），匯入同名、同大小的原始檔就會自動接回', { n: lost, bad: data.corrupted.length })
        : data.includesMedia
          ? _t('有 {n} 個素材需要重新匯入，匯入同名、同大小的原始檔就會自動接回', { n: lost })
          : _t('有 {n} 個素材需要重新匯入（這個專案檔沒有包含素材），匯入同名、同大小的原始檔就會自動接回', { n: lost });
      toast(msg, { type: 'error', timeout: 10000 });
    }
    if (notStored) toast(_t('有 {n} 個素材無法存到瀏覽器（空間可能不足）；重新整理後需要再開啟一次這個專案檔', { n: notStored }), { type: 'error', timeout: 8000 });
    if (large) toast(_t('有 {n} 個大型素材沒有複製到瀏覽器，不會多佔硬碟空間；重新整理後需要再開啟一次這個專案檔', { n: large }), { timeout: 10000 });
  } finally {
    opening = false;
  }
}

function saveProjectFile() {
  player.pause();
  openSaveProjectDialog({ project: store.project, runtime });
}

async function loadSample() {
  const t = toast(_t('正在產生範例素材…'), { timeout: 0 });
  try {
    if (store.project.clips.length) {
      t();
      if (!(await confirmDialog({ title: _t('載入範例專案？'), message: _t('範例會加到目前的專案裡（不會刪掉你的東西）。'), confirmText: _t('加入範例') }))) return;
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
    p = addClip(p, 'text', { trackId: v2.id, start: base + 0.4, duration: 3.2, fadeIn: 0.5, fadeOut: 0.5, text: { content: 'OnlineCut', fontSize: 170, fontWeight: 900 }, name: _t('標題') }).project;
    p = addClip(p, 'text', { trackId: v2.id, start: base + 4.4, duration: 3.2, fadeIn: 0.3, fadeOut: 0.3, text: { content: _t('免費、免安裝、不上傳'), fontSize: 64, fontWeight: 700, background: 'rgba(0, 0, 0, 0.55)' }, transform: { y: 380 }, name: _t('字幕') }).project;
    p = addClip(p, 'text', { trackId: v2.id, start: base + 8.4, duration: 3.2, fadeIn: 0.4, fadeOut: 0.8, text: { content: _t('開始剪你的故事'), fontSize: 110, fontWeight: 900, color: '#ffd23f', strokeColor: '#1b1440', strokeWidth: 6, shadow: false }, name: _t('結尾') }).project;
    if (p.name === _t('未命名專案')) p = renameProject(p, _t('我的第一支影片'));
    store.commit(p);
    player.seek(base + 1.2);
    requestAnimationFrame(() => timeline.fit());
    t();
    toast(_t('範例專案已載入，按空白鍵播放看看'), { type: 'success' });
  } catch (e) {
    t();
    console.error(e);
    toast(_t('無法產生範例：{reason}', { reason: e.message }), { type: 'error' });
  }
}

// ============================================================
// 按鈕
// ============================================================
$('btnPlay').onclick = () => player.toggle();
$('btnStart').onclick = () => seekAndReveal(0);
$('btnEnd').onclick = () => seekAndReveal(getDuration(store.project));
$('btnPrev').onclick = () => stepFrames(-1);
$('btnNext').onclick = () => stepFrames(1);
$('btnUndo').onclick = () => store.undo();
$('btnRedo').onclick = () => store.redo();
$('btnSplit').onclick = splitSelected;
$('btnDelete').onclick = (e) => deleteSelected(e.shiftKey || store.ripple);
$('btnDuplicate').onclick = duplicateSelected;
$('btnExport').onclick = () => openExportDialog({ project: store.project, runtime, player });
$('btnNew').onclick = () => { closeMenu(); newProject(); };
$('btnOpenProject').onclick = () => { closeMenu(); $('projectInput').click(); };
$('btnSaveProject').onclick = () => { closeMenu(); saveProjectFile(); };
$('projectInput').addEventListener('change', () => {
  const f = $('projectInput').files[0];
  $('projectInput').value = '';
  if (f) openProjectFile(f);
});

// 專案選單（點外面、Esc 關閉；上下鍵移動）
const menuBtn = $('btnProjectMenu'), menu = $('projectMenu');
const menuItems = () => [...menu.querySelectorAll('[role="menuitem"]')];
function openMenu() {
  menu.hidden = false;
  menuBtn.setAttribute('aria-expanded', 'true');
  menuItems()[0].focus();
}
function closeMenu(focusButton = false) {
  if (menu.hidden) return;
  menu.hidden = true;
  menuBtn.setAttribute('aria-expanded', 'false');
  if (focusButton) menuBtn.focus();
}
menuBtn.onclick = () => (menu.hidden ? openMenu() : closeMenu());
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu-wrap')) closeMenu(); });
menu.addEventListener('keydown', (e) => {
  const items = menuItems(), i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  if (e.key === 'Tab') closeMenu();
});
if (/Mac|iPhone|iPad/.test(navigator.platform)) menu.querySelectorAll('kbd').forEach(k => { k.textContent = k.textContent.replace('Ctrl ', '⌘'); });
$('btnShortcuts').onclick = showShortcuts;
$('btnSample').onclick = loadSample;
$('welcomeSample').onclick = loadSample;
$('welcomeImport').onclick = () => pickMediaFiles();
$('btnAddVideoTrack').onclick = () => store.commit(addTrack(store.project, 'video'));
$('btnAddAudioTrack').onclick = () => store.commit(addTrack(store.project, 'audio'));
$('btnFullscreen').onclick = () => $('frame').requestFullscreen?.().catch(() => toast(_t('瀏覽器不允許全螢幕')));

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

/** 用鍵盤或按鈕移動播放頭：時間軸跟著捲到看得到的地方 */
function seekAndReveal(t) {
  player.seek(t);
  timeline.reveal(player.time);
}

function stepFrames(n) {
  player.pause();
  const fps = store.project.fps;
  seekAndReveal(Math.round(player.time * fps + n) / fps);
}

// ============================================================
// 快捷鍵
// ============================================================
const SHORTCUTS = [
  [_t('播放'), [
    [_t('播放 / 暫停'), [_t('空白鍵')]],
    [_t('上一格 / 下一格'), ['←', '→']],
    [_t('往前 / 往後 1 秒'), ['Shift', '← →']],
    [_t('跳到開頭 / 結尾'), ['Home', 'End']],
  ]],
  [_t('剪輯'), [
    [_t('在播放頭分割'), ['S']],
    [_t('刪除'), ['Delete']],
    [_t('刪除並補位（波紋刪除）'), ['Shift', 'Delete']],
    [_t('複製片段'), ['Ctrl', 'D']],
    [_t('全選'), ['Ctrl', 'A']],
    [_t('取消選取'), ['Esc']],
    [_t('復原 / 重做'), ['Ctrl', 'Z', '/', 'Ctrl', 'Shift', 'Z']],
  ]],
  [_t('時間軸'), [
    [_t('放大 / 縮小'), ['Ctrl', '+', '/', '-']],
    [_t('符合視窗'), ['Shift', 'Z']],
    [_t('左右捲動 / 縮放'), [_t('滾輪'), '/', 'Ctrl', _t('滾輪')]],
    [_t('開關吸附'), ['N']],
    [_t('暫時不吸附（拖曳時）'), [_t('按住 Alt')]],
  ]],
  [_t('其他'), [
    [_t('匯出影片'), ['Ctrl', 'E']],
    [_t('開啟專案檔'), ['Ctrl', 'O']],
    [_t('下載專案檔'), ['Ctrl', 'S']],
    [_t('顯示快捷鍵'), ['?']],
  ]],
];

function showShortcuts() {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const html = `<dl class="shortcut-list">${SHORTCUTS.map(([g, items]) => `<div class="shortcut-group">${g}</div>${items.map(([label, keys]) =>
    `<dt>${label}</dt><dd>${keys.map(k => (k === '/' ? '<span style="color:var(--text-3)">/</span>' : `<kbd>${isMac && k === 'Ctrl' ? '⌘' : k}</kbd>`)).join('')}</dd>`).join('')}`).join('')}</dl>`;
  openModal({ title: _t('鍵盤快捷鍵'), content: html });
}

function isTyping(e) {
  const t = e.target;
  return t.closest?.('input, textarea, select, [contenteditable="true"]') && !(t.type === 'range' || t.type === 'checkbox');
}

document.addEventListener('keydown', (e) => {
  if (isModalOpen()) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  // 開啟 / 下載專案檔在輸入框裡也要能用，不然會跳出瀏覽器的「另存網頁」
  if (mod && !e.shiftKey && !e.altKey && (k === 'o' || k === 'O' || k === 's' || k === 'S')) {
    e.preventDefault();
    closeMenu();
    if (k === 'o' || k === 'O') $('projectInput').click(); else saveProjectFile();
    return;
  }
  if (isTyping(e)) return;
  if (!menu.hidden) return; // 選單開著時交給選單處理
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
    seekAndReveal(e.shiftKey ? player.time + dir : Math.round(player.time * fps + dir) / fps);
    return;
  }
  if (k === 'Home') { handled(); seekAndReveal(0); return; }
  if (k === 'End') { handled(); seekAndReveal(getDuration(store.project)); return; }
  if (k === 's' || k === 'S') { handled(); splitSelected(); return; }
  if (k === 'Delete' || k === 'Backspace') { handled(); deleteSelected(e.shiftKey || store.ripple); return; }
  if (k === 'Escape') { store.select([]); return; }
  if (k === 'n' || k === 'N') { store.setView({ snap: !store.snap }); paintSnap(); toast(store.snap ? _t('吸附：開') : _t('吸附：關')); return; }
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
  // 檔案代號只能在 drop 事件當下取得（Chrome / Edge）；拿到的話大檔案就不用複製
  const files = [...e.dataTransfer.files];
  const items = [...(e.dataTransfer.items || [])].filter(i => i.kind === 'file');
  const pending = items.map(i => (typeof i.getAsFileSystemHandle === 'function' ? i.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null)));
  Promise.all(pending).then((handles) => {
    const fileHandles = handles.filter(h => h && h.kind === 'file');
    importEntries(files.map(file => ({ file, handle: fileHandles.find(h => h.name === file.name) ?? null })));
  });
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
window.addEventListener('beforeunload', (e) => {
  if (saveTimer) saveNow();
  // 匯出或打包中：讓瀏覽器問使用者是否確定要離開
  if (busy.count > 0) { e.preventDefault(); e.returnValue = ''; }
});

// 同一個瀏覽器開了兩個編輯器分頁：兩邊都會自動存到同一個地方，會互相覆蓋
(function watchOtherTabs() {
  if (typeof BroadcastChannel === 'undefined') return;
  const me = Math.random().toString(36).slice(2);
  const ch = new BroadcastChannel('onlinecut-editor');
  let warned = false;
  const warn = () => {
    if (warned) return;
    warned = true;
    toast(_t('OnlineCut 已經在另一個分頁開啟。兩邊都會自動儲存到同一個地方，同時編輯會互相覆蓋，建議只留一個分頁。'), { type: 'error', timeout: 15000 });
  };
  ch.onmessage = (e) => {
    if (!e.data || e.data.from === me) return;
    if (e.data.type === 'hello') ch.postMessage({ type: 'here', from: me });
    warn();
  };
  ch.postMessage({ type: 'hello', from: me });
})();
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
