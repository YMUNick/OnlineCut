// mediabunny 約 700KB，只在需要時（匯出、大檔案的波形）才載入
let mbPromise = null;

export function loadMediabunny() {
  if (!mbPromise) mbPromise = import('../../vendor/mediabunny.min.mjs').catch((e) => { mbPromise = null; throw e; });
  return mbPromise;
}

/** 有沒有 WebCodecs 音訊解碼（mediabunny 解碼聲音需要） */
export const canStreamAudio = () => typeof AudioDecoder !== 'undefined';
