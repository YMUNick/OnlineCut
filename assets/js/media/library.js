// 素材匯入與執行期資源：讀取長度/尺寸、縮圖膠卷、音訊波形、解碼後的音訊（匯出用）

import { uid } from '../core/project.js';

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv|avi)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

export const MAX_DECODE_BYTES = 400 * 1024 * 1024; // 超過就不解碼音訊（避免吃光記憶體）

export function detectType(file) {
  const mime = file.type || '';
  if (mime.startsWith('video/') || (!mime && VIDEO_EXT.test(file.name))) return 'video';
  if (mime.startsWith('audio/') || (!mime && AUDIO_EXT.test(file.name))) return 'audio';
  if (mime.startsWith('image/') || (!mime && IMAGE_EXT.test(file.name))) return 'image';
  if (VIDEO_EXT.test(file.name)) return 'video';
  if (AUDIO_EXT.test(file.name)) return 'audio';
  if (IMAGE_EXT.test(file.name)) return 'image';
  return null;
}

/** 自己丟出的錯誤（訊息是給使用者看的） */
function friendly(message) {
  const e = new Error(message);
  e.friendly = true;
  return e;
}

function once(target, ok, fail = 'error', timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(friendly('讀取逾時')); }, timeoutMs);
    const onOk = () => { cleanup(); resolve(); };
    const onFail = () => { cleanup(); reject(target.error || friendly('無法讀取')); };
    function cleanup() {
      clearTimeout(timer);
      target.removeEventListener(ok, onOk);
      target.removeEventListener(fail, onFail);
    }
    target.addEventListener(ok, onOk);
    target.addEventListener(fail, onFail);
  });
}

/** MediaRecorder 錄出來的 webm 常常沒有長度資訊，要跳到最後才拿得到 */
async function resolveDuration(el) {
  if (isFinite(el.duration) && el.duration > 0) return el.duration;
  el.currentTime = 1e7;
  await Promise.race([once(el, 'durationchange'), once(el, 'seeked')]).catch(() => {});
  const d = el.duration;
  el.currentTime = 0;
  return isFinite(d) ? d : NaN;
}

/** 讀取素材資訊；不支援的檔案會丟出看得懂的錯誤 */
export async function probe(file) {
  const type = detectType(file);
  if (!type) throw friendly(`不支援的檔案類型：${file.name}`);
  const url = URL.createObjectURL(file);
  const info = { id: uid('med'), type, name: file.name, size: file.size, mime: file.type, addedAt: Date.now() };
  try {
    if (type === 'image') {
      const img = new Image();
      img.src = url;
      await img.decode();
      info.width = img.naturalWidth || 1;
      info.height = img.naturalHeight || 1;
      info.duration = null;
    } else {
      const el = document.createElement(type === 'video' ? 'video' : 'audio');
      el.preload = 'metadata';
      el.muted = true;
      el.src = url;
      await once(el, 'loadedmetadata');
      info.duration = await resolveDuration(el);
      if (!(info.duration > 0)) throw friendly('無法取得長度');
      if (type === 'video') {
        info.width = el.videoWidth;
        info.height = el.videoHeight;
        if (!info.width || !info.height) throw friendly('讀不到影片畫面（瀏覽器可能不支援這種編碼，可以先轉成 MP4 H.264 或 WebM）');
      }
      el.removeAttribute('src');
      el.load();
    }
  } catch (e) {
    URL.revokeObjectURL(url);
    // 瀏覽器原本的錯誤訊息（例如 PipelineStatus::DEMUXER_ERROR…）使用者看不懂，換成白話
    const reason = e?.friendly ? e.message : '檔案損毀，或瀏覽器不支援這種格式';
    throw friendly(`${file.name}：${reason}`);
  }
  return { info, url };
}

/**
 * 執行期資源（不存檔）：object URL、圖片、縮圖、波形、解碼音訊
 */
