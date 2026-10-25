// 轉場：同一條軌上兩段緊接著的畫面（影片或圖片），在接點前後做溶解、擦除、推移等效果。
// 轉場記在後面那段（transitionIn），以接點為中心：前一段會多播放 d/2 秒、後一段提早 d/2 秒出現。
// 素材在那段時間沒有畫面時（例如影片已經播完）就停在第一格 / 最後一格。

import { clipEnd, getTrack, canTransition, sourceTime, mediaLimit } from './project.js';
import { clamp } from './time.js';

export { TRANSITION_TYPES, DEFAULT_TRANSITION, MIN_TRANSITION, MAX_TRANSITION, canTransition, cleanTransition } from './project.js';

/** 同一軌上緊接在 clip 前面的那段畫面（接點誤差 1ms 內） */
export function prevAdjacent(project, clip) {
  if (!canTransition(clip)) return null;
  return project.clips.find(c => c !== clip && c.id !== clip.id && c.trackId === clip.trackId && canTransition(c)
    && Math.abs(clipEnd(c) - clip.start) < 1e-3) ?? null;
}

export function nextAdjacent(project, clip) {
  if (!canTransition(clip)) return null;
  return project.clips.find(c => c.id !== clip.id && c.trackId === clip.trackId && canTransition(c)
    && Math.abs(c.start - clipEnd(clip)) < 1e-3) ?? null;
}

/**
 * 實際生效的轉場：前面要緊接著另一段畫面；長度不能超過兩段任何一段的長度。
 * 回傳 { type, duration, from: 前一段, start, end } 或 null
 */
export function effectiveTransition(project, clip) {
  const tr = clip?.transitionIn;
  if (!tr || !canTransition(clip)) return null;
  const from = prevAdjacent(project, clip);
  if (!from) return null;
  const duration = Math.min(tr.duration, clip.duration, from.duration);
  if (!(duration > 0)) return null;
  return { type: tr.type, duration, from, start: clip.start - duration / 2, end: clip.start + duration / 2 };
}

/** 片段在畫面上出現的時間範圍（包含轉場多出來的部分） */
export function visualRange(project, clip) {
  let a = clip.start, b = clipEnd(clip);
  const inT = effectiveTransition(project, clip);
  if (inT) a = inT.start;
  const next = nextAdjacent(project, clip);
  const outT = next && effectiveTransition(project, next);
  if (outT) b = outT.end;
  return [a, b];
}

/**
 * 時間 t 畫面上看得到的片段（含轉場時的前後兩段），依軌道由下往上排。
 * 只用在畫面；聲音還是照片段本身的範圍。
 */
export function visualClipsAt(project, t, { includeHidden = false } = {}) {
  const order = new Map(project.tracks.map((tr, i) => [tr.id, project.tracks.length - i]));
  return project.clips
    .filter(c => {
      const tr = getTrack(project, c.trackId);
      if (!tr || (!includeHidden && tr.hidden)) return false;
      if (t >= c.start && t < clipEnd(c)) return true;
      if (!canTransition(c)) return false;
      const [a, b] = visualRange(project, c);
      return t >= a && t < b;
    })
    // 同一軌：前一段先畫（在下面），後一段再畫
    .sort((a, b) => order.get(a.trackId) - order.get(b.trackId) || a.start - b.start);
}

/** 轉場進行到哪裡（0 → 1）；t 不在轉場裡回傳 null */
export function transitionProgress(tr, t) {
  if (!tr || t < tr.start || t >= tr.end) return null;
  return (t - tr.start) / tr.duration;
}

/** 畫面用的時間：轉場多出來的部分停在片段的第一格 / 最後一格（淡入淡出也照這個時間算） */
export function visualTime(clip, t) {
  return clamp(t, clip.start, clipEnd(clip) - 1e-4);
}

/** 畫面用的素材時間：前後還有素材就照常播放，沒有就停在第一格 / 最後一格 */
export function visualSourceTime(project, clip, t) {
  if (t >= clip.start && t < clipEnd(clip)) return sourceTime(clip, t);
  const limit = mediaLimit(project, clip);
  const max = isFinite(limit) ? Math.max(0, limit - 1 / (project.fps || 30) / 2) : Infinity;
  return clamp(sourceTime(clip, t), 0, max);
}
