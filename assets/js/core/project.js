// 專案資料模型與時間軸操作（純函式，不碰 DOM，可在 Node 測試）
//
// 每個操作都回傳新的 project，不修改傳入的物件，方便 undo/redo。
// 時間單位：秒。tracks 依畫面由上到下排列；越上面的影像軌疊在越上層。

import { clamp, DEFAULT_FPS } from './time.js';

export const PROJECT_VERSION = 1;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;
export const DEFAULT_IMAGE_DURATION = 5;
export const DEFAULT_TEXT_DURATION = 4;

export const ASPECT_PRESETS = {
  '16:9': { width: 1920, height: 1080, label: '橫式 16:9', hint: 'YouTube' },
  '9:16': { width: 1080, height: 1920, label: '直式 9:16', hint: 'Reels / Shorts / TikTok' },
  '1:1': { width: 1080, height: 1080, label: '方形 1:1', hint: 'Instagram 貼文' },
  '4:5': { width: 1080, height: 1350, label: '直式 4:5', hint: 'Instagram 動態' },
};

export const TRACK_KIND_FOR_TYPE = { video: 'video', image: 'video', text: 'video', audio: 'audio' };

let idCounter = 0;
export function uid(prefix = 'id') {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

/** 複製 project 後交給 fn 修改，回傳新的 project */
function produce(project, fn) {
  const next = clone(project);
  fn(next);
  return next;
}

// ============================================================
// 建立
// ============================================================
export function createProject({ name = '未命名專案', aspect = '16:9', fps = DEFAULT_FPS } = {}) {
  const preset = ASPECT_PRESETS[aspect] ?? ASPECT_PRESETS['16:9'];
  return {
    version: PROJECT_VERSION,
    id: uid('prj'),
    name,
    aspect: ASPECT_PRESETS[aspect] ? aspect : '16:9',
    width: preset.width,
    height: preset.height,
    fps,
    background: '#000000',
    tracks: [
      makeTrack('video', 'V2'),
      makeTrack('video', 'V1'),
      makeTrack('audio', 'A1'),
    ],
    clips: [],
    media: {},
  };
}

export function makeTrack(kind, name) {
  return { id: uid('trk'), kind, name, muted: false, hidden: false, locked: false };
}

export function defaultText() {
  return {
    content: '輸入標題文字',
    fontFamily: 'Noto Sans TC',
    fontSize: 96,
    fontWeight: 700,
    italic: false,
    color: '#ffffff',
    background: '',
    strokeColor: '#000000',
    strokeWidth: 0,
    align: 'center',
    shadow: true,
  };
}

export function makeClip(type, fields = {}) {
  const clip = {
    id: uid('clp'),
    type,
    name: fields.name ?? '',
    mediaId: fields.mediaId ?? null,
    trackId: fields.trackId ?? null,
    start: 0,
    duration: type === 'text' ? DEFAULT_TEXT_DURATION : DEFAULT_IMAGE_DURATION,
    srcIn: 0,
    speed: 1,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    opacity: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    filters: { brightness: 100, contrast: 100, saturation: 100, blur: 0, grayscale: 0 },
  };
  if (type === 'text') clip.text = defaultText();
  const { transform, filters, text, ...rest } = fields;
  Object.assign(clip, rest);
  if (transform) Object.assign(clip.transform, transform);
  if (filters) Object.assign(clip.filters, filters);
  if (text) Object.assign(clip.text, text);
  return clip;
}

// ============================================================
// 查詢
// ============================================================
export const clipEnd = (c) => c.start + c.duration;
export const sourceSpan = (c) => c.duration * c.speed;

export function getClip(project, id) {
  return project.clips.find(c => c.id === id) ?? null;
}

export function getTrack(project, id) {
  return project.tracks.find(t => t.id === id) ?? null;
}

export function getDuration(project) {
  return project.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

export function clipsOnTrack(project, trackId, excludeIds = []) {
  return project.clips
    .filter(c => c.trackId === trackId && !excludeIds.includes(c.id))
    .sort((a, b) => a.start - b.start);
}

export function canHost(track, clipType) {
  return !!track && TRACK_KIND_FOR_TYPE[clipType] === track.kind;
}

/** 片段可延伸的最長來源長度（秒，以來源時間計）；圖片 / 文字沒有上限 */
export function mediaLimit(project, clip) {
  if (clip.type === 'image' || clip.type === 'text') return Infinity;
  const m = project.media[clip.mediaId];
  return m && isFinite(m.duration) ? m.duration : Infinity;
}

/** 時間點 t 正在出現的片段，依繪製順序（最下層的軌道先畫）排列 */
export function activeClipsAt(project, t, { includeHidden = false } = {}) {
  const order = new Map(project.tracks.map((tr, i) => [tr.id, project.tracks.length - i]));
  return project.clips
    .filter(c => t >= c.start && t < clipEnd(c))
    .filter(c => {
      const tr = getTrack(project, c.trackId);
      return tr && (includeHidden || !tr.hidden);
    })
    .sort((a, b) => order.get(a.trackId) - order.get(b.trackId));
}

/** 時間軸時間 → 素材時間 */
export function sourceTime(clip, t) {
  return clip.srcIn + (t - clip.start) * clip.speed;
}

/** 淡入淡出的強度（0–1） */
export function fadeFactor(clip, t) {
  const local = t - clip.start;
  let f = 1;
  if (clip.fadeIn > 0) f = Math.min(f, local / clip.fadeIn);
  if (clip.fadeOut > 0) f = Math.min(f, (clip.duration - local) / clip.fadeOut);
  return clamp(f, 0, 1);
}

export function clipOpacityAt(clip, t) {
  return clamp(clip.opacity, 0, 1) * fadeFactor(clip, t);
}

export function clipGainAt(project, clip, t) {
  const track = getTrack(project, clip.trackId);
  if (clip.muted || !track || track.muted) return 0;
  return clamp(clip.volume, 0, 2) * fadeFactor(clip, t);
}

// ============================================================
// 位置與吸附
// ============================================================

/** 檢查 [start, start+dur) 在軌道上是否空著 */
export function isFree(project, trackId, start, dur, excludeIds = []) {
  const eps = 1e-6;
  return start >= -eps && clipsOnTrack(project, trackId, excludeIds)
    .every(c => start + dur <= c.start + eps || start >= clipEnd(c) - eps);
}

/** 找最接近 desired 且放得下的位置（一定找得到：最後一個片段之後永遠有空間） */
export function findFreeStart(project, trackId, desired, dur, excludeIds = []) {
  desired = Math.max(0, desired);
  if (isFree(project, trackId, desired, dur, excludeIds)) return desired;
  const others = clipsOnTrack(project, trackId, excludeIds);
  const candidates = [0];
  for (const c of others) {
    candidates.push(clipEnd(c));
    candidates.push(c.start - dur);
  }
  return candidates
    .filter(s => s >= 0 && isFree(project, trackId, s, dur, excludeIds))
    .sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired) || a - b)[0];
}

