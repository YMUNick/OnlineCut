// 匯出：
//   1. 首選 WebCodecs（透過 mediabunny）：影片依序解碼、逐格渲染、編碼成 H.264 + AAC/Opus 的 MP4。
//      每一格都精準對齊，不受分頁是否在前景影響。
//   2. 瀏覽器沒有 WebCodecs 時，用 MediaRecorder 即時錄製成 WebM（需要整段播放一次）。
// 聲音一律用 OfflineAudioContext 預先混好，包含音量、淡入淡出、變速。

import { getDuration } from '../core/project.js';
import { visualClipsAt, visualRange, visualSourceTime } from '../core/transitions.js';
import { drawFrame, fontString } from './renderer.js';
import { Player } from './player.js';
import { loadMediabunny } from './mb.js';
import { AudioSources, mixChunks, projectHasAudio, audibleClips } from './audio.js';
import { _t } from '../i18n.js';

export { loadMediabunny };

export const SAMPLE_RATE = 48000;
export const RESOLUTIONS = [
  { id: 'source', label: _t('原始'), short: null },
  { id: '1080', label: '1080p', short: 1080 },
  { id: '720', label: '720p', short: 720 },
  { id: '480', label: '480p', short: 480 },
];
export const QUALITY = { high: 0.16, medium: 0.1, low: 0.06 }; // 每像素每格的位元數

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** 依「短邊」計算輸出尺寸（不會放大超過專案解析度） */
export function outputSize(project, short) {
  const s = Math.min(project.width, project.height);
  const k = short ? Math.min(1, short / s) : 1;
  return { width: even(project.width * k), height: even(project.height * k) };
}

export function estimateBitrate(width, height, fps, quality = 'high') {
  return Math.round(Math.min(40e6, Math.max(1e6, width * height * fps * (QUALITY[quality] ?? QUALITY.high))));
}

export function sanitizeFilename(name) {
  return (String(name || 'OnlineCut').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'OnlineCut');
}

class Aborted extends Error { constructor() { super(_t('已取消匯出')); this.name = 'AbortError'; } }
const check = (signal) => { if (signal?.aborted) throw new Aborted(); };

// ============================================================
// 能力偵測
// ============================================================
async function canEncodeH264(width, height, fps, bitrate) {
  if (typeof VideoEncoder === 'undefined') return false;
  for (const codec of fps > 30 ? ['avc1.64002a', 'avc1.4d002a'] : ['avc1.640028', 'avc1.4d0028', 'avc1.42e028']) {
    try {
      if ((await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps })).supported) return true;
    } catch { /* 試下一個 */ }
  }
  return false;
}

async function canEncodeAudio(codec) {
  if (typeof AudioEncoder === 'undefined') return false;
  try {
    return (await AudioEncoder.isConfigSupported({ codec, sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: 192000 })).supported;
  } catch { return false; }
}

/** 回報這個瀏覽器會用哪種方式匯出（給對話框顯示用，不載入 mediabunny） */
export async function detectExportSupport(project, { short = null, fps = project.fps, quality = 'high' } = {}) {
  const { width, height } = outputSize(project, short);
  if (await canEncodeH264(width, height, fps, estimateBitrate(width, height, fps, quality))) {
    const audio = (await canEncodeAudio('mp4a.40.2')) ? 'aac' : (await canEncodeAudio('opus')) ? 'opus' : null;
    // 專案有聲音、瀏覽器卻不能編碼音訊時，改走即時錄製，不要輸出沒有聲音的影片
    if (audio || !audibleClips(project).length) return { method: 'webcodecs', container: 'mp4', video: 'h264', audio };
  }
  const mime = pickRecorderMime();
  if (mime) return { method: 'recorder', container: mime.includes('mp4') ? 'mp4' : 'webm', video: mime, audio: null };
  return { method: null };
}

function pickRecorderMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  return ['video/mp4;codecs=avc1,mp4a', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(t => MediaRecorder.isTypeSupported(t)) || null;
}

