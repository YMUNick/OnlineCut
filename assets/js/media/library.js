// 素材匯入與執行期資源：讀取長度/尺寸、縮圖膠卷、音訊波形、解碼後的音訊（匯出用）

import { uid } from '../core/project.js';
import { loadMediabunny, canStreamAudio } from '../engine/mb.js';
import { _t } from '../i18n.js';

export const VIDEO_EXTS = ['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ogv', '.avi'];
export const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.weba'];
export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg'];
const extRe = (list) => new RegExp(`(${list.map(e => e.replace('.', '\\.')).join('|')})$`, 'i');
const VIDEO_EXT = extRe(VIDEO_EXTS);
const AUDIO_EXT = extRe(AUDIO_EXTS);
const IMAGE_EXT = extRe(IMAGE_EXTS);

export const librarySettings = {
  // 超過這個大小就不把整個檔案讀進記憶體解碼聲音，改用串流（只解需要的部分）
  maxDecodeBytes: 400 * 1024 * 1024,
};

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
    const timer = setTimeout(() => { cleanup(); reject(friendly(_t('讀取逾時'))); }, timeoutMs);
    const onOk = () => { cleanup(); resolve(); };
    const onFail = () => { cleanup(); reject(target.error || friendly(_t('無法讀取'))); };
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
  if (!type) throw friendly(_t('不支援的檔案類型：{name}', { name: file.name }));
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
      if (!(info.duration > 0)) throw friendly(_t('無法取得長度'));
      if (type === 'video') {
        info.width = el.videoWidth;
        info.height = el.videoHeight;
        if (!info.width || !info.height) throw friendly(_t('讀不到影片畫面（瀏覽器可能不支援這種編碼，可以先轉成 MP4 H.264 或 WebM）'));
      }
      el.removeAttribute('src');
      el.load();
    }
  } catch (e) {
    URL.revokeObjectURL(url);
    // 瀏覽器原本的錯誤訊息（例如 PipelineStatus::DEMUXER_ERROR…）使用者看不懂，換成白話
    const reason = e?.friendly ? e.message : _t('檔案損毀，或瀏覽器不支援這種格式');
    throw friendly(_t('{name}：{reason}', { name: file.name, reason }));
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
    // hasAudio：true / false / undefined（還不知道）
    const item = { info, file, url: url || URL.createObjectURL(file), image: null, thumbs: [], peaks: null, peaksPerSec: 0, audioBuffer: null, hasAudio: info.type === 'image' ? false : undefined };
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

  /**
   * 把整個檔案讀進記憶體解碼聲音（只用在不大的檔案）。
   * 檔案太大回傳 null，但「沒有聲音」要由 hasAudio 判斷，不能用這裡的結果。
   */
  async decodeAudio(id) {
    const item = this.items.get(id);
    if (!item || item.info.type === 'image') return null;
    if (item.audioBuffer !== null) return item.audioBuffer || null;
    if (item.decoding) return item.decoding;
    if (item.file.size > librarySettings.maxDecodeBytes) return null;
    item.decoding = (async () => {
      try {
        const audio = await this.ctx().decodeAudioData(await item.file.arrayBuffer());
        item.audioBuffer = audio;
        item.hasAudio = true;
        return audio;
      } catch {
        item.audioBuffer = false; // 沒有音軌，或瀏覽器的 decodeAudioData 不支援這種編碼
        return null;
      } finally {
        item.decoding = null;
      }
    })();
    return item.decoding;
  }

  async buildPeaks(item) {
    const audio = await this.decodeAudio(item.info.id);
    if (audio) {
      item.peaksPerSec = 100;
      item.peaks = computePeaks(audio, item.peaksPerSec);
      // 影片的音訊只在匯出時需要，先釋放記憶體，需要時再解碼
      if (item.info.type === 'video' && audio.length * audio.numberOfChannels > 48000 * 2 * 120) item.audioBuffer = null;
    } else {
      // 大檔案、或 decodeAudioData 不支援：用串流方式邊解碼邊算波形
      await this.streamPeaks(item);
    }
    this.emit(item.info.id);
  }

  /** 串流計算波形：一次只處理一小段，不會把整個檔案讀進記憶體 */
  async streamPeaks(item) {
    if (!canStreamAudio()) {
      if (item.audioBuffer === false) item.hasAudio = false;
      return;
    }
    try {
      const mb = await loadMediabunny();
      const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(item.file) });
      try {
        const track = await input.getPrimaryAudioTrack();
        if (!track) { item.hasAudio = false; return; }
        item.hasAudio = true;
        if (!(await track.canDecode())) return;
        const perSec = 100;
        const peaks = new Float32Array(Math.ceil((item.info.duration || 1) * perSec) + 1);
        item.peaksPerSec = perSec;
        let lastEmit = performance.now();
        for await (const { buffer, timestamp } of new mb.AudioBufferSink(track).buffers()) {
          if (!this.items.has(item.info.id)) return; // 素材已經移除
          const rate = buffer.sampleRate;
          for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const data = buffer.getChannelData(ch);
            for (let i = 0; i < data.length; i++) {
              const k = Math.floor((timestamp + i / rate) * perSec);
              const v = data[i] < 0 ? -data[i] : data[i];
              if (k >= 0 && k < peaks.length && v > peaks[k]) peaks[k] = v;
            }
          }
          // 每隔一段時間更新畫面，長檔案也能看到波形逐漸出現
          if (performance.now() - lastEmit > 500) {
            item.peaks = peaks;
            this.emit(item.info.id);
            lastEmit = performance.now();
          }
        }
        item.peaks = peaks;
      } finally {
        input.dispose?.();
      }
    } catch {
      /* 格式不支援串流解碼：沒有波形，匯出時會另外提示 */
    }
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