export function snapPoints(project, { excludeIds = [], playhead = null } = {}) {
  const pts = new Set([0]);
  if (playhead != null) pts.add(playhead);
  for (const c of project.clips) {
    if (excludeIds.includes(c.id)) continue;
    pts.add(c.start);
    pts.add(clipEnd(c));
  }
  return [...pts];
}

/** 吸附到最近的點；回傳 { time, snapped, point } */
export function snapTime(t, points, threshold) {
  let best = null;
  for (const p of points) {
    const d = Math.abs(p - t);
    if (d <= threshold && (best === null || d < Math.abs(best - t))) best = p;
  }
  return best === null ? { time: t, snapped: false, point: null } : { time: best, snapped: true, point: best };
}

/** 拖曳片段時，讓片段的開頭或結尾吸附 */
export function snapClipStart(start, duration, points, threshold) {
  const a = snapTime(start, points, threshold);
  const b = snapTime(start + duration, points, threshold);
  if (a.snapped && (!b.snapped || Math.abs(a.time - start) <= Math.abs(b.time - start - duration))) {
    return { start: a.time, point: a.point };
  }
  if (b.snapped) return { start: b.time - duration, point: b.point };
  return { start, point: null };
}

// ============================================================
// 編輯操作
// ============================================================

/** 新增素材資訊（不含檔案本身） */
export function addMedia(project, media) {
  return produce(project, p => { p.media[media.id] = { ...media }; });
}

