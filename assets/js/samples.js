// 範例素材：在瀏覽器裡即時產生（漸層插圖 + 合成音樂），不需要下載任何東西

const SCENES = [
  { name: '範例-晨光.png', stops: ['#ff9a5a', '#ff5c39', '#5b2a86'], sun: '#ffe2a8', hills: ['#3a1f5c', '#24123d'] },
  { name: '範例-海岸.png', stops: ['#7fd3ff', '#2f7de1', '#0c2a5b'], sun: '#ffffff', hills: ['#0f3b6e', '#082245'] },
  { name: '範例-夜城.png', stops: ['#1b1440', '#3b1d6e', '#ff5c8a'], sun: '#ffd6f0', hills: ['#140d2c', '#0a0618'] },
];

function sceneBlob({ stops, sun, hills }, w = 1920, h = 1080) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, h);
  stops.forEach((s, i) => sky.addColorStop(i / (stops.length - 1), s));
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  // 太陽 / 月亮
  const sg = g.createRadialGradient(w * 0.68, h * 0.42, 10, w * 0.68, h * 0.42, h * 0.32);
  sg.addColorStop(0, sun);
  sg.addColorStop(0.35, sun + 'cc');
  sg.addColorStop(1, 'transparent');
  g.fillStyle = sg;
  g.fillRect(0, 0, w, h);
  // 兩層山
  hills.forEach((col, layer) => {
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(0, h);
    const base = h * (0.68 + layer * 0.1);
    for (let x = 0; x <= w; x += 20) {
      const y = base - Math.sin(x / (260 - layer * 70) + layer * 2) * (70 - layer * 20) - Math.sin(x / 90 + layer) * 12;
      g.lineTo(x, y);
    }
    g.lineTo(w, h);
    g.closePath();
    g.fill();
  });
  // 一點顆粒感
  g.globalAlpha = 0.05;
  for (let i = 0; i < 3500; i++) {
    g.fillStyle = Math.random() > 0.5 ? '#fff' : '#000';
    g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
  return new Promise(r => c.toBlob(r, 'image/png'));
}

/** 簡單的合成音樂（和弦琶音），輸出 WAV */
function musicBlob(seconds = 12, rate = 44100) {
  const n = Math.floor(seconds * rate);
  const L = new Float32Array(n), R = new Float32Array(n);
  const bpm = 100, beat = 60 / bpm;
  const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
  const freq = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const notes = [];
  for (let bar = 0; bar * beat * 4 < seconds; bar++) {
    const ch = chords[bar % chords.length];
    for (let i = 0; i < 8; i++) {
      const t = (bar * 4 + i * 0.5) * beat;
      notes.push({ t, f: freq(ch[i % 3] + (i >= 3 && i < 6 ? 12 : 0)), d: beat * 0.9, v: 0.16, pan: (i % 3 - 1) * 0.5 });
    }
    notes.push({ t: bar * 4 * beat, f: freq(ch[0] - 12), d: beat * 3.8, v: 0.22, pan: 0 });
  }
  for (const nt of notes) {
    const s0 = Math.floor(nt.t * rate), len = Math.floor(nt.d * rate);
    for (let i = 0; i < len && s0 + i < n; i++) {
      const tt = i / rate;
      const env = Math.min(1, tt * 60) * Math.exp(-tt * 3.2);
      const v = (Math.sin(2 * Math.PI * nt.f * tt) + 0.3 * Math.sin(4 * Math.PI * nt.f * tt)) * env * nt.v;
      L[s0 + i] += v * (1 - Math.max(0, nt.pan));
      R[s0 + i] += v * (1 + Math.min(0, nt.pan));
    }
  }
  // 16-bit PCM WAV
  const buf = new ArrayBuffer(44 + n * 4);
  const dv = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => dv.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    dv.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 0x7fff, true);
    dv.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** 回傳 File 陣列與一個「怎麼排」的說明 */
export async function makeSampleFiles() {
  const images = await Promise.all(SCENES.map(async s => new File([await sceneBlob(s)], s.name, { type: 'image/png' })));
  const music = new File([musicBlob(12)], '範例-配樂.wav', { type: 'audio/wav' });
  return { images, music };
}
