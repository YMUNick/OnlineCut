// 雙畫面版型：子母畫面、圓形小窗、分割畫面。
// 每個版型是一組「畫面框」，第一格是主畫面（最下面的軌道），其他依軌道由下往上排。

import { getClip, canFrame, cleanFrame, activeClipsAt, produce } from './project.js';

export const LAYOUTS = [
  { id: 'pip-br', label: '子母畫面・右下', group: 'pip' },
  { id: 'pip-bl', label: '子母畫面・左下', group: 'pip' },
  { id: 'pip-tr', label: '子母畫面・右上', group: 'pip' },
  { id: 'pip-tl', label: '子母畫面・左上', group: 'pip' },
  { id: 'circle-br', label: '圓形小窗・右下', group: 'pip' },
  { id: 'circle-bl', label: '圓形小窗・左下', group: 'pip' },
  { id: 'split-h', label: '左右分割', group: 'split' },
  { id: 'split-v', label: '上下分割', group: 'split' },
  { id: 'three', label: '三分割', group: 'split' },
  { id: 'grid4', label: '四宮格', group: 'split' },
];

export const PIP_SIZE = 0.34;    // 子畫面寬度（畫面的比例）
export const CIRCLE_SIZE = 0.36; // 圓形直徑（短邊的比例）

const full = () => ({ x: 0, y: 0, w: 1, h: 1, shape: 'rect', border: 0, borderColor: '#ffffff', shadow: false });

/** 版型的每一格（以畫面比例表示）。不認識的版型回傳 null */
export function layoutFrames(id, W, H) {
  const short = Math.min(W, H);
  const mx = (short * 0.04) / W, my = (short * 0.04) / H; // 小窗離邊緣的距離
  const gx = (short * 0.01) / W, gy = (short * 0.01) / H; // 分割畫面的間隔
  const border = Math.round(short * 0.006);
  const corner = (w, h, pos) => ({
    x: pos.endsWith('r') ? 1 - mx - w : mx,
    y: pos.startsWith('b') ? 1 - my - h : my,
    w, h,
  });
  const cell = (x, y, w, h) => ({ ...full(), x, y, w, h });

  const [kind, pos] = id.split('-');
  if (kind === 'pip' && ['br', 'bl', 'tr', 'tl'].includes(pos)) {
    return [full(), { ...full(), ...corner(PIP_SIZE, PIP_SIZE, pos), shape: 'round', border, shadow: true }];
  }
  if (kind === 'circle' && ['br', 'bl'].includes(pos)) {
    const d = short * CIRCLE_SIZE;
    return [full(), { ...full(), ...corner(d / W, d / H, pos), shape: 'circle', border: border * 1.5, shadow: true }];
  }
  if (id === 'split-h') return [cell(0, 0, (1 - gx) / 2, 1), cell((1 + gx) / 2, 0, (1 - gx) / 2, 1)];
  if (id === 'split-v') return [cell(0, 0, 1, (1 - gy) / 2), cell(0, (1 + gy) / 2, 1, (1 - gy) / 2)];
  if (id === 'three') {
    // 橫式畫面切成三欄，直式畫面切成三列
    if (W >= H) { const w = (1 - 2 * gx) / 3; return [0, 1, 2].map(i => cell(i * (w + gx), 0, w, 1)); }
    const h = (1 - 2 * gy) / 3;
    return [0, 1, 2].map(i => cell(0, i * (h + gy), 1, h));
  }
  if (id === 'grid4') {
    const w = (1 - gx) / 2, h = (1 - gy) / 2;
    return [cell(0, 0, w, h), cell(w + gx, 0, w, h), cell(0, h + gy, w, h), cell(w + gx, h + gy, w, h)];
  }
  return null;
}

/** 依軌道由下往上排（下面的是主畫面），同一軌依開始時間 */
function byTrackBottomFirst(project, clips) {
  const order = new Map(project.tracks.map((t, i) => [t.id, i]));
  return [...clips].sort((a, b) => (order.get(b.trackId) - order.get(a.trackId)) || (a.start - b.start));
}

/**
 * 決定套用版型的片段：先用選取的片段；不夠的話補上播放頭位置其他看得到的影片 / 圖片。
 * 回傳依「主畫面 → 子畫面」排好的片段。
 */
export function layoutCandidates(project, selectedIds, t, slots) {
  const picked = selectedIds.map(id => getClip(project, id)).filter(canFrame);
  const ids = new Set(picked.map(c => c.id));
  const trackOf = new Map(project.tracks.map(tr => [tr.id, tr]));
  if (picked.length < slots) {
    for (const c of byTrackBottomFirst(project, activeClipsAt(project, t))) {
      if (picked.length >= slots) break;
      if (!canFrame(c) || ids.has(c.id) || trackOf.get(c.trackId)?.locked) continue;
      // 同一軌只取一個（同一時間只會有一個）
      picked.push(c);
      ids.add(c.id);
    }
  }
  return byTrackBottomFirst(project, picked).slice(0, slots);
}

/**
 * 套用版型。layoutId 為 'none' 時取消這些片段的畫面框。
 * 套用時取景重設（縮放 100%、置中）。
 */
export function applyLayout(project, clipIds, layoutId) {
  const clips = byTrackBottomFirst(project, clipIds.map(id => getClip(project, id)).filter(canFrame));
  if (!clips.length) return { project, applied: 0 };
  const identity = { x: 0, y: 0, scale: 1, rotation: 0 };
  if (layoutId === 'none') {
    const next = produce(project, p => {
      for (const c of clips) Object.assign(getClip(p, c.id), { frame: null, transform: { ...identity } });
    });
    return { project: next, applied: clips.length };
  }
  const frames = layoutFrames(layoutId, project.width, project.height);
  if (!frames) return { project, applied: 0 };
  const n = Math.min(frames.length, clips.length);
  const next = produce(project, p => {
    for (let i = 0; i < n; i++) Object.assign(getClip(p, clips[i].id), { frame: cleanFrame(frames[i]), transform: { ...identity } });
  });
  return { project: next, applied: n };
}

/** 片段目前的畫面框符合哪個版型的哪一格（給 UI 標示目前的版型） */
export function matchLayout(project, clip) {
  if (!clip?.frame) return null;
  const f = clip.frame;
  for (const l of LAYOUTS) {
    const frames = layoutFrames(l.id, project.width, project.height);
    const i = frames.findIndex(g => g.shape === f.shape && ['x', 'y', 'w', 'h'].every(k => Math.abs(g[k] - f[k]) < 1e-3));
    // 主畫面是全畫面，很多版型都一樣，只認子畫面或分割格
    if (i > 0 || (i === 0 && l.group === 'split')) return l.id;
  }
  return null;
}