/** 刪除素材，連同使用它的片段 */
export function removeMedia(project, mediaId) {
  return produce(project, p => {
    delete p.media[mediaId];
    p.clips = p.clips.filter(c => c.mediaId !== mediaId);
  });
}

/** 找一條能放這種片段的軌道；沒有就新增 */
function ensureTrackFor(p, type, preferredId) {
  const preferred = p.tracks.find(t => t.id === preferredId);
  if (preferred && canHost(preferred, type) && !preferred.locked) return preferred;
  const kind = TRACK_KIND_FOR_TYPE[type];
  const found = kind === 'video'
    ? [...p.tracks].reverse().find(t => t.kind === kind && !t.locked) // 影像預設放最下面的主軌
    : p.tracks.find(t => t.kind === kind && !t.locked);
  if (found) return found;
  const track = makeTrack(kind, nextTrackName(p, kind));
  if (kind === 'video') p.tracks.unshift(track); else p.tracks.push(track);
  return track;
}

function nextTrackName(p, kind) {
  const prefix = kind === 'video' ? 'V' : 'A';
  const nums = p.tracks.filter(t => t.kind === kind).map(t => parseInt(t.name.slice(1), 10) || 0);
  return prefix + (Math.max(0, ...nums) + 1);
}

/**
 * 新增片段。fields.start 未指定時接在該軌道最後面。
 * 回傳 { project, clip }
 */
export function addClip(project, type, fields = {}) {
  let clip;
  const next = produce(project, p => {
    const track = ensureTrackFor(p, type, fields.trackId);
    clip = makeClip(type, { ...fields, trackId: track.id });
    if (type === 'video' || type === 'audio') {
      const m = p.media[clip.mediaId];
      const maxSpan = (m?.duration ?? clip.duration * clip.speed) - clip.srcIn;
      if (fields.duration == null) clip.duration = maxSpan / clip.speed;
      clip.duration = Math.max(1 / p.fps, Math.min(clip.duration, maxSpan / clip.speed));
    }
    const desired = fields.start ?? clipsOnTrack(p, track.id).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
    clip.start = findFreeStart(p, track.id, desired, clip.duration);
    p.clips.push(clip);
  });
  return { project: next, clip: getClip(next, clip.id) };
}

/** 移動片段（可換軌）。會避開重疊；換到不相容的軌道則不動 */
export function moveClip(project, id, { start, trackId }) {
  const clip = getClip(project, id);
  if (!clip) return project;
  const target = getTrack(project, trackId ?? clip.trackId);
  if (!canHost(target, clip.type) || target.locked) return project;
  return produce(project, p => {
    const c = getClip(p, id);
    c.trackId = target.id;
    c.start = findFreeStart(p, target.id, start ?? c.start, c.duration, [id]);
  });
}

/**
 * 修剪片段左緣或右緣到時間軸上的 time。
 * 會受素材長度、相鄰片段與最短一格限制。
 */
export function trimClip(project, id, edge, time) {
  const clip = getClip(project, id);
  if (!clip) return project;
  const minDur = 1 / project.fps;
  const neighbors = clipsOnTrack(project, clip.trackId, [id]);
  const limit = mediaLimit(project, clip);
  return produce(project, p => {
    const c = getClip(p, id);
    const end = clipEnd(c);
    if (edge === 'start') {
      const prevEnd = neighbors.filter(n => clipEnd(n) <= c.start + 1e-6).reduce((m, n) => Math.max(m, clipEnd(n)), 0);
      // 左緣最多往左到「素材開頭」或前一個片段結尾
      const earliest = Math.max(prevEnd, c.start - c.srcIn / c.speed, 0);
      const newStart = clamp(time, earliest, end - minDur);
      c.srcIn = Math.max(0, c.srcIn + (newStart - c.start) * c.speed);
      c.duration = end - newStart;
      c.start = newStart;
    } else {
      const nextStart = neighbors.filter(n => n.start >= end - 1e-6).reduce((m, n) => Math.min(m, n.start), Infinity);
      const latest = Math.min(nextStart, c.start + (limit - c.srcIn) / c.speed);
      c.duration = clamp(time, c.start + minDur, latest) - c.start;
    }
    c.fadeIn = Math.min(c.fadeIn, c.duration);
    c.fadeOut = Math.min(c.fadeOut, c.duration);
  });
}

