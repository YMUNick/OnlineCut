// AI 字幕的純邏輯（可在 Node 測試）：把語音辨識的段落切成好讀的字幕、SRT、WAV 編碼、找安靜的地方切段

const CJK = /[⺀-鿿가-힯豈-﫿＀-￯　-〿]/;
const BREAK_AFTER = /[。！？!?；;，,、：:…]/;
const SENTENCE_END = /[。！？!?…]/;

/** 字幕的「寬度」：中日韓字算 1，其他字元算 0.55 */
export function textUnits(s) {
  let n = 0;
  for (const ch of s) n += CJK.test(ch) ? 1 : 0.55;
  return n;
}

/** 一行最多幾個中文字寬：字級約佔 1 個中文字，左右各留 6% */
export function lineUnitsFor(width, fontSize) {
  return Math.max(8, Math.min(18, Math.floor((width * 0.88) / fontSize)));
}

/**
 * 把一句話切成每段不超過 max 寬的幾段。優先在句號、逗號、空白切，
 * 沒有的話中文直接切、英文在單字之間切。
 */
export function splitText(text, max) {
  const out = [];
  let rest = text.trim();
  while (rest && textUnits(rest) > max) {
    const chars = [...rest];
    let units = 0, limit = 0;
    for (; limit < chars.length; limit++) {
      units += textUnits(chars[limit]);
      if (units > max) break;
    }
    // 在可以切的地方中，選最後一個（但不要切得太短）
    let cut = -1;
    for (let i = limit - 1; i >= Math.floor(limit * 0.4); i--) {
      if (BREAK_AFTER.test(chars[i])) { cut = i + 1; break; }
    }
    if (cut < 0) for (let i = limit; i >= Math.floor(limit * 0.4); i--) {
      if (chars[i] === ' ') { cut = i; break; }
    }
    if (cut < 0) {
      // 英文單字不要從中間切
      cut = limit;
      if (!CJK.test(chars[limit] ?? '') && !CJK.test(chars[limit - 1] ?? '')) {
        let i = limit;
        while (i > 0 && chars[i - 1] !== ' ' && !CJK.test(chars[i - 1])) i--;
        if (i > 0) cut = i;
      }
    }
    out.push(chars.slice(0, cut).join('').trim());
    rest = chars.slice(cut).join('').trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/** 字幕結尾的逗號、句號拿掉（中文字幕的習慣），問號驚嘆號保留 */
function tidy(s) {
  return s.replace(/[，,、。．；;：:]+$/u, '').trim();
}

/** 換行：每行不超過 max 寬，盡量平均 */
export function wrapLines(text, max) {
  const total = textUnits(text);
  if (total <= max) return text;
  const lines = Math.ceil(total / max);
  return splitText(text, Math.min(max, Math.max(Math.ceil(total / lines) + 1, max * 0.6))).join('\n');
}

/**
 * 辨識結果 → 字幕。segments 是 [{ start, end, text }]（時間軸時間，秒）。
 * 太長的段落依字數比例分配時間切開；字幕不重疊，每段至少 minDuration 秒。
 */
export function buildCaptions(segments, { lineUnits = 16, maxLines = 2, minDuration = 0.6 } = {}) {
  const out = [];
  const sorted = [...segments].filter(s => s && typeof s.text === 'string' && s.text.trim() && s.end > s.start).sort((a, b) => a.start - b.start);
  for (const seg of sorted) {
    const pieces = splitText(seg.text.replace(/\s+/g, ' '), lineUnits * maxLines);
    const total = pieces.reduce((n, p) => n + textUnits(p), 0) || 1;
    let t = seg.start;
    for (const p of pieces) {
      const d = (seg.end - seg.start) * (textUnits(p) / total);
      const text = tidy(p);
      if (text) out.push({ start: t, end: t + d, text: wrapLines(text, lineUnits) });
      t += d;
    }
  }
  // 不重疊、至少 minDuration（後面有空間時往後延）
  for (let i = 0; i < out.length; i++) {
    const c = out[i], next = out[i + 1];
    if (next && c.end > next.start) c.end = next.start;
    if (c.end - c.start < minDuration) c.end = Math.min(c.start + minDuration, next ? next.start : Infinity);
  }
  return out.filter(c => c.end - c.start > 0.05);
}

/**
 * 去掉 Whisper 在安靜片段常見的「幻聽」：很可能沒有人說話、而且辨識信心很低的段落，
 * 以及同一句一直重複的段落。
 */
export function cleanSegments(segments) {
  return segments.filter(s => {
    if (!s?.text?.trim()) return false;
    if (s.no_speech_prob > 0.6 && s.avg_logprob < -1) return false;
    if (s.compression_ratio > 2.6) return false;
    return true;
  });
}

/** 沒有段落時間的服務（只回傳整段文字）：依句子切開，按字數平均分配時間 */
export function segmentsFromText(text, start, end) {
  const sentences = [];
  let cur = '';
  for (const ch of String(text || '').trim()) {
    cur += ch;
    if (SENTENCE_END.test(ch) || (ch === '.' && cur.length > 1)) { sentences.push(cur.trim()); cur = ''; }
  }
  if (cur.trim()) sentences.push(cur.trim());
  const total = sentences.reduce((n, s) => n + textUnits(s), 0) || 1;
  let t = start;
  return sentences.filter(Boolean).map(s => {
    const d = (end - start) * (textUnits(s) / total);
    const seg = { start: t, end: t + d, text: s };
    t += d;
    return seg;
  });
}

export function formatSrtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

export function toSRT(captions) {
  return captions.map((c, i) => `${i + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${c.text}\n`).join('\n');
}

/** 單聲道 16-bit PCM WAV */
export function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return buf;
}

/** 在 [from, to) 之間找最安靜的 0.2 秒（用來切段，避免把一句話切成兩半），回傳樣本位置 */
export function findQuietCut(samples, rate, from, to) {
  const win = Math.max(1, Math.round(rate * 0.2));
  from = Math.max(0, Math.floor(from));
  to = Math.min(samples.length, Math.floor(to));
  if (to - from <= win) return to;
  let best = to, bestE = Infinity;
  for (let i = from; i + win <= to; i += Math.max(1, win >> 1)) {
    let e = 0;
    for (let k = i; k < i + win; k += 4) e += samples[k] * samples[k];
    if (e < bestE) { bestE = e; best = i + (win >> 1); }
  }
  return best;
}

/** 平均音量（RMS），用來跳過完全沒聲音的段落 */
export function rms(samples) {
  let e = 0;
  for (let i = 0; i < samples.length; i += 8) e += samples[i] * samples[i];
  return Math.sqrt(e / Math.max(1, Math.ceil(samples.length / 8)));
}