export class MediaRuntime {
  constructor() {
    this.items = new Map(); // mediaId → { file, url, info, image, thumbs, peaks, audioBuffer, ... }
    this.listeners = new Set();
    this.audioCtx = null;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(id) { for (const fn of this.listeners) fn(id); }

  get(id) { return this.items.get(id) ?? null; }
  has(id) { return this.items.has(id); }

  /** 登記一個素材檔案；會在背景產生縮圖與波形 */
  async register(info, file, url = null) {
    // 複製一份：之後偵測到的資訊（例如有沒有音軌）只記在這裡，不能偷改專案狀態
    info = { ...info };
    const item = { info, file, url: url || URL.createObjectURL(file), image: null, thumbs: [], peaks: null, peaksPerSec: 0, audioBuffer: null };
    this.items.set(info.id, item);
    if (info.type === 'image') {
      const img = new Image();
      img.src = item.url;
      try { await img.decode(); } catch { /* 下次繪製時再試 */ }
      item.image = img;
      item.thumbs = [{ t: 0, canvas: makeThumb(img, img.naturalWidth, img.naturalHeight) }];
      this.emit(info.id);
    } else {
      // 縮圖與波形在背景跑，不擋住匯入
      if (info.type === 'video') this.buildThumbs(item).catch(() => {});
      this.buildPeaks(item).catch(() => {});
    }
    return item;
  }

  release(id) {
    const item = this.items.get(id);
    if (!item) return;
    URL.revokeObjectURL(item.url);
    this.items.delete(id);
  }

  releaseAll() {
    for (const id of [...this.items.keys()]) this.release(id);
  }

  async buildThumbs(item) {
    const { duration, width, height } = item.info;
    const count = Math.max(1, Math.min(40, Math.ceil(duration / 2)));
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = item.url;
    await once(v, 'loadeddata');
    const thumbs = [];
    for (let i = 0; i < count; i++) {
      const t = Math.min(duration - 0.05, (i + 0.5) * (duration / count));
      v.currentTime = Math.max(0, t);
      await once(v, 'seeked', 'error', 8000);
      thumbs.push({ t, canvas: makeThumb(v, width, height) });
      // 先有第一張就通知畫面更新
      if (i === 0 || i === count - 1 || i % 8 === 0) {
        item.thumbs = thumbs.slice();
        this.emit(item.info.id);
      }
    }
    item.thumbs = thumbs;
    v.removeAttribute('src');
    v.load();
    this.emit(item.info.id);
  }

  ctx() {
    if (!this.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AC();
    }
    return this.audioCtx;
  }

  /** 解碼整段音訊（匯出混音也會用到）；沒有音軌的影片回傳 null */
  async decodeAudio(id) {
    const item = this.items.get(id);
    if (!item || item.info.type === 'image') return null;
    if (item.audioBuffer !== null) return item.audioBuffer || null;
    if (item.decoding) return item.decoding;
    if (item.file.size > MAX_DECODE_BYTES) {
      item.audioBuffer = false;
      return null;
    }
    item.decoding = (async () => {
      try {
        const buf = await item.file.arrayBuffer();
        const audio = await this.ctx().decodeAudioData(buf);
        item.audioBuffer = audio;
        item.info.hasAudio = true;
        return audio;
      } catch {
        item.audioBuffer = false; // 沒有音軌或無法解碼
        item.info.hasAudio = false;
        return null;
      } finally {
        item.decoding = null;
      }
    })();
    return item.decoding;
  }

  async buildPeaks(item) {
    const audio = await this.decodeAudio(item.info.id);
    if (!audio) { this.emit(item.info.id); return; }
    item.peaksPerSec = 100;
    item.peaks = computePeaks(audio, item.peaksPerSec);
    // 影片的音訊只在匯出時需要，先釋放記憶體，需要時再解碼
    if (item.info.type === 'video' && audio.length * audio.numberOfChannels > 48000 * 2 * 120) item.audioBuffer = null;
    this.emit(item.info.id);
  }
}

/** 每秒 perSec 個峰值（0–1） */
export function computePeaks(audioBuffer, perSec = 100) {
  const bucket = Math.max(1, Math.floor(audioBuffer.sampleRate / perSec));
  const n = Math.ceil(audioBuffer.length / bucket);
  const peaks = new Float32Array(n);
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      let max = 0;
      const end = Math.min(data.length, (i + 1) * bucket);
      for (let j = i * bucket; j < end; j++) {
        const v = data[j] < 0 ? -data[j] : data[j];
        if (v > max) max = v;
      }
      if (max > peaks[i]) peaks[i] = max;
    }
  }
  return peaks;
}

function makeThumb(source, w, h) {
  const H = 72;
  const W = Math.max(1, Math.round(H * (w / h || 16 / 9)));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  try { c.getContext('2d').drawImage(source, 0, 0, W, H); } catch { /* 跨來源或尚未解碼 */ }
  return c;
}