/** 在時間 t 分割片段；t 不在片段內（或太靠近邊緣）則不動。回傳 { project, rightId } */
export function splitClip(project, id, t) {
  const clip = getClip(project, id);
  const minDur = 1 / project.fps;
  if (!clip || t <= clip.start + minDur / 2 || t >= clipEnd(clip) - minDur / 2) return { project, rightId: null };
  const rightId = uid('clp');
  const next = produce(project, p => {
    const left = getClip(p, id);
    const right = clone(left);
    right.id = rightId;
    right.start = t;
    right.duration = clipEnd(left) - t;
    right.srcIn = left.srcIn + (t - left.start) * left.speed;
    right.fadeIn = 0;
    left.duration = t - left.start;
    left.fadeOut = 0;
    left.fadeIn = Math.min(left.fadeIn, left.duration);
    right.fadeOut = Math.min(right.fadeOut, right.duration);
    p.clips.push(right);
  });
  return { project: next, rightId };
}

/** 在播放頭分割：有選取就只分割選取的，否則分割所有經過播放頭、未鎖定的片段 */
export function splitAtPlayhead(project, t, selectedIds = []) {
  const targets = project.clips.filter(c =>
    (selectedIds.length ? selectedIds.includes(c.id) : true) &&
    t > c.start && t < clipEnd(c) && !getTrack(project, c.trackId)?.locked);
  let p = project;
  const created = [];
  for (const c of targets) {
    const r = splitClip(p, c.id, t);
    p = r.project;
    if (r.rightId) created.push(r.rightId);
  }
  return { project: p, created };
}

/** 刪除片段；ripple = true 時同軌道後面的片段往前補位 */
export function deleteClips(project, ids, { ripple = false } = {}) {
  const removed = project.clips.filter(c => ids.includes(c.id) && !getTrack(project, c.trackId)?.locked);
  if (!removed.length) return project;
  return produce(project, p => {
    p.clips = p.clips.filter(c => !removed.some(r => r.id === c.id));
    if (!ripple) return;
    // 由後往前處理，避免位移互相影響
    for (const r of [...removed].sort((a, b) => b.start - a.start)) {
      for (const c of p.clips) {
        if (c.trackId === r.trackId && c.start >= clipEnd(r) - 1e-6) c.start -= r.duration;
      }
    }
  });
}

/** 複製片段，放在原片段後面最近的空位 */
export function duplicateClip(project, id) {
  const clip = getClip(project, id);
  if (!clip) return { project, clip: null };
  const newId = uid('clp');
  const next = produce(project, p => {
    const copy = { ...clone(clip), id: newId };
    copy.start = findFreeStart(p, clip.trackId, clipEnd(clip), clip.duration);
    p.clips.push(copy);
  });
  return { project: next, clip: getClip(next, newId) };
}

