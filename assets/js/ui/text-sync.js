// 同一條軌上的文字一起改樣式（例如 AI 字幕）：改其中一段的字型、顏色、位置…，整軌都跟著變。
// 內容、數字動畫、時間不會被同步。

import { getClip, getTrack, updateClip } from '../core/project.js';
import { _t } from '../i18n.js';

const state = { on: new Set(), off: new Set() }; // 使用者手動打開 / 關掉的軌道

/** 同一條軌上的其他文字片段 */
export function textSiblings(project, clip) {
  if (clip?.type !== 'text') return [];
  return project.clips.filter(c => c.type === 'text' && c.trackId === clip.trackId && c.id !== clip.id);
}

/** 這條軌的文字是不是一起改：「字幕」軌預設打開，其他軌預設關掉 */
export function isTrackSynced(project, clip) {
  if (!textSiblings(project, clip).length) return false;
  const id = clip.trackId;
  if (state.on.has(id)) return true;
  if (state.off.has(id)) return false;
  return getTrack(project, id)?.name === _t('字幕');
}

export function setTrackSynced(trackId, on) {
  state.on.delete(trackId);
  state.off.delete(trackId);
  (on ? state.on : state.off).add(trackId);
}

/** 只留下可以同步的樣式欄位 */
export function stylePart(patch) {
  const out = {};
  if (patch.text) {
    const { content, counter, ...rest } = patch.text;
    if (Object.keys(rest).length) out.text = rest;
  }
  for (const k of ['transform', 'opacity', 'fadeIn', 'fadeOut']) if (k in patch) out[k] = patch[k];
  return out;
}

/** 改一段文字；整軌同步時把樣式也套到同一軌的其他文字 */
export function updateTextSynced(project, id, patch) {
  let next = updateClip(project, id, patch);
  const clip = getClip(project, id);
  if (!isTrackSynced(project, clip)) return next;
  const style = stylePart(patch);
  if (!Object.keys(style).length) return next;
  for (const c of textSiblings(project, clip)) next = updateClip(next, c.id, style);
  return next;
}

/** 把這段目前的樣式（字型、顏色、背景、外框、位置…）一次套到同一軌的全部文字 */
export function copyStyleToTrack(project, id) {
  const clip = getClip(project, id);
  const { content, counter, ...text } = clip.text;
  const style = { text, transform: { ...clip.transform }, opacity: clip.opacity };
  let next = project;
  for (const c of textSiblings(project, clip)) next = updateClip(next, c.id, style);
  return next;
}