// ============================================================
// 共用：字型、音訊混音
// ============================================================
async function loadFonts(project) {
  if (!document.fonts?.load) return;
  const fonts = new Set(project.clips.filter(c => c.type === 'text').map(c => fontString(c.text, 48)));
  await Promise.all([...fonts].map(f => document.fonts.load(f).catch(() => {})));
  await document.fonts.ready;
}

/** 把分段混好的聲音接成一整段（只有即時錄製備援需要） */
async function mixWhole(project, sources, duration, { signal, onProgress, onWarning }) {
  const parts = [];
  for await (const c of mixChunks(project, sources, duration, { sampleRate: SAMPLE_RATE, signal, onWarning })) {
    parts.push(c.buffer);
    onProgress?.(c.end / duration);
  }
  const length = parts.reduce((n, b) => n + b.length, 0);
  const out = new AudioBuffer({ length, numberOfChannels: 2, sampleRate: SAMPLE_RATE });
  let off = 0;
  for (const b of parts) {
    for (let ch = 0; ch < 2; ch++) out.copyToChannel(b.getChannelData(ch), ch, off);
    off += b.length;
  }
  return out;
}

// ============================================================
// 逐格畫面來源
// ============================================================

/**
 * 影片片段的畫面來源。優先用 mediabunny 依序解碼（每個封包只解一次）；
 * 它不支援的檔案（例如 AVI）退回用 <video> 跳到每一格。
 */
class ClipFrames {
  constructor(clip, item, mb, timestamps) {
    this.clip = clip;
    this.item = item;
    this.mb = mb;
    this.timestamps = timestamps; // 這個片段每一格對應的素材時間
    this.current = null;          // 目前這格（VideoSample 或 <video>）
    this.iter = null;
    this.video = null;
  }

  async open() {
    if (this.mb) {
      try {
        const input = new this.mb.Input({ formats: this.mb.ALL_FORMATS, source: new this.mb.BlobSource(this.item.file) });
        const track = await input.getPrimaryVideoTrack();
        if (track && (await track.canDecode())) {
          this.input = input;
          this.iter = new this.mb.VideoSampleSink(track).samplesAtTimestamps(this.timestamps);
          return;
        }
        input.dispose?.();
      } catch { /* 退回 <video> */ }
    }
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    v.src = this.item.url;
    await waitFor(v, 'loadeddata', 15000);
    this.video = v;
  }

  /** 前進到下一格（呼叫順序必須跟 timestamps 一致） */
  async next(index) {
    if (this.iter) {
      const { value } = await this.iter.next();
      if (value) { this.current?.close?.(); this.current = value; }
      return;
    }
    const v = this.video;
    const target = Math.min(this.timestamps[index], (isFinite(v.duration) ? v.duration : Infinity) - 0.001);
    if (Math.abs(v.currentTime - target) > 1e-4 || v.readyState < 2) {
      v.currentTime = target;
      await waitFor(v, 'seeked', 10000);
    }
    this.current = v;
  }

  close() {
    if (this.current && this.current !== this.video) this.current.close?.();
    this.current = null;
    this.iter?.return?.();
    this.input?.dispose?.();
    if (this.video) { this.video.removeAttribute('src'); this.video.load(); }
  }
}

class FrameSources {
  constructor(project, runtime, fps, frames, mb) {
    this.project = project;
    this.runtime = runtime;
    this.fps = fps;
    this.frames = frames;
    this.mb = mb;
    this.open = new Map(); // clipId → ClipFrames
    this.pos = new Map();  // clipId → 這個片段已經走到第幾格
  }

  /** 片段在輸出中佔用的格數範圍 [first, last]（含轉場多出來的部分） */
  range(clip) {
    const [a, b] = visualRange(this.project, clip);
    const first = Math.max(0, Math.ceil(a * this.fps - 1e-6));
    const last = Math.min(this.frames - 1, Math.ceil(b * this.fps - 1e-6) - 1);
    return [first, last];
  }

