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
export function produce(project, fn) {
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

// ============================================================
// 畫面框（子母畫面、分割畫面）
// ============================================================
// frame 以畫面的比例表示位置與大小（0–1），影像會裁切填滿框；
// 這時 transform.scale 是取景的縮放、transform.x / y 是取景的平移（專案像素）。
export const FRAME_SHAPES = ['rect', 'round', 'circle'];
export const MIN_FRAME = 0.02;
export const canFrame = (c) => c?.type === 'video' || c?.type === 'image';

export function defaultFrame() {
  return { x: 0, y: 0, w: 1, h: 1, shape: 'rect', border: 0, borderColor: '#ffffff', shadow: false };
}

/** 檢查畫面框的每個欄位；不是物件就回傳 null（沒有畫面框） */
export function cleanFrame(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
  const d = defaultFrame();
  const n = (v, def) => (typeof v === 'number' && isFinite(v) ? v : def);
  return {
    x: clamp(n(f.x, d.x), -1, 2),
    y: clamp(n(f.y, d.y), -1, 2),
    w: clamp(n(f.w, d.w), MIN_FRAME, 2),
    h: clamp(n(f.h, d.h), MIN_FRAME, 2),
    shape: FRAME_SHAPES.includes(f.shape) ? f.shape : d.shape,
    border: clamp(n(f.border, d.border), 0, 60),
    borderColor: typeof f.borderColor === 'string' && /^#[0-9a-f]{6}$/i.test(f.borderColor) ? f.borderColor : d.borderColor,
    shadow: f.shadow === true,
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
    frame: null,
  };
  if (type === 'text') clip.text = defaultText();
  const { transform, filters, text, frame, ...rest } = fields;
  Object.assign(clip, rest);
  if (frame && canFrame(clip)) clip.frame = cleanFrame(frame);
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
      // 入點不能超過素材結尾（至少留一格）
      if (m && isFinite(m.duration)) clip.srcIn = clamp(clip.srcIn, 0, Math.max(0, m.duration - 1 / p.fps));
      const maxSpan = (m?.duration ?? clip.duration * clip.speed) - clip.srcIn;
      if (fields.duration == null) clip.duration = maxSpan / clip.speed;
      clip.duration = Math.max(1 / p.fps, Math.min(clip.duration, maxSpan / clip.speed));
    }
    // 任何片段都至少一格；長度不是數字時用預設值
    if (!isFinite(clip.duration)) clip.duration = type === 'text' ? DEFAULT_TEXT_DURATION : DEFAULT_IMAGE_DURATION;
    clip.duration = Math.max(1 / p.fps, clip.duration);
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
  // 兩邊都至少要有一格
  if (!clip || t < clip.start + minDur - 1e-9 || t > clipEnd(clip) - minDur + 1e-9) return { project, rightId: null };
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
    const { transform, filters, text, speed, frame, ...rest } = patch;
    for (const [k, v] of Object.entries(rest)) {
      if (['id', 'type', 'mediaId', 'trackId', 'start', 'duration', 'srcIn'].includes(k)) continue;
      c[k] = v;
    }
    // frame: null 取消畫面框；物件則跟目前的框合併
    if (frame === null) c.frame = null;
    else if (frame && canFrame(c)) c.frame = cleanFrame({ ...(c.frame ?? defaultFrame()), ...frame });
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
      const nextStart = clipsOnTrack(p, c.trackId, [c.id]).filter(n => n.start >= c.start).reduce((m, n) => Math.min(m, n.start), Infinity);
      const duration = Math.min(sourceSpan(c) / s, nextStart - c.start);
      // 變速後短到不到一格就不套用（例如只有一格的片段再加速）
      if (duration >= 1 / p.fps - 1e-9) {
        c.speed = s;
        c.duration = duration;
      }
    }
    c.fadeIn = clamp(Number(c.fadeIn) || 0, 0, c.duration);
    c.fadeOut = clamp(Number(c.fadeOut) || 0, 0, c.duration);
  });
}

