// 時間工具：時間軸內部一律以「秒」為單位（浮點數）

export const DEFAULT_FPS = 30;

/** 對齊到最近的影格 */
export function quantize(t, fps = DEFAULT_FPS) {
  return Math.round(t * fps) / fps;
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/** 00:01:23:15（時:分:秒:格） */
export function formatTimecode(t, fps = DEFAULT_FPS) {
  const totalFrames = Math.max(0, Math.round(t * fps));
  const frames = totalFrames % fps;
  const totalSec = Math.floor(totalFrames / fps);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return [h, m, s, frames].map(n => String(n).padStart(2, '0')).join(':');
}

/** 1:23、12:05、1:02:03（素材長度用） */
export function formatDuration(t) {
  if (!isFinite(t) || t < 0) return '--:--';
  const total = Math.round(t);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 時間尺標籤，依縮放決定精度 */
export function formatRulerLabel(t, step) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (step < 1) return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  return `${m}:${String(Math.round(s)).padStart(2, '0')}`;
}

/** 依每秒像素數選擇時間尺的主刻度間距（秒），讓標籤間至少相隔 minPx */
export function rulerStep(pxPerSec, minPx = 80) {
  const steps = [1 / 30, 1 / 10, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find(s => s * pxPerSec >= minPx) ?? steps[steps.length - 1];
}