  async prepare(i) {
    const t = i / this.fps;
    const active = visualClipsAt(this.project, t).filter(c => c.type === 'video' && this.runtime.has(c.mediaId));
    for (const c of active) {
      let cf = this.open.get(c.id);
      if (!cf) {
        const [first, last] = this.range(c);
        const ts = [];
        for (let k = first; k <= last; k++) ts.push(visualSourceTime(this.project, c, k / this.fps));
        cf = new ClipFrames(c, this.runtime.get(c.mediaId), this.mb, ts);
        await cf.open();
        this.open.set(c.id, cf);
        this.pos.set(c.id, first);
      }
      // 對齊到第 i 格（中間被跳過的格也要依序走過）
      const [first] = this.range(c);
      while (this.pos.get(c.id) <= i) {
        await cf.next(this.pos.get(c.id) - first);
        this.pos.set(c.id, this.pos.get(c.id) + 1);
      }
    }
    // 關掉已經結束的片段
    for (const [id, cf] of this.open) {
      if (visualRange(this.project, cf.clip)[1] <= t) { cf.close(); this.open.delete(id); }
    }
  }

  source(clip) {
    if (clip.type === 'image') return this.runtime.get(clip.mediaId)?.image;
    if (clip.type === 'video') return this.open.get(clip.id)?.current;
    return null;
  }

  dispose() {
    for (const cf of this.open.values()) cf.close();
    this.open.clear();
  }
}

function waitFor(el, event, timeout) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error(_t('讀取影片畫面逾時'))); }, timeout);
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error(_t('影片無法解碼'))); };
    function cleanup() { clearTimeout(t); el.removeEventListener(event, ok); el.removeEventListener('error', bad); }
    el.addEventListener(event, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });
}

// ============================================================
// 匯出主流程
// ============================================================
/**
 * settings: { short, fps, quality, forceRecorder }
 * onProgress({ phase: 'audio'|'video'|'finish', progress: 0–1, frame, frames, eta })
 * 回傳 { blob, mime, ext, method, codecs, width, height, fps }
 */
export async function exportVideo({ project, runtime, settings = {}, onProgress = () => {}, signal }) {
  const duration = getDuration(project);
  if (duration <= 0) throw new Error(_t('時間軸是空的，沒有東西可以匯出'));
  const missing = project.clips.filter(c => c.mediaId && !runtime.has(c.mediaId));
  if (missing.length) throw new Error(_t('有素材檔案遺失，請先重新匯入'));

  const fps = settings.fps || project.fps;
  const quality = settings.quality || 'high';
  const { width, height } = outputSize(project, settings.short);
  const bitrate = estimateBitrate(width, height, fps, quality);

  await loadFonts(project);
  onProgress({ phase: 'audio', progress: 0 });
  const sources = new AudioSources(runtime);
  const warnings = [];
  const onWarning = (mediaId, reason) => warnings.push({ mediaId, name: project.media[mediaId]?.name ?? mediaId, reason });
  try {
    const hasAudio = await projectHasAudio(project, sources);
    check(signal);
    if (!settings.forceRecorder && (await canEncodeH264(width, height, fps, bitrate))) {
      // 直接問瀏覽器（mediabunny 會快取檢查結果）
      const audioCodec = !hasAudio ? null : (await canEncodeAudio('mp4a.40.2')) ? 'aac' : (await canEncodeAudio('opus')) ? 'opus' : null;
      // 有聲音卻不能編碼音訊時，改走即時錄製，不要輸出沒有聲音的影片
      if (!hasAudio || audioCodec) {
        const mb = await loadMediabunny();
        const res = await exportWebCodecs({ mb, project, runtime, sources, duration, fps, width, height, bitrate, audioCodec, onProgress, onWarning, signal });
        return { ...res, warnings };
      }
    }
    const audio = hasAudio ? await mixWhole(project, sources, duration, { signal, onWarning, onProgress: (p) => onProgress({ phase: 'audio', progress: p }) }) : null;
    const res = await exportRecorder({ project, runtime, duration, fps, width, height, bitrate, audio, onProgress, signal });
    return { ...res, warnings };
  } finally {
    sources.dispose();
  }
}