/** 更新片段屬性（會檢查範圍） */
export function updateClip(project, id, patch) {
  if (!getClip(project, id)) return project;
  return produce(project, p => {
    const c = getClip(p, id);
    const { transform, filters, text, speed, ...rest } = patch;
    for (const [k, v] of Object.entries(rest)) {
      if (['id', 'type', 'mediaId', 'trackId', 'start', 'duration', 'srcIn'].includes(k)) continue;
      c[k] = v;
    }
    if (transform) Object.assign(c.transform, transform);
    if (filters) Object.assign(c.filters, filters);
    if (text && c.text) Object.assign(c.text, text);

    c.opacity = clamp(Number(c.opacity) || 0, 0, 1);
    c.volume = clamp(Number(c.volume) || 0, 0, 2);
    c.transform.scale = clamp(Number(c.transform.scale) || 0.01, 0.01, 10);
    c.transform.rotation = ((Number(c.transform.rotation) || 0) % 360 + 540) % 360 - 180;
    c.filters.brightness = clamp(c.filters.brightness, 0, 200);
    c.filters.contrast = clamp(c.filters.contrast, 0, 200);
    c.filters.saturation = clamp(c.filters.saturation, 0, 200);
    c.filters.blur = clamp(c.filters.blur, 0, 50);
    c.filters.grayscale = clamp(c.filters.grayscale, 0, 100);
    if (c.text) c.text.fontSize = clamp(Number(c.text.fontSize) || 12, 8, 600);

    if (speed != null && (c.type === 'video' || c.type === 'audio')) {
      // 變速：保留同一段素材，片段長度跟著變；若後面撞到其他片段則截短
      const s = clamp(Number(speed) || 1, MIN_SPEED, MAX_SPEED);
      const span = sourceSpan(c);
      c.speed = s;
      const nextStart = clipsOnTrack(p, c.trackId, [c.id]).filter(n => n.start >= c.start).reduce((m, n) => Math.min(m, n.start), Infinity);
      c.duration = Math.min(span / s, nextStart - c.start);
    }
    c.fadeIn = clamp(Number(c.fadeIn) || 0, 0, c.duration);
    c.fadeOut = clamp(Number(c.fadeOut) || 0, 0, c.duration);
  });
}

// ============================================================
// 軌道
// ============================================================
export function addTrack(project, kind) {
  return produce(project, p => {
    const t = makeTrack(kind, nextTrackName(p, kind));
    if (kind === 'video') p.tracks.unshift(t); else p.tracks.push(t);
  });
}

export function removeTrack(project, trackId) {
  const track = getTrack(project, trackId);
  if (!track || project.tracks.filter(t => t.kind === track.kind).length <= 1) return project;
  return produce(project, p => {
    p.tracks = p.tracks.filter(t => t.id !== trackId);
    p.clips = p.clips.filter(c => c.trackId !== trackId);
  });
}

export function updateTrack(project, trackId, patch) {
  if (!getTrack(project, trackId)) return project;
  return produce(project, p => {
    const t = getTrack(p, trackId);
    for (const k of ['muted', 'hidden', 'locked', 'name']) if (k in patch) t[k] = patch[k];
  });
}

export function setAspect(project, aspect) {
  const preset = ASPECT_PRESETS[aspect];
  if (!preset) return project;
  return produce(project, p => {
    p.aspect = aspect;
    p.width = preset.width;
    p.height = preset.height;
  });
}

export function renameProject(project, name) {
  return produce(project, p => { p.name = String(name).slice(0, 120) || '未命名專案'; });
}

// ============================================================
// 讀取存檔
// ============================================================

/** 檢查並修復讀進來的專案；格式不對回傳 null */
export function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tracks) || !Array.isArray(raw.clips)) return null;
  const base = createProject({ aspect: ASPECT_PRESETS[raw.aspect] ? raw.aspect : '16:9' });
  const p = { ...base, ...raw, media: { ...(raw.media || {}) } };
  p.tracks = raw.tracks.filter(t => t && t.id && (t.kind === 'video' || t.kind === 'audio'))
    .map(t => ({ muted: false, hidden: false, locked: false, name: t.kind === 'video' ? 'V' : 'A', ...t }));
  if (!p.tracks.some(t => t.kind === 'video')) p.tracks.unshift(makeTrack('video', 'V1'));
  if (!p.tracks.some(t => t.kind === 'audio')) p.tracks.push(makeTrack('audio', 'A1'));
  p.clips = raw.clips
    .filter(c => c && c.id && TRACK_KIND_FOR_TYPE[c.type])
    .map(c => {
      const m = makeClip(c.type, c);
      m.id = c.id;
      return m;
    })
    .filter(c => canHost(getTrack(p, c.trackId), c.type))
    .filter(c => c.type === 'text' || !!p.media[c.mediaId])
    .filter(c => isFinite(c.start) && isFinite(c.duration) && c.duration > 0 && c.start >= 0);
  return p;
}
