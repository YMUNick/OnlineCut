// AI 剪短影音的純邏輯（可在 Node 測試）：給語言模型的提示、解析回覆、把挑出來的片段接成新的時間軸

import { produce, uid, clipEnd, mediaLimit, ASPECT_PRESETS } from './project.js';

export const SHORT_LENGTHS = [15, 30, 60];

/** 給語言模型的訊息：逐句列出逐字稿（含編號與時間），請它挑出一段吸引人的短影音 */
export function buildShortPrompt(segments, { target = 30, hint = '', language = 'zh' } = {}) {
  const lines = segments.map((s, i) => `[${i}] ${s.start.toFixed(1)}-${s.end.toFixed(1)}s ${s.text.trim()}`).join('\n');
  const lang = language === 'zh' ? 'Traditional Chinese (Taiwan)' : language === 'en' || !language ? 'the same language as the transcript' : `the language with code "${language}"`;
  const system = [
    'You are an expert short-form video editor (YouTube Shorts, Instagram Reels, TikTok).',
    `From the numbered transcript, choose segments that together make one engaging short of about ${target} seconds (between ${Math.round(target * 0.75)} and ${Math.round(target * 1.2)} seconds total).`,
    'Rules: open with the strongest hook (a surprising claim, a question or the payoff); keep sentences whole; the result must make sense on its own without the rest of the video;',
    'you may reorder segments to put the hook first, otherwise keep the original order; avoid filler, greetings and repeated points.',
    `Reply with JSON only: {"segments": [segment numbers in playback order], "title": "a short catchy title", "reason": "one sentence on why this works"}. Write title and reason in ${lang}.`,
  ].join(' ');
  const user = `${hint ? `What to focus on: ${hint}\n\n` : ''}Transcript:\n${lines}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** 解析模型回覆：容許包在 ```json 裡或前後有多餘文字；只留下合法、不重複的編號 */
export function parseShortReply(text, count) {
  let obj = null;
  const s = String(text ?? '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { obj = JSON.parse(s.slice(a, b + 1)); } catch { obj = null; } }
  if (!obj || !Array.isArray(obj.segments)) return null;
  const seen = new Set();
  const ids = [];
  for (const v of obj.segments) {
    const i = typeof v === 'number' ? v : parseInt(v, 10);
    if (Number.isInteger(i) && i >= 0 && i < count && !seen.has(i)) { seen.add(i); ids.push(i); }
  }
  if (!ids.length) return null;
  return { ids, title: typeof obj.title === 'string' ? obj.title.slice(0, 120) : '', reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 300) : '' };
}

/**
 * 挑出來的段落 → 要保留的時間範圍（時間軸時間，依播放順序）。
 * 前後各留一點空間不切到字；相鄰（順序也相連）的段落合併；總長超過 maxTotal 就從後面截掉。
 */
export function pickRanges(segments, ids, { pad = 0.15, mergeGap = 0.6, maxTotal = Infinity, limit = Infinity } = {}) {
  const ranges = [];
  for (const i of ids) {
    const s = segments[i];
    if (!s || !(s.end > s.start)) continue;
    let a = Math.max(0, s.start - pad), b = Math.min(limit, s.end + pad);
    const last = ranges[ranges.length - 1];
    if (last && a >= last[0] && a - last[1] <= mergeGap) { last[1] = Math.max(last[1], b); continue; }
    // 不跟已經挑的範圍重疊
    for (const r of ranges) {
      if (a < r[1] && b > r[0]) { if (a >= r[0]) a = r[1]; else b = r[0]; }
    }
    if (b - a > 0.2) ranges.push([a, b]);
  }
  const out = [];
  let total = 0;
  for (const [a, b] of ranges) {
    if (total >= maxTotal) break;
    const len = Math.min(b - a, maxTotal - total);
    if (len > 0.2) out.push([a, a + len]);
    total += len;
  }
  return out;
}

export const rangesDuration = (ranges) => ranges.reduce((n, [a, b]) => n + b - a, 0);

/** 原本時間軸上的時間 → 新時間軸上的時間（不在保留範圍裡回傳 null） */
export function mapTime(ranges, t) {
  let off = 0;
  for (const [a, b] of ranges) {
    if (t >= a && t <= b) return off + (t - a);
    off += b - a;
  }
  return null;
}

/**
 * 只保留 ranges 裡的畫面與聲音，依序接起來。
 * keepMusic：音訊軌上的片段（背景音樂）不跟著剪，從第一段開始連續播到結尾，最後淡出。
 * aspect：換成這個畫面比例；fill = true 時影片和圖片放大填滿畫面（直式短影音常用）。
 */
export function extractRanges(project, ranges, { keepMusic = true, aspect = null, fill = false } = {}) {
  const total = rangesDuration(ranges);
  return produce(project, p => {
    const out = [];
    const music = keepMusic ? p.clips.filter(c => c.type === 'audio') : [];
    for (const c of p.clips) {
      if (music.includes(c)) continue;
      let off = 0;
      for (const [a, b] of ranges) {
        const s = Math.max(a, c.start), e = Math.min(b, clipEnd(c));
        if (e - s > 1e-3) {
          out.push({
            ...structuredCloneSafe(c),
            id: uid('clp'),
            start: off + (s - a),
            duration: e - s,
            srcIn: c.type === 'video' || c.type === 'audio' ? c.srcIn + (s - c.start) * c.speed : c.srcIn,
            fadeIn: 0, fadeOut: 0, audioFades: null, transitionIn: null,
          });
        }
        off += b - a;
      }
    }
    // 背景音樂：從第一段在原本時間軸的位置開始，連續播放
    const first = ranges[0]?.[0] ?? 0;
    for (const c of music) {
      const s = Math.max(first, c.start);
      if (s >= clipEnd(c)) continue;
      const startAt = c.start > first ? mapTime(ranges, c.start) ?? 0 : 0;
      const srcIn = c.srcIn + (s - c.start) * c.speed;
      const limit = mediaLimit(p, c);
      const dur = Math.min(total - startAt, (limit - srcIn) / c.speed);
      if (dur <= 0.05) continue;
      out.push({ ...structuredCloneSafe(c), id: uid('clp'), start: startAt, duration: dur, srcIn, fadeIn: 0, fadeOut: Math.min(1.5, dur / 3), audioFades: null, transitionIn: null });
    }
    p.clips = out;
    if (aspect && ASPECT_PRESETS[aspect]) {
      p.aspect = aspect;
      p.width = ASPECT_PRESETS[aspect].width;
      p.height = ASPECT_PRESETS[aspect].height;
    }
    if (fill) {
      for (const c of p.clips) {
        if ((c.type !== 'video' && c.type !== 'image') || c.frame) continue;
        const m = p.media[c.mediaId];
        if (!m?.width || !m?.height) continue;
        const contain = Math.min(p.width / m.width, p.height / m.height);
        const cover = Math.max(p.width / m.width, p.height / m.height);
        c.transform = { ...c.transform, x: 0, y: 0, scale: cover / contain, rotation: 0 };
      }
    }
  });
}

function structuredCloneSafe(o) {
  return typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o));
}

/** 把辨識段落換到新時間軸（只留在保留範圍裡的部分，給短影音加字幕用） */
export function remapSegments(segments, ranges) {
  const out = [];
  let off = 0;
  for (const [a, b] of ranges) {
    for (const s of segments) {
      const s0 = Math.max(a, s.start), s1 = Math.min(b, s.end);
      if (s1 - s0 > 0.2) out.push({ start: off + s0 - a, end: off + s1 - a, text: s.text });
    }
    off += b - a;
  }
  return out.sort((x, y) => x.start - y.start);
}