async function exportWebCodecs({ mb, project, runtime, sources, duration, fps, width, height, bitrate, audioCodec, onProgress, onWarning, signal }) {
  const videoCodec = await mb.getFirstEncodableVideoCodec(['avc'], { width, height, quality: new mb.Quality({ bitrate }) });
  if (!videoCodec) throw new Error(_t('這個瀏覽器無法編碼 H.264 影片'));

  const target = new mb.BufferTarget();
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d', { alpha: false });
  const videoSource = new mb.CanvasSource(canvas, { codec: videoCodec, quality: new mb.Quality({ bitrate }), keyFrameInterval: 2, latencyMode: 'quality' });
  output.addVideoTrack(videoSource, { frameRate: fps });
  let audioSource = null;
  if (audioCodec) {
    audioSource = new mb.AudioBufferSource({ codec: audioCodec, quality: new mb.Quality({ bitrate: 192000 }) });
    output.addAudioTrack(audioSource);
  }

  const frames = Math.max(1, Math.round(duration * fps));
  const frameSources = new FrameSources(project, runtime, fps, frames, mb);
  const started = performance.now();
  let finished = false;
  try {
    await output.start();
    // 聲音分段解碼、混音、編碼，記憶體用量跟檔案大小無關
    if (audioSource) {
      for await (const c of mixChunks(project, sources, duration, { sampleRate: SAMPLE_RATE, signal, onWarning })) {
        await audioSource.add(c.buffer);
        onProgress({ phase: 'audio', progress: c.end / duration });
      }
    }
    for (let i = 0; i < frames; i++) {
      check(signal);
      await frameSources.prepare(i);
      drawFrame(ctx, project, i / fps, { getSource: (c) => frameSources.source(c), getMediaInfo: (c) => project.media[c.mediaId] });
      await videoSource.add(i / fps, 1 / fps);
      if (i % 3 === 0 || i === frames - 1) {
        const elapsed = (performance.now() - started) / 1000;
        onProgress({ phase: 'video', progress: (i + 1) / frames, frame: i + 1, frames, eta: elapsed / (i + 1) * (frames - i - 1) });
      }
    }
    onProgress({ phase: 'finish', progress: 1 });
    await output.finalize();
    finished = true;
  } finally {
    frameSources.dispose();
    if (!finished && output.state !== 'canceled') await output.cancel().catch(() => {});
  }
  return {
    blob: new Blob([target.buffer], { type: 'video/mp4' }), mime: 'video/mp4', ext: 'mp4', method: 'webcodecs',
    codecs: [videoCodec, audioCodec].filter(Boolean), width, height, fps,
  };
}

async function exportRecorder({ project, runtime, duration, fps, width, height, bitrate, audio, onProgress, signal }) {
  const mime = pickRecorderMime();
  if (!mime) throw new Error(_t('這個瀏覽器不支援影片匯出，請改用最新版 Chrome、Edge 或 Safari'));
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const stream = canvas.captureStream(fps);
  let actx = null, src = null;
  if (audio) {
    actx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const dest = actx.createMediaStreamDestination();
    src = actx.createBufferSource();
    src.buffer = audio;
    src.connect(dest);
    dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  }
  const player = new Player({ canvas, runtime, getProject: () => project, silent: true });
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate, audioBitsPerSecond: 192000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => { rec.onstop = r; });

  // 先把第一格準備好
  player.seek(0);
  await new Promise(r => setTimeout(r, 400));
  rec.start(1000);
  if (actx) { await actx.resume(); src.start(); }
  await player.play();
  const t0 = performance.now();
  await new Promise((resolve, reject) => {
    const tick = () => {
      if (signal?.aborted) { reject(new Aborted()); return; }
      const t = player.time;
      onProgress({ phase: 'video', progress: Math.min(1, t / duration), eta: Math.max(0, duration - (performance.now() - t0) / 1000), realtime: true });
      if (!player.playing || t >= duration) resolve(); else setTimeout(tick, 200);
    };
    tick();
  }).finally(() => {
    player.destroy();
    if (rec.state !== 'inactive') rec.stop();
    src?.stop?.();
    actx?.close?.();
  });
  await stopped;
  const type = mime.split(';')[0];
  return { blob: new Blob(chunks, { type }), mime: type, ext: type.includes('mp4') ? 'mp4' : 'webm', method: 'recorder', codecs: [mime], width, height, fps };
}
