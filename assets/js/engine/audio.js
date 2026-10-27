// 聲音：依需要只解碼用到的那一段，不把整個檔案讀進記憶體。
// 混音也分段進行（預設每 30 秒一段），記憶體用量跟時間軸長度與檔案大小都無關。

import { getTrack, clipEnd, audioFadesOf, audioFadeFactor } from '../core/project.js';
import { loadMediabunny, canStreamAudio } from './mb.js';
import { _t } from '../i18n.js';

export const audioSettings = {
  chunkSeconds: 30,   // 每次混音的長度
};

export function audibleClips(project) {
  return project.clips.filter(c => (c.type === 'video' || c.type === 'audio') && !c.muted && c.volume > 0 && !getTrack(project, c.trackId)?.muted);
}

/**
 * 片段在 [a, b]（時間軸時間）之間的音量包絡，回傳 [[時間, 音量], ...]。
 * 淡入淡出是直線，所以只要在轉折點之間做線性變化就完全準確。
 */
export function gainPoints(clip, a, b) {
  const s = clip.start, e = clipEnd(clip);
  const v = Math.min(2, Math.max(0, clip.volume));
  const f = audioFadesOf(clip);
  const ts = new Set([a, b]);
  if (f.in > 0) ts.add(s + f.in);
  if (f.out > 0) ts.add(e - f.out);
  // 淡入淡出重疊時，兩條線的交點也是轉折點
  if (f.in > 0 && f.out > 0 && f.in + f.out > clip.duration) {
    ts.add((s * f.out + e * f.in) / (f.in + f.out));
  }
  return [...ts].filter(t => t >= a && t <= b).sort((x, y) => x - y).map(t => [t, v * audioFadeFactor(clip, t)]);
}

/**
 * 時間軸 [w0, w1) 這一段需要播哪些聲音。回傳每個片段在這段裡的部分：
 * { clip, at: 從這段開頭算起的秒數, srcStart, srcEnd: 素材時間, length: 時間軸上的長度, gains: [[段內時間, 音量]] }
 */
export function audioPlan(project, w0, w1) {
  const out = [];
  for (const c of audibleClips(project)) {
    const a = Math.max(w0, c.start), b = Math.min(w1, clipEnd(c));
    if (b - a <= 1e-9) continue;
    out.push({
      clip: c,
      at: a - w0,
      srcStart: c.srcIn + (a - c.start) * c.speed,
      srcEnd: c.srcIn + (b - c.start) * c.speed,
      length: b - a,
      gains: gainPoints(c, a, b).map(([t, g]) => [t - w0, g]),
    });
  }
  return out;
}

/**
 * 每個素材的聲音來源。優先用 mediabunny 只解碼需要的範圍；
 * 不支援時退回瀏覽器的 decodeAudioData（只能用在不太大的檔案）。
 */
export class AudioSources {
  constructor(runtime) {
    this.runtime = runtime;
    this.cache = new Map(); // mediaId → Promise<{ kind: 'stream', sink } | { kind: 'whole', buffer } | { kind: 'none' } | { kind: 'error', reason }>
  }

  open(mediaId) {
    if (!this.cache.has(mediaId)) this.cache.set(mediaId, this._open(mediaId));
    return this.cache.get(mediaId);
  }

