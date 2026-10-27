// AI 字幕：把選定片段的聲音混成 16kHz 單聲道，分段送到語音辨識服務（OpenAI 相容的 /audio/transcriptions），
// 回傳時間軸時間的段落。聲音只會用使用者自己的 API Key 直接從瀏覽器送到他選的服務商。

import { clipEnd } from '../core/project.js';
import { encodeWav, findQuietCut, rms, cleanSegments, segmentsFromText } from '../core/captions.js';
import { AudioSources, mixChunks } from './audio.js';
import { _t } from '../i18n.js';

export const PROVIDERS = {
  openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'whisper-1', keyUrl: 'https://platform.openai.com/api-keys' },
  groq: { label: 'Groq', base: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', keyUrl: 'https://console.groq.com/keys' },
  custom: { label: _t('自訂'), base: '', model: 'whisper-1', keyUrl: null },
};

export const transcribeSettings = {
  sampleRate: 16000,
  uploadSeconds: 600,  // 每次上傳最長幾秒（16kHz WAV 10 分鐘約 19MB，低於常見的 25MB 上限）
  searchSeconds: 30,   // 在每段結尾前這麼多秒內找安靜的地方切
};

/** 中文時提示模型用繁體、全形標點 */
const PROMPTS = { zh: '以下是繁體中文的字幕，使用全形標點符號。' }; // i18n-ignore

export class TranscribeError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'TranscribeError'; this.status = status; }
}

function abortError() { return Object.assign(new Error(_t('已取消')), { name: 'AbortError' }); }

/** 只留下要辨識的片段，並且不管靜音、音量與淡入淡出（辨識要聽得清楚） */
export function speechProject(project, clipIds) {
  const ids = new Set(clipIds);
  return {
    ...project,
    tracks: project.tracks.map(t => ({ ...t, muted: false })),
    clips: project.clips.filter(c => ids.has(c.id) && (c.type === 'video' || c.type === 'audio'))
      .map(c => ({ ...c, muted: false, volume: 1, fadeIn: 0, fadeOut: 0, audioFades: null })),
  };
}

async function postAudio({ base, apiKey, model, language, prompt, wav, format, signal }) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model);
  form.append('response_format', format);
  form.append('temperature', '0');
  if (format === 'verbose_json') form.append('timestamp_granularities[]', 'segment');
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt);
  let res;
  try {
    res = await fetch(`${base.replace(/\/+$/, '')}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new TranscribeError(_t('連不上語音辨識服務，請檢查網路與 API 網址。'));
  }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j?.error?.message || j?.message || ''; } catch { /* 不是 JSON */ }
    throw new TranscribeError(detail, res.status);
  }
  return res.json();
}

function friendlyError(e) {
  if (!(e instanceof TranscribeError) || !e.status) return e;
  const msg = {
    401: _t('API Key 不正確或已失效。'),
    403: _t('這個 API Key 沒有使用語音辨識的權限。'),
    404: _t('找不到語音辨識服務，請檢查 API 網址與模型名稱。'),
    413: _t('聲音檔太大，服務商拒絕了。'),
    429: _t('使用量超過限制或額度不足，請稍後再試或檢查帳戶餘額。'),
  }[e.status] || _t('語音辨識失敗（{status}）', { status: e.status });
  return new TranscribeError(e.message && e.message !== msg ? `${msg} ${e.message}` : msg, e.status);
}

/** 送出一段聲音，回傳這段裡的段落（時間從 0 算） */
async function transcribeChunk(samples, opts) {
  const wav = encodeWav(samples, transcribeSettings.sampleRate);
  const duration = samples.length / transcribeSettings.sampleRate;
  try {
    const r = await postAudio({ ...opts, wav, format: 'verbose_json' });
    if (Array.isArray(r?.segments)) return { segments: cleanSegments(r.segments), text: r.text || '' };
    return { segments: segmentsFromText(r?.text, 0, duration), text: r?.text || '' };
  } catch (e) {
    // 有些模型（例如 gpt-4o-transcribe）不支援帶時間的格式：改要純文字，再依字數分配時間
    if (e instanceof TranscribeError && e.status === 400 && /response_format|verbose_json|timestamp/i.test(e.message)) {
      const r = await postAudio({ ...opts, wav, format: 'json' });
      return { segments: segmentsFromText(r?.text, 0, duration), text: r?.text || '' };
    }
    throw friendlyError(e);
  }
}

/** 片段範圍內實際有幾秒聲音（給對話框估算用） */
export function speechRange(project, clipIds) {
  const clips = speechProject(project, clipIds).clips;
  if (!clips.length) return null;
  return [Math.min(...clips.map(c => c.start)), Math.max(...clips.map(c => clipEnd(c)))];
}

/**
 * 辨識指定片段的聲音。回傳 [{ start, end, text }]（時間軸時間）。
 * onProgress({ stage: 'mix' | 'upload', done, total })
 */
export async function transcribe({ project, runtime, clipIds, base, apiKey, model, language = '', onProgress = () => {}, signal }) {
  const range = speechRange(project, clipIds);
  if (!range) throw new TranscribeError(_t('沒有可以辨識的聲音。'));
  const [a, b] = range;
  const rate = transcribeSettings.sampleRate;
  const maxLen = Math.round(transcribeSettings.uploadSeconds * rate);
  const search = Math.round(Math.min(transcribeSettings.searchSeconds, transcribeSettings.uploadSeconds / 3) * rate);
  const totalParts = Math.max(1, Math.ceil((b - a) / transcribeSettings.uploadSeconds));
  const sub = speechProject(project, clipIds);
  const sources = new AudioSources(runtime);
  const segments = [];
  let pending = new Float32Array(0);
  let pendingStart = a; // pending 第一個樣本的時間軸時間
  let part = 0;
  let prevText = '';
  let heard = false;
  let unreadable = null;

  const send = async (n) => {
    const chunk = pending.subarray(0, n);
    const start = pendingStart;
    pending = pending.slice(n);
    pendingStart += n / rate;
    part++;
    if (rms(chunk) < 1e-4) return; // 完全安靜：不用花錢辨識
    heard = true;
    onProgress({ stage: 'upload', done: part - 1, total: Math.max(totalParts, part) });
    const prompt = [PROMPTS[language] || '', prevText.slice(-120)].filter(Boolean).join(' ');
    const r = await transcribeChunk(chunk, { base, apiKey, model, language, prompt, signal });
    prevText = r.text || prevText;
    for (const s of r.segments) segments.push({ start: start + s.start, end: start + Math.min(s.end, chunk.length / rate), text: s.text.trim() });
  };

  try {
    for await (const piece of mixChunks(sub, sources, b, { sampleRate: rate, channels: 1, start: a, signal, onWarning: (id, reason) => { unreadable = reason; } })) {
      if (signal?.aborted) throw abortError();
      const data = piece.buffer.getChannelData(0);
      const next = new Float32Array(pending.length + data.length);
      next.set(pending);
      next.set(data, pending.length);
      pending = next;
      onProgress({ stage: 'mix', done: piece.end - a, total: b - a });
      while (pending.length > maxLen) await send(findQuietCut(pending, rate, maxLen - search, maxLen));
    }
    if (pending.length) await send(pending.length);
  } finally {
    sources.dispose();
  }
  if (!heard) throw new TranscribeError(unreadable ? _t('讀不到聲音：{reason}', { reason: unreadable }) : _t('選取的範圍裡沒有聲音。'));
  onProgress({ stage: 'upload', done: part, total: part });
  return segments.sort((x, y) => x.start - y.start);
}