// ============================================================
// 軌道
// ============================================================
/** 新增軌道。影像軌預設加在最上面；position: 'bottom' 加在影像軌的最下面（例如放背景） */
export function addTrack(project, kind, { position = 'top' } = {}) {
  return produce(project, p => {
    const t = makeTrack(kind, nextTrackName(p, kind));
    if (kind !== 'video') p.tracks.push(t);
    else if (position === 'bottom') p.tracks.splice(p.tracks.map(x => x.kind).lastIndexOf('video') + 1, 0, t);
    else p.tracks.unshift(t);
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
// 存檔或專案檔可能來自舊版本、被手動修改，甚至是惡意檔案，所以每個欄位都要檢查：
// 不認識的欄位丟掉、數值夾在合理範圍、解析度依畫面比例重算、重疊的片段往後挪。
// 正常的專案經過這裡必須完全不變。

const ALLOWED_FPS = [24, 25, 30, 50, 60];
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const str = (v, d, max) => (typeof v === 'string' ? v.slice(0, max) : d);
const MEDIA_TYPES = ['video', 'audio', 'image'];

// __proto__ 之類的名稱當成物件的鍵會改到原型，一律拒絕
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const isSafeId = (id) => typeof id === 'string' && SAFE_ID.test(id) && !RESERVED.has(id);

function sanitizeMedia(id, m) {
  if (!isSafeId(id) || !m || typeof m !== 'object' || m.id !== id || !MEDIA_TYPES.includes(m.type)) return null;
  const out = { id, type: m.type, name: str(m.name, '素材', 255) };
  if (m.size !== undefined) out.size = Math.max(0, num(m.size, 0));
  if (m.mime !== undefined) out.mime = str(m.mime, '', 100);
  if (m.addedAt !== undefined) out.addedAt = num(m.addedAt, 0);
  if (m.duration !== undefined) out.duration = m.duration === null ? null : Math.max(0, num(m.duration, 0)) || null;
  if (m.width !== undefined) out.width = clamp(num(m.width, 1), 1, 16384);
  if (m.height !== undefined) out.height = clamp(num(m.height, 1), 1, 16384);
  return out;
}

const CLIP_FIELDS = ['name', 'mediaId', 'trackId', 'start', 'duration', 'srcIn', 'speed', 'volume', 'muted', 'fadeIn', 'fadeOut', 'opacity'];
const TEXT_FIELDS = { content: 5000, fontFamily: 60, color: 40, background: 40, strokeColor: 40 };

function sanitizeClip(c) {
  const fields = {};
  for (const k of CLIP_FIELDS) if (c[k] !== undefined) fields[k] = c[k];
  const m = makeClip(c.type, fields);
  m.id = c.id;
  m.name = str(m.name, '', 255);
  m.mediaId = c.type === 'text' ? null : str(m.mediaId, null, 100);
  m.trackId = str(m.trackId, null, 100);
  m.start = Math.max(0, num(m.start, 0));
  m.duration = num(m.duration, 0);
  m.srcIn = Math.max(0, num(m.srcIn, 0));
  m.speed = c.type === 'video' || c.type === 'audio' ? clamp(num(m.speed, 1), MIN_SPEED, MAX_SPEED) : 1;
  m.volume = clamp(num(m.volume, 1), 0, 2);
  m.opacity = clamp(num(m.opacity, 1), 0, 1);
  m.muted = m.muted === true;
  const t = c.transform && typeof c.transform === 'object' ? c.transform : {};
  m.transform = {
    x: clamp(num(t.x, 0), -1e5, 1e5),
    y: clamp(num(t.y, 0), -1e5, 1e5),
    scale: clamp(num(t.scale, 1), 0.01, 10),
    rotation: clamp(num(t.rotation, 0), -360, 360),
  };
  m.frame = canFrame(m) ? cleanFrame(c.frame) : null;
  const f = c.filters && typeof c.filters === 'object' ? c.filters : {};
  m.filters = {
    brightness: clamp(num(f.brightness, 100), 0, 200),
    contrast: clamp(num(f.contrast, 100), 0, 200),
    saturation: clamp(num(f.saturation, 100), 0, 200),
    blur: clamp(num(f.blur, 0), 0, 50),
    grayscale: clamp(num(f.grayscale, 0), 0, 100),
  };
  if (c.type === 'text') {
    const src = c.text && typeof c.text === 'object' ? c.text : {};
    const d = defaultText();
    m.text = { ...d };
    for (const [k, max] of Object.entries(TEXT_FIELDS)) m.text[k] = str(src[k], d[k], max);
    m.text.fontSize = clamp(num(src.fontSize, d.fontSize), 8, 600);
    m.text.fontWeight = [100, 200, 300, 400, 500, 600, 700, 800, 900].includes(src.fontWeight) ? src.fontWeight : d.fontWeight;
    m.text.strokeWidth = clamp(num(src.strokeWidth, d.strokeWidth), 0, 100);
    m.text.align = ['left', 'center', 'right'].includes(src.align) ? src.align : d.align;
    m.text.italic = src.italic === true;
    m.text.shadow = src.shadow === undefined ? d.shadow : src.shadow === true;
  }
  return m;
}

/** 檢查並修復讀進來的專案；格式不對回傳 null */
export function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tracks) || !Array.isArray(raw.clips)) return null;
  const aspect = ASPECT_PRESETS[raw.aspect] ? raw.aspect : '16:9';
  const base = createProject({ aspect });
  const p = {
    version: PROJECT_VERSION,
    id: str(raw.id, base.id, 100) || base.id,
    name: str(raw.name, base.name, 120) || base.name,
    aspect,
    width: base.width,      // 解析度一律依畫面比例，不信任檔案裡的數字
    height: base.height,
    fps: ALLOWED_FPS.includes(raw.fps) ? raw.fps : DEFAULT_FPS,
    background: /^#[0-9a-f]{6}$/i.test(raw.background) ? raw.background : '#000000',
    tracks: [],
    clips: [],
    media: {},
  };

  if (raw.media && typeof raw.media === 'object') {
    for (const [id, m] of Object.entries(raw.media)) {
      const clean = sanitizeMedia(id, m);
      if (clean) p.media[id] = clean;
    }
  }

  const trackIds = new Set();
  for (const t of raw.tracks) {
    if (!t || typeof t !== 'object' || (t.kind !== 'video' && t.kind !== 'audio')) continue;
    const id = t.id;
    if (!isSafeId(id) || trackIds.has(id)) continue;
    trackIds.add(id);
    p.tracks.push({
      id, kind: t.kind, name: str(t.name, t.kind === 'video' ? 'V' : 'A', 20) || (t.kind === 'video' ? 'V' : 'A'),
      muted: t.muted === true, hidden: t.hidden === true, locked: t.locked === true,
    });
  }
  if (!p.tracks.some(t => t.kind === 'video')) p.tracks.unshift(makeTrack('video', 'V1'));
  if (!p.tracks.some(t => t.kind === 'audio')) p.tracks.push(makeTrack('audio', 'A1'));

  const minDur = 1 / p.fps;
  const clipIds = new Set();
  for (const c of raw.clips) {
    if (!c || typeof c !== 'object' || !isSafeId(c.id) || !TRACK_KIND_FOR_TYPE[c.type] || clipIds.has(c.id)) continue;
    const m = sanitizeClip(c);
    if (!canHost(getTrack(p, m.trackId), m.type)) continue;
    if (m.type !== 'text' && !p.media[m.mediaId]) continue;
    if (p.media[m.mediaId] && p.media[m.mediaId].type !== m.type) continue; // 片段型別要跟素材一致
    // 不能超過素材本身的長度
    const limit = mediaLimit(p, m);
    // 只在超出容許誤差時才修正，避免浮點誤差讓正常的專案每次讀取都被改動
    if (isFinite(limit)) {
      if (m.srcIn > limit - minDur + 1e-6) m.srcIn = Math.max(0, limit - minDur);
      if (m.srcIn + m.duration * m.speed > limit + 1e-6) m.duration = (limit - m.srcIn) / m.speed;
    }
    if (!(m.duration > 0)) continue;
    m.fadeIn = clamp(num(m.fadeIn, 0), 0, m.duration);
    m.fadeOut = clamp(num(m.fadeOut, 0), 0, m.duration);
    clipIds.add(m.id);
    p.clips.push(m);
  }

  // 同一軌上重疊的片段往後挪
  for (const t of p.tracks) {
    let end = 0;
    for (const c of p.clips.filter(c => c.trackId === t.id).sort((a, b) => a.start - b.start)) {
      if (c.start < end - 1e-6) c.start = end;
      end = clipEnd(c);
    }
  }
  return p;
}