  async _open(mediaId) {
    const item = this.runtime.get(mediaId);
    if (!item) return { kind: 'error', reason: _t('素材檔案遺失') };
    if (canStreamAudio()) {
      try {
        const mb = await loadMediabunny();
        const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(item.file) });
        const track = await input.getPrimaryAudioTrack();
        if (!track) return { kind: 'none' };
        if (await track.canDecode()) return { kind: 'stream', sink: new mb.AudioBufferSink(track), input };
      } catch { /* 格式不支援，試試整個解碼 */ }
    }
    const whole = await this.runtime.decodeAudio(mediaId);
    if (whole) return { kind: 'whole', buffer: whole };
    if (this.runtime.get(mediaId)?.hasAudio === false) return { kind: 'none' };
    return { kind: 'error', reason: _t('檔案太大或格式不支援，瀏覽器無法讀取聲音') };
  }

  /** 有沒有聲音（none = 沒有音軌，error = 有但讀不到） */
  async status(mediaId) {
    return (await this.open(mediaId)).kind;
  }

  /**
   * 解碼素材 [srcStart, srcEnd) 這一段。回傳 { buffer, start: buffer 開頭對應的素材時間 }，沒有聲音回傳 null
   */
  async segment(mediaId, srcStart, srcEnd) {
    const src = await this.open(mediaId);
    if (src.kind === 'whole') return { buffer: src.buffer, start: 0 };
    if (src.kind !== 'stream') return null;
    const parts = [];
    for await (const w of src.sink.buffers(Math.max(0, srcStart - 0.05), srcEnd + 0.05)) parts.push(w);
    if (!parts.length) return null;
    const rate = parts[0].buffer.sampleRate;
    const channels = Math.min(2, Math.max(...parts.map(p => p.buffer.numberOfChannels)));
    const start = parts[0].timestamp;
    const end = Math.max(...parts.map(p => p.timestamp + p.buffer.duration));
    const length = Math.max(1, Math.ceil((end - start) * rate));
    const out = new AudioBuffer({ length, numberOfChannels: channels, sampleRate: rate });
    for (const p of parts) {
      const offset = Math.round((p.timestamp - start) * rate);
      for (let ch = 0; ch < channels; ch++) {
        const data = p.buffer.getChannelData(Math.min(ch, p.buffer.numberOfChannels - 1));
        const n = Math.min(data.length, length - offset);
        if (n > 0 && offset >= 0) out.copyToChannel(n === data.length ? data : data.subarray(0, n), ch, offset);
      }
    }
    return { buffer: out, start };
  }

  dispose() {
    for (const p of this.cache.values()) p.then(s => s.input?.dispose?.()).catch(() => {});
    this.cache.clear();
  }
}

/**
 * 依序產生混好的聲音，每段 audioSettings.chunkSeconds 秒（從時間軸 start 秒開始，到 duration 秒）。
 * onWarning(mediaId, reason)：有片段的聲音讀不到時呼叫（不會默默變成沒聲音）
 */
export async function* mixChunks(project, sources, duration, { sampleRate = 48000, signal, onWarning = () => {}, start = 0, channels = 2 } = {}) {
  const chunk = Math.max(0.5, audioSettings.chunkSeconds);
  const warned = new Set();
  const total = Math.max(1, Math.round(duration * sampleRate));
  for (let i0 = Math.min(total - 1, Math.max(0, Math.round(start * sampleRate))); i0 < total;) {
    const i1 = Math.min(total, i0 + Math.round(chunk * sampleRate));
    const w0 = i0 / sampleRate, w1 = i1 / sampleRate;
    const ctx = new OfflineAudioContext(channels, i1 - i0, sampleRate);
    for (const piece of audioPlan(project, w0, w1)) {
      if (signal?.aborted) throw Object.assign(new Error(_t('已取消匯出')), { name: 'AbortError' });
      const id = piece.clip.mediaId;
      const seg = await sources.segment(id, piece.srcStart, piece.srcEnd);
      if (!seg) {
        const st = await sources.open(id);
        if (st.kind === 'error' && !warned.has(id)) { warned.add(id); onWarning(id, st.reason); }
        continue;
      }
      const node = ctx.createBufferSource();
      node.buffer = seg.buffer;
      node.playbackRate.value = piece.clip.speed;
      const g = ctx.createGain();
      const [[t0, g0], ...rest] = piece.gains;
      g.gain.setValueAtTime(g0, t0);
      for (const [t, v] of rest) g.gain.linearRampToValueAtTime(v, t);
      node.connect(g).connect(ctx.destination);
      const offset = Math.max(0, piece.srcStart - seg.start);
      node.start(piece.at, offset, piece.srcEnd - piece.srcStart);
      node.stop(piece.at + piece.length);
    }
    yield { buffer: await ctx.startRendering(), start: w0, end: w1 };
    i0 = i1;
  }
}

/** 整段時間軸會不會有聲音（決定輸出檔要不要有音軌） */
export async function projectHasAudio(project, sources) {
  for (const c of audibleClips(project)) {
    const k = await sources.status(c.mediaId);
    if (k === 'stream' || k === 'whole' || k === 'error') return true;
  }
  return false;
}
