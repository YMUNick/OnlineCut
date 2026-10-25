// 右側屬性面板：專案設定 / 片段屬性

import { updateClip, renameProject, setAspect, ASPECT_PRESETS, getDuration, clipEnd, canFrame, canFlip, MIN_FRAME, audioFadesOf, TEXT_DECO_IDS, counterTarget } from '../core/project.js';
import { formatTimecode, formatDuration, clamp } from '../core/time.js';
import { icon } from './icons.js';
import { escapeHtml } from './dialogs.js';
import { formatBytes } from './media-panel.js';
import { _t } from '../i18n.js';
import { FONTS, ensureFont } from './fonts.js';
import { TRANSITION_TYPES, DEFAULT_TRANSITION, MIN_TRANSITION, MAX_TRANSITION, prevAdjacent, effectiveTransition } from '../core/transitions.js';
import { TRANSITION_LABELS } from './transitions-panel.js';

const TYPE_LABEL = { video: _t('影片片段'), image: _t('圖片片段'), text: _t('文字片段'), audio: _t('音訊片段') };
export const DECO_LABELS = {
  burst: _t('爆炸標'), bubble: _t('對話框'), pill: _t('膠囊按鈕'), ribbon: _t('絲帶'), lower: _t('字幕條'),
  badge: _t('圓章'), note: _t('便利貼'), marker: _t('螢光筆'), tag: _t('價格標籤'),
  cloud: _t('思考泡泡'), shout: _t('大喊框'), stamp: _t('印章'), tape: _t('紙膠帶'),
  neon: _t('霓虹燈牌'), arrow: _t('指示牌'), quote: _t('金句框'), caution: _t('警示牌'),
};
const FILTER_PRESETS = [
  [_t('原始'), { brightness: 100, contrast: 100, saturation: 100, grayscale: 0, blur: 0 }],
  [_t('鮮豔'), { brightness: 104, contrast: 112, saturation: 140, grayscale: 0, blur: 0 }],
  [_t('柔和'), { brightness: 108, contrast: 88, saturation: 82, grayscale: 0, blur: 0 }],
  [_t('高對比'), { brightness: 100, contrast: 145, saturation: 105, grayscale: 0, blur: 0 }],
  [_t('黑白'), { brightness: 100, contrast: 118, saturation: 100, grayscale: 100, blur: 0 }],
  [_t('夢幻'), { brightness: 112, contrast: 92, saturation: 120, grayscale: 0, blur: 1.5 }],
];

export function parseColor(str) {
  if (!str) return { hex: '#000000', alpha: 0 };
  const m = String(str).match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/i);
  if (m) {
    const hex = '#' + [m[1], m[2], m[3]].map(n => clamp(+n, 0, 255).toString(16).padStart(2, '0')).join('');
    return { hex, alpha: m[4] == null ? 1 : clamp(+m[4], 0, 1) };
  }
  if (/^#[0-9a-f]{6}$/i.test(str)) return { hex: str.toLowerCase(), alpha: 1 };
  if (/^#[0-9a-f]{3}$/i.test(str)) return { hex: '#' + str.slice(1).split('').map(c => c + c).join('').toLowerCase(), alpha: 1 };
  return { hex: '#000000', alpha: 1 };
}

export function toRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.round(alpha * 100) / 100})`;
}

export class Inspector {
  constructor({ store, runtime, els, actions }) {
    this.store = store;
    this.runtime = runtime;
    this.els = els;
    this.actions = actions; // { split, duplicate, remove, storageInfo }
    this.bindings = [];
    this.renderedFor = null;
  }

  /** 選取改變時重建；其他變動只更新數值，避免打斷正在操作的控制項 */
  update(force = false) {
    const sel = this.store.selection;
    // 套用 / 取消版型會換掉整個區塊，所以也算進 key
    const key = sel.length === 1 ? `${sel[0]}${this.store.selectedClip?.frame ? ':framed' : ''}` : sel.length > 1 ? `multi:${sel.length}` : 'project';
    if (force || key !== this.renderedFor) {
      this.renderedFor = key;
      this.build();
    } else {
      this.refresh();
    }
  }

  commit(fn, key) {
    const clip = this.store.selectedClip;
    if (!clip) return;
    this.store.commit(updateClip(this.store.project, clip.id, fn(clip)), { key: `insp-${clip.id}-${key}` });
  }

  refresh() {
    const clip = this.store.selectedClip;
    for (const b of this.bindings) {
      if (b.el === document.activeElement && b.el.type !== 'range') continue;
      b.sync(clip, this.store.project);
    }
  }

  build() {
    const box = this.els.inspector;
    box.innerHTML = '';
    this.bindings = [];
    const sel = this.store.selection;
    if (sel.length > 1) return this.buildMulti(sel.length);
    const clip = this.store.selectedClip;
    if (!clip) return this.buildProject();
    this.els.title.textContent = TYPE_LABEL[clip.type];

    const p = this.store.project;
    const timing = this.section(_t('時間'));
    const kv = document.createElement('dl');
    kv.className = 'kv';
    timing.appendChild(kv);
    this.bind(kv, (c) => {
      const rows = [[_t('開始'), formatTimecode(c.start, p.fps)], [_t('結束'), formatTimecode(clipEnd(c), p.fps)], [_t('長度'), formatTimecode(c.duration, p.fps)]];
      if (c.type === 'video' || c.type === 'audio') rows.push([_t('素材入點'), formatTimecode(c.srcIn, p.fps)]);
      if (c.mediaId && p.media[c.mediaId]) rows.push([_t('來源'), p.media[c.mediaId].name]);
      kv.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd title="${escapeHtml(v)}">${escapeHtml(v)}</dd>`).join('');
    });
    const acts = document.createElement('div');
    acts.className = 'insp-actions';
    acts.style.marginTop = '12px';
    acts.innerHTML = `
      <button class="ghost-btn" data-a="split">${icon('split', 'icon-sm')}${_t('分割')}</button>
      <button class="ghost-btn" data-a="duplicate">${icon('copy', 'icon-sm')}${_t('複製')}</button>
      <button class="ghost-btn" data-a="remove">${icon('trash', 'icon-sm')}${_t('刪除')}</button>`;
    acts.addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a) this.actions[a](); });
    timing.appendChild(acts);

    if (clip.type === 'text') this.buildText();
    if (clip.frame) this.buildFrame();
    else if (clip.type !== 'audio') this.buildTransform();
    this.buildAppearance(clip);
    if (clip.type === 'video' || clip.type === 'image') this.buildTransition();
    if (clip.type === 'video' || clip.type === 'image') this.buildFilters();
    if (clip.type === 'video' || clip.type === 'audio') this.buildAudio(clip);
    this.refresh();
  }

  buildMulti(n) {
    this.els.title.textContent = _t('已選取 {n} 個片段', { n });
    const s = this.section(_t('多選'));
    s.insertAdjacentHTML('beforeend', `<p class="hint-line" style="margin-top:0">${_t('一起拖曳可以同時移動。按 Delete 全部刪除，Shift + 點擊可加選或取消。')}</p>
      <div class="insp-actions" style="margin-top:12px"><button class="ghost-btn" data-a="remove">${icon('trash', 'icon-sm')}${_t('全部刪除')}</button></div>`);
    s.querySelector('[data-a]').onclick = () => this.actions.remove();
  }

  buildProject() {
    this.els.title.textContent = _t('專案設定');
    const p = this.store.project;
    const s1 = this.section(_t('專案'));
    const name = document.createElement('input');
    name.className = 'text-input';
    name.maxLength = 120;
    name.setAttribute('aria-label', _t('專案名稱'));
    name.addEventListener('input', () => this.store.commit(renameProject(this.store.project, name.value), { key: 'rename' }));
    this.bind(name, (_, proj) => { name.value = proj.name; });
    s1.appendChild(this.row(_t('名稱'), name, true));

    const s2 = this.section(_t('畫面比例'));
    const grid = document.createElement('div');
    grid.className = 'aspect-grid';
    for (const [key, a] of Object.entries(ASPECT_PRESETS)) {
      const b = document.createElement('button');
      b.className = 'aspect-opt';
      const r = a.width / a.height;
      const w = r >= 1 ? 26 : Math.round(26 * r), h = r >= 1 ? Math.round(26 / r) : 26;
      b.innerHTML = `<i style="width:${w}px;height:${h}px"></i><b>${a.label}</b><small>${a.hint} · ${a.width}×${a.height}</small>`;
      b.onclick = () => this.store.commit(setAspect(this.store.project, key));
      this.bind(b, (_, proj) => b.classList.toggle('on', proj.aspect === key));
      grid.appendChild(b);
    }
    s2.appendChild(grid);

    const bg = this.colorInput((v) => this.store.commit({ ...this.store.project, background: v }, { key: 'bg' }));
    this.bind(bg.input, (_, proj) => bg.set(proj.background || '#000000'));
    const s3 = this.section(_t('背景'));
    s3.appendChild(this.row(_t('背景色'), bg.el, true));
    s3.insertAdjacentHTML('beforeend', `<p class="hint-line">${_t('素材沒有填滿畫面時看到的顏色。')}</p>`);

    const s4 = this.section(_t('概況'));
    const kv = document.createElement('dl');
    kv.className = 'kv';
    s4.appendChild(kv);
    const fill = async (proj) => {
      const rows = [
        [_t('總長度'), formatDuration(getDuration(proj))],
        [_t('片段'), _t('{n} 個', { n: proj.clips.length })],
        [_t('素材'), _t('{n} 個', { n: Object.keys(proj.media).length })],
        [_t('解析度'), `${proj.width}×${proj.height} · ${proj.fps} fps`],
      ];
      kv.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
      const est = await this.actions.storageInfo?.();
      if (est && kv.isConnected) kv.insertAdjacentHTML('beforeend', `<dt>${_t('本機儲存')}</dt><dd>${formatBytes(est.usage)} / ${formatBytes(est.quota)}</dd>`);
    };
    this.bind(kv, (_, proj) => fill(proj));

    const s5 = this.section(_t('小技巧'));
    const tips = [
      _t('按 <kbd>S</kbd> 在播放頭分割，<kbd>Shift</kbd> + <kbd>Delete</kbd> 刪除後自動補位。'),
      _t('拖曳時按住 <kbd>Alt</kbd> 可暫時關閉吸附。'),
      _t('在預覽畫面上可以直接拖曳、縮放、旋轉圖層。'),
      _t('專案會自動存在這台裝置的瀏覽器裡。'),
    ];
    s5.insertAdjacentHTML('beforeend', `<ul class="hint-line" style="padding-left:18px;margin:0;display:grid;gap:6px">${tips.map(x => `<li>${x}</li>`).join('')}</ul>`);
    this.refresh();
  }

  // ---------- 各區塊 ----------
  buildText() {
    const s = this.section(_t('文字'));
    const ta = document.createElement('textarea');
    ta.className = 'textarea';
    ta.setAttribute('aria-label', _t('文字內容'));
    ta.placeholder = _t('輸入文字，Enter 換行');
    ta.addEventListener('input', () => this.commit(() => ({ text: { content: ta.value } }), 'content'));
    this.bind(ta, (c) => { ta.value = c.text.content; });
    s.appendChild(ta);

    const font = document.createElement('select');
    font.className = 'select';
    font.innerHTML = FONTS.map(f => `<option value="${f.family}">${f.label}</option>`).join('');
    font.onchange = () => { ensureFont(font.value, this.store.selectedClip?.text?.content); this.commit(() => ({ text: { fontFamily: font.value } }), 'font'); };
    this.bind(font, (c) => { font.value = c.text.fontFamily; });
    const fontRow = this.row(_t('字型'), font, true);
    fontRow.style.marginTop = '12px';
    s.appendChild(fontRow);

    s.appendChild(this.slider(_t('字級'), { min: 12, max: 400, step: 1, unit: 'px', get: c => c.text.fontSize, set: v => ({ text: { fontSize: v } }), key: 'size' }));

    const weight = this.seg([['400', _t('一般')], ['700', _t('粗')], ['900', _t('特粗')]], (v) => this.commit(() => ({ text: { fontWeight: +v } }), 'weight'), (c) => String(c.text.fontWeight));
    s.appendChild(this.row(_t('粗細'), weight, true));

    const style = this.seg([['left', icon('alignLeft')], ['center', icon('alignCenter')], ['right', icon('alignRight')]],
      (v) => this.commit(() => ({ text: { align: v } }), 'align'), (c) => c.text.align, true);
    const ital = document.createElement('button');
    ital.className = 'seg-btn';
    ital.innerHTML = icon('italic');
    ital.title = _t('斜體');
    ital.onclick = () => this.commit(c => ({ text: { italic: !c.text.italic } }), 'italic');
    this.bind(ital, c => ital.classList.toggle('on', !!c.text.italic));
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:8px';
    const italSeg = document.createElement('div');
    italSeg.className = 'seg';
    italSeg.appendChild(ital);
    wrap.append(style, italSeg);
    s.appendChild(this.row(_t('對齊'), wrap, true));

    const color = this.colorInput(v => this.commit(() => ({ text: { color: v } }), 'color'));
    this.bind(color.input, c => color.set(parseColor(c.text.color).hex));
    s.appendChild(this.row(_t('顏色'), color.el, true));

    // 背景框
    const bgOn = document.createElement('input');
    bgOn.type = 'checkbox';
    const bgColor = this.colorInput(v => this.commit(c => ({ text: { background: toRgba(v, parseColor(c.text.background).alpha || 0.6) } }), 'bg'));
    const bgWrap = document.createElement('div');
    bgWrap.style.cssText = 'display:flex;align-items:center;gap:10px';
    const lbl = document.createElement('label');
    lbl.className = 'check';
    lbl.append(bgOn, document.createTextNode(_t('顯示')));
    bgWrap.append(lbl, bgColor.el);
    bgOn.onchange = () => this.commit(() => ({ text: { background: bgOn.checked ? toRgba(bgColor.input.value || '#000000', 0.6) : '' } }), 'bgOn');
    this.bind(bgOn, c => { bgOn.checked = !!c.text.background; bgColor.set(parseColor(c.text.background).hex); bgColor.input.disabled = !c.text.background; });
    s.appendChild(this.row(_t('背景框'), bgWrap, true));
    s.appendChild(this.slider(_t('背景透明'), {
      min: 0, max: 100, step: 1, unit: '%',
      get: c => Math.round(parseColor(c.text.background).alpha * 100),
      set: (v, c) => ({ text: { background: c.text.background ? toRgba(parseColor(c.text.background).hex, v / 100) : '' } }),
      key: 'bgAlpha', disabled: c => !c.text.background,
    }));

    s.appendChild(this.slider(_t('描邊'), { min: 0, max: 24, step: 1, unit: 'px', get: c => c.text.strokeWidth, set: v => ({ text: { strokeWidth: v } }), key: 'stroke' }));
    const sc = this.colorInput(v => this.commit(() => ({ text: { strokeColor: v } }), 'strokeColor'));
    this.bind(sc.input, c => sc.set(parseColor(c.text.strokeColor).hex));
    const shadow = document.createElement('input');
    shadow.type = 'checkbox';
    shadow.onchange = () => this.commit(() => ({ text: { shadow: shadow.checked } }), 'shadow');
    this.bind(shadow, c => { shadow.checked = !!c.text.shadow; });
    const shLbl = document.createElement('label');
    shLbl.className = 'check';
    shLbl.append(shadow, document.createTextNode(_t('陰影')));
    const sw = document.createElement('div');
    sw.style.cssText = 'display:flex;align-items:center;gap:14px';
    sw.append(sc.el, shLbl);
    s.appendChild(this.row(_t('描邊色'), sw, true));

    // 發光（霓虹字）
    const glowOn = document.createElement('input');
    glowOn.type = 'checkbox';
    const glowColor = this.colorInput(v => this.commit(() => ({ text: { glow: v } }), 'glow'));
    glowOn.onchange = () => this.commit(() => ({ text: { glow: glowOn.checked ? (glowColor.input.value !== '#000000' ? glowColor.input.value : '#ff4fd8') : '' } }), 'glowOn');
    this.bind(glowOn, c => { glowOn.checked = !!c.text.glow; glowColor.set(c.text.glow ? parseColor(c.text.glow).hex : '#ff4fd8'); glowColor.input.disabled = !c.text.glow; });
    const gl = document.createElement('label');
    gl.className = 'check';
    gl.append(glowOn, document.createTextNode(_t('顯示')));
    const gw = document.createElement('div');
    gw.style.cssText = 'display:flex;align-items:center;gap:10px';
    gw.append(gl, glowColor.el);
    s.appendChild(this.row(_t('發光'), gw, true));

    // 數字動畫：從起始數字滾到文字裡的數字（倒數 / 跳分數）
    const cOn = document.createElement('input');
    cOn.type = 'checkbox';
    cOn.onchange = () => this.commit(c => ({
      text: { counter: cOn.checked ? { from: (counterTarget(c.text.content) ?? 0) + 20, duration: Math.max(0.5, Math.min(3, c.duration)), ease: 'out' } : null },
    }), 'counterOn');
    this.bind(cOn, c => { cOn.checked = !!c.text.counter; });
    const cl = document.createElement('label');
    cl.className = 'check';
    cl.append(cOn, document.createTextNode(_t('數字滾動到文字裡的數字')));
    s.appendChild(this.row(_t('數字動畫'), cl, true));
    const fromIn = document.createElement('input');
    fromIn.className = 'text-input';
    fromIn.inputMode = 'decimal';
    fromIn.setAttribute('aria-label', _t('起始數字'));
    fromIn.addEventListener('change', () => {
      const v = parseFloat(fromIn.value.replace(/,/g, ''));
      if (isFinite(v)) this.commit(c => ({ text: { counter: { ...c.text.counter, from: v } } }), 'counterFrom');
    });
    fromIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') fromIn.blur(); });
    const fromRow = this.row(_t('起始數字'), fromIn, true);
    this.bind(fromIn, c => { fromRow.hidden = !c.text.counter; if (c.text.counter && document.activeElement !== fromIn) fromIn.value = c.text.counter.from; });
    s.appendChild(fromRow);
    const durRow = this.slider(_t('動畫長度'), {
      min: 0.5, max: (c) => Math.max(0.5, Math.min(10, c.duration)), step: 0.1, unit: 's', decimals: 1, key: 'counterDur', hardMax: 600,
      get: c => c.text.counter?.duration ?? 3, set: (v, c) => ({ text: { counter: { ...c.text.counter, duration: v } } }),
    });
    this.bind(durRow, c => { durRow.hidden = !c.text.counter; });
    s.appendChild(durRow);
    const ease = this.seg([['out', _t('越接近越慢')], ['linear', _t('等速')]], (v) => this.commit(c => ({ text: { counter: { ...c.text.counter, ease: v } } }), 'counterEase'), c => c.text.counter?.ease);
    const easeRow = this.row(_t('速度'), ease, true);
    this.bind(easeRow, c => { easeRow.hidden = !c.text.counter; });
    s.appendChild(easeRow);
    const cHint = document.createElement('p');
    cHint.className = 'hint-line';
    this.bind(cHint, c => {
      cHint.hidden = !c.text.counter;
      if (!c.text.counter) return;
      const target = counterTarget(c.text.content);
      cHint.textContent = target == null
        ? _t('文字裡要有數字，例如「2132」或「NT$ 1,200」。')
        : _t('片段開始後 {sec} 秒內從 {from} 跑到 {to}。', { sec: c.text.counter.duration.toFixed(1), from: c.text.counter.from, to: target });
    });
    s.appendChild(cHint);

    // 外框造型（爆炸標、對話框…）：造型跟著文字大小變化
    const deco = document.createElement('select');
    deco.className = 'select';
    deco.innerHTML = [['', _t('無')], ...TEXT_DECO_IDS.map(id => [id, DECO_LABELS[id]])].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    deco.onchange = () => this.commit(() => ({ text: { deco: deco.value } }), 'deco');
    this.bind(deco, c => { deco.value = c.text.deco || ''; });
    s.appendChild(this.row(_t('外框造型'), deco, true));
    const keepAlpha = (v, old) => { const a = parseColor(old).alpha; return a < 1 ? toRgba(v, a) : v; };
    const d1 = this.colorInput(v => this.commit(c => ({ text: { decoColor: keepAlpha(v, c.text.decoColor) } }), 'decoColor'));
    const d2 = this.colorInput(v => this.commit(c => ({ text: { decoColor2: keepAlpha(v, c.text.decoColor2) } }), 'decoColor2'));
    const dw = document.createElement('div');
    dw.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap';
    dw.append(d1.el, d2.el);
    const decoColors = this.row(_t('造型顏色'), dw, true);
    this.bind(dw, c => {
      decoColors.hidden = !c.text.deco;
      d1.set(parseColor(c.text.decoColor).hex);
      d2.set(parseColor(c.text.decoColor2).hex);
    });
    s.appendChild(decoColors);
    s.insertAdjacentHTML('beforeend', `<p class="hint-line">${_t('在預覽畫面上點兩下文字，就能直接修改內容與字型。')}</p>`);
  }

  buildTransform() {
    const p = () => this.store.project;
    const s = this.section(_t('位置與大小'), `<button class="link-btn" data-reset>${icon('reset', 'icon-sm')}${_t('重設')}</button>`);
    // 重設連翻轉一起取消（完整顯示、填滿、取消版型則保留翻轉）
    s.querySelector('[data-reset]').onclick = () => this.commit(() => ({ transform: { x: 0, y: 0, scale: 1, rotation: 0, flipX: false, flipY: false } }), 'reset');
    s.appendChild(this.slider(_t('水平'), { min: () => -p().width, max: () => p().width, step: 1, unit: 'px', get: c => Math.round(c.transform.x), set: v => ({ transform: { x: v } }), key: 'x', hardMin: -1e5, hardMax: 1e5 }));
    s.appendChild(this.slider(_t('垂直'), { min: () => -p().height, max: () => p().height, step: 1, unit: 'px', get: c => Math.round(c.transform.y), set: v => ({ transform: { y: v } }), key: 'y', hardMin: -1e5, hardMax: 1e5 }));
    s.appendChild(this.slider(_t('縮放'), { min: 5, max: 400, step: 1, unit: '%', get: c => Math.round(c.transform.scale * 100), set: v => ({ transform: { scale: v / 100 } }), key: 'scale', hardMax: 1000 }));
    s.appendChild(this.slider(_t('旋轉'), { min: -180, max: 180, step: 1, unit: '°', get: c => Math.round(c.transform.rotation), set: v => ({ transform: { rotation: v } }), key: 'rot' }));
    if (canFlip(this.store.selectedClip)) s.appendChild(this.flipRow());
    const acts = document.createElement('div');
    acts.className = 'chip-row';
    acts.style.marginTop = '4px';
    acts.innerHTML = `<button class="chip" data-a="center">${_t('置中')}</button><button class="chip" data-a="fit">${_t('完整顯示')}</button><button class="chip" data-a="fill">${_t('填滿畫面')}</button>`;
    acts.onclick = (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      const proj = p();
      this.commit((c) => {
        if (a === 'center') return { transform: { x: 0, y: 0 } };
        if (a === 'fit') return { transform: { x: 0, y: 0, scale: 1, rotation: 0 } };
        const m = proj.media[c.mediaId];
        if (!m?.width) return { transform: { x: 0, y: 0 } };
        const contain = Math.min(proj.width / m.width, proj.height / m.height);
        const cover = Math.max(proj.width / m.width, proj.height / m.height);
        return { transform: { x: 0, y: 0, scale: cover / contain, rotation: 0 } };
      }, a);
    };
    const clip = this.store.selectedClip;
    if (clip?.type === 'text') acts.querySelectorAll('[data-a="fit"],[data-a="fill"]').forEach(b => b.remove());
    if (canFrame(clip)) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.innerHTML = _t('雙畫面版型…');
      b.title = _t('子母畫面、圓形小窗、分割畫面');
      b.onclick = (e) => { e.stopPropagation(); this.actions.showLayouts?.(); };
      acts.appendChild(b);
    }
    s.appendChild(acts);
  }

  /** 有畫面框（套用了版型）的片段：框的位置、形狀、邊框，以及框裡的取景 */
  buildFrame() {
    const p = () => this.store.project;
    const s = this.section(_t('畫面框'), `<button class="link-btn" data-unframe>${icon('close', 'icon-sm')}${_t('取消版型')}</button>`);
    s.querySelector('[data-unframe]').onclick = () => this.commit(() => ({ frame: null, transform: { x: 0, y: 0, scale: 1, rotation: 0 } }), 'unframe');
    const shape = this.seg([['rect', _t('方形')], ['round', _t('圓角')], ['circle', _t('圓形')]], (v) => this.commit((c) => {
      if (v !== 'circle') return { frame: { shape: v } };
      // 圓形：用寬高中比較短的一邊做成正圓，中心不動
      const f = c.frame, W = p().width, H = p().height;
      const d = Math.min(f.w * W, f.h * H);
      return { frame: { shape: v, x: f.x + f.w / 2 - d / W / 2, y: f.y + f.h / 2 - d / H / 2, w: d / W, h: d / H } };
    }, 'shape'), (c) => c.frame?.shape);
    s.appendChild(this.row(_t('形狀'), shape, true));
    const pct = (label, k, key, reset) => this.slider(label, {
      min: k === 'w' || k === 'h' ? MIN_FRAME * 100 : 0, max: 100, step: 0.5, unit: '%', decimals: 1, key, reset,
      get: c => (c.frame?.[k] ?? 0) * 100, set: v => ({ frame: { [k]: v / 100 } }), hardMin: k === 'w' || k === 'h' ? MIN_FRAME * 100 : -100, hardMax: 200,
    });
    s.appendChild(pct(_t('左邊'), 'x', 'fx', 0));
    s.appendChild(pct(_t('上方'), 'y', 'fy', 0));
    s.appendChild(pct(_t('寬度'), 'w', 'fw', 100));
    s.appendChild(pct(_t('高度'), 'h', 'fh', 100));
    s.appendChild(this.slider(_t('邊框'), { min: 0, max: 40, step: 1, unit: 'px', get: c => c.frame?.border ?? 0, set: v => ({ frame: { border: v } }), key: 'fborder', hardMax: 60 }));
    const bc = this.colorInput(v => this.commit(() => ({ frame: { borderColor: v } }), 'fcolor'));
    this.bind(bc.input, c => { if (c?.frame) bc.set(c.frame.borderColor); });
    const shadow = document.createElement('input');
    shadow.type = 'checkbox';
    shadow.onchange = () => this.commit(() => ({ frame: { shadow: shadow.checked } }), 'fshadow');
    this.bind(shadow, c => { shadow.checked = !!c?.frame?.shadow; });
    const shLbl = document.createElement('label');
    shLbl.className = 'check';
    shLbl.append(shadow, document.createTextNode(_t('陰影')));
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:14px';
    wrap.append(bc.el, shLbl);
    s.appendChild(this.row(_t('邊框色'), wrap, true));

    const v = this.section(_t('取景'), `<button class="link-btn" data-reset>${icon('reset', 'icon-sm')}${_t('重設')}</button>`);
    v.querySelector('[data-reset]').onclick = () => this.commit(() => ({ transform: { x: 0, y: 0, scale: 1, flipX: false, flipY: false } }), 'freset');
    v.appendChild(this.slider(_t('縮放'), { min: 100, max: 400, step: 1, unit: '%', get: c => Math.round(c.transform.scale * 100), set: v => ({ transform: { scale: v / 100 } }), key: 'scale', hardMin: 20, hardMax: 1000 }));
    v.appendChild(this.slider(_t('水平'), { min: () => -p().width / 2, max: () => p().width / 2, step: 1, unit: 'px', get: c => Math.round(c.transform.x), set: v => ({ transform: { x: v } }), key: 'x', hardMin: -1e5, hardMax: 1e5 }));
    v.appendChild(this.slider(_t('垂直'), { min: () => -p().height / 2, max: () => p().height / 2, step: 1, unit: 'px', get: c => Math.round(c.transform.y), set: v => ({ transform: { y: v } }), key: 'y', hardMin: -1e5, hardMax: 1e5 }));
    v.appendChild(this.flipRow());
    v.insertAdjacentHTML('beforeend', `<p class="hint-line">${_t('影像會裁切填滿畫面框。在預覽上拖曳移動畫面框、拉角落調整大小；按住 <kbd>Alt</kbd> 拖曳或用滾輪調整框裡的取景。')}</p>`);
  }

  /** 左右 / 上下翻轉的開關（影片與圖片；「位置與大小」和「取景」共用） */
  flipRow() {
    const chips = document.createElement('div');
    chips.className = 'chip-row';
    chips.innerHTML = `<button class="chip" data-flip="x">${_t('左右翻轉')}</button><button class="chip" data-flip="y">${_t('上下翻轉')}</button>`;
    const field = (b) => (b.dataset.flip === 'x' ? 'flipX' : 'flipY');
    chips.onclick = (e) => {
      const b = e.target.closest('[data-flip]');
      if (b) this.commit(c => ({ transform: { [field(b)]: !c.transform[field(b)] } }), field(b));
    };
    this.bind(chips, c => chips.querySelectorAll('[data-flip]').forEach(b => b.classList.toggle('on', !!c.transform[field(b)])));
    return this.row(_t('翻轉'), chips, true);
  }

  buildAppearance(clip) {
    const s = this.section(clip.type === 'audio' ? _t('淡入淡出') : _t('外觀'));
    if (clip.type !== 'audio') {
      s.appendChild(this.slider(_t('不透明'), { min: 0, max: 100, step: 1, unit: '%', get: c => Math.round(c.opacity * 100), set: v => ({ opacity: v / 100 }), key: 'opacity' }));
    }
    const maxFade = (c) => Math.max(0.1, Math.min(10, c.duration));
    const video = clip.type === 'video';
    s.appendChild(this.slider(video ? _t('畫面淡入') : _t('淡入'), { min: 0, max: maxFade, step: 0.1, unit: 's', decimals: 1, get: c => c.fadeIn, set: v => ({ fadeIn: v }), key: 'fadeIn', hardMax: 600 }));
    s.appendChild(this.slider(video ? _t('畫面淡出') : _t('淡出'), { min: 0, max: maxFade, step: 0.1, unit: 's', decimals: 1, get: c => c.fadeOut, set: v => ({ fadeOut: v }), key: 'fadeOut', hardMax: 600 }));
    s.insertAdjacentHTML('beforeend', `<p class="hint-line">${_t('也可以直接拖曳時間軸上片段上方角落的小圓點。')}</p>`);
  }

  /** 影片片段：聲音的淡入淡出可以跟著畫面，也可以分開設定 */
  buildAudioFades(s) {
    const maxFade = (c) => Math.max(0.1, Math.min(10, c.duration));
    const linked = document.createElement('input');
    linked.type = 'checkbox';
    linked.onchange = () => this.commit(c => ({ audioFades: linked.checked ? null : { in: c.fadeIn, out: c.fadeOut } }), 'afLink');
    this.bind(linked, c => { linked.checked = c.audioFades == null; });
    const lbl = document.createElement('label');
    lbl.className = 'check';
    lbl.append(linked, document.createTextNode(_t('聲音跟著畫面淡入淡出')));
    s.appendChild(this.row('', lbl, true));
    // 調整聲音的淡入淡出會自動改成分開設定
    s.appendChild(this.slider(_t('聲音淡入'), { min: 0, max: maxFade, step: 0.1, unit: 's', decimals: 1, get: c => audioFadesOf(c).in, set: v => ({ audioFades: { in: v } }), key: 'afIn', hardMax: 600 }));
    s.appendChild(this.slider(_t('聲音淡出'), { min: 0, max: maxFade, step: 0.1, unit: 's', decimals: 1, get: c => audioFadesOf(c).out, set: v => ({ audioFades: { out: v } }), key: 'afOut', hardMax: 600 }));
    s.insertAdjacentHTML('beforeend', `<p class="hint-line" style="margin-top:0">${_t('拖曳時間軸波形上的小圓點也可以調整。只調聲音時，畫面不會跟著淡出。')}</p>`);
  }

  /** 跟前一段之間的轉場（記在後面那段） */
  buildTransition() {
    const s = this.section(_t('轉場'));
    const sel = document.createElement('select');
    sel.className = 'select';
    sel.setAttribute('aria-label', _t('轉場效果'));
    sel.innerHTML = `<option value="">${_t('無')}</option>` + TRANSITION_TYPES.map(id => `<option value="${id}">${TRANSITION_LABELS[id]}</option>`).join('');
    sel.onchange = () => this.commit(() => ({ transitionIn: sel.value ? { type: sel.value } : null }), 'trType');
    this.bind(sel, c => { sel.value = c.transitionIn?.type ?? ''; });
    s.appendChild(this.row(_t('進場'), sel));
    s.appendChild(this.slider(_t('長度'), {
      min: MIN_TRANSITION, max: MAX_TRANSITION, step: 0.1, unit: 's', decimals: 1, reset: DEFAULT_TRANSITION,
      get: c => c.transitionIn?.duration ?? DEFAULT_TRANSITION, set: v => ({ transitionIn: { duration: v } }), key: 'trDur',
      disabled: c => !c.transitionIn,
    }));
    const hint = document.createElement('p');
    hint.className = 'hint-line';
    this.bind(hint, (c, p) => {
      const tr = effectiveTransition(p, c);
      if (!prevAdjacent(p, c)) hint.textContent = _t('前面要緊接著同一條軌上的另一段影片或圖片（中間不留空隙），轉場才會出現。');
      else if (tr && tr.duration < c.transitionIn.duration - 1e-6) hint.textContent = _t('片段比較短，轉場實際只有 {s} 秒。', { s: tr.duration.toFixed(1) });
      else hint.textContent = _t('跟前一段的接點：兩段會在接點前後重疊播放。');
    });
    s.appendChild(hint);
  }

  buildFilters() {
    const s = this.section(_t('濾鏡'));
    const chips = document.createElement('div');
    chips.className = 'chip-row';
    chips.style.marginBottom = '14px';
    chips.innerHTML = FILTER_PRESETS.map(([name], i) => `<button class="chip" data-i="${i}">${name}</button>`).join('');
    chips.onclick = (e) => {
      const i = e.target.closest('[data-i]')?.dataset.i;
      if (i != null) this.commit(() => ({ filters: { ...FILTER_PRESETS[i][1] } }), 'filterPreset');
    };
    this.bind(chips, (c) => {
      chips.querySelectorAll('.chip').forEach((b, i) => {
        const f = FILTER_PRESETS[i][1];
        b.classList.toggle('on', Object.keys(f).every(k => Math.abs(c.filters[k] - f[k]) < 0.01));
      });
    });
    s.appendChild(chips);
    s.appendChild(this.slider(_t('亮度'), { min: 0, max: 200, step: 1, unit: '%', get: c => c.filters.brightness, set: v => ({ filters: { brightness: v } }), key: 'br' }));
    s.appendChild(this.slider(_t('對比'), { min: 0, max: 200, step: 1, unit: '%', get: c => c.filters.contrast, set: v => ({ filters: { contrast: v } }), key: 'ct' }));
    s.appendChild(this.slider(_t('飽和度'), { min: 0, max: 200, step: 1, unit: '%', get: c => c.filters.saturation, set: v => ({ filters: { saturation: v } }), key: 'sat' }));
    s.appendChild(this.slider(_t('黑白'), { min: 0, max: 100, step: 1, unit: '%', get: c => c.filters.grayscale, set: v => ({ filters: { grayscale: v } }), key: 'gray' }));
    s.appendChild(this.slider(_t('模糊'), { min: 0, max: 30, step: 0.5, unit: 'px', decimals: 1, get: c => c.filters.blur, set: v => ({ filters: { blur: v } }), key: 'blur' }));
  }

  buildAudio(clip) {
    const s = this.section(clip.type === 'video' ? _t('聲音與速度') : _t('聲音'));
    const item = this.runtime.get(clip.mediaId);
    if (clip.type === 'video' && item && item.hasAudio === false) {
      s.insertAdjacentHTML('beforeend', `<p class="hint-line" style="margin:0 0 10px">${_t('這段影片沒有聲音。')}</p>`);
    }
    s.appendChild(this.slider(_t('音量'), { min: 0, max: 200, step: 1, unit: '%', get: c => Math.round(c.volume * 100), set: v => ({ volume: v / 100 }), key: 'vol' }));
    const mute = document.createElement('input');
    mute.type = 'checkbox';
    mute.onchange = () => this.commit(() => ({ muted: mute.checked }), 'mute');
    this.bind(mute, c => { mute.checked = !!c.muted; });
    const lbl = document.createElement('label');
    lbl.className = 'check';
    lbl.append(mute, document.createTextNode(_t('靜音這個片段')));
    s.appendChild(this.row('', lbl, true));
    if (clip.type === 'video' && item?.hasAudio !== false) this.buildAudioFades(s);

    const speeds = [0.5, 1, 1.5, 2];
    const chips = document.createElement('div');
    chips.className = 'chip-row';
    chips.innerHTML = speeds.map(v => `<button class="chip" data-v="${v}">${v}×</button>`).join('');
    chips.onclick = (e) => { const v = e.target.closest('[data-v]')?.dataset.v; if (v) this.commit(() => ({ speed: +v }), 'speedChip'); };
    this.bind(chips, c => chips.querySelectorAll('.chip').forEach(b => b.classList.toggle('on', +b.dataset.v === c.speed)));
    s.appendChild(this.row(_t('速度'), chips, true));
    s.appendChild(this.slider('', { min: 25, max: 400, step: 5, unit: '%', get: c => Math.round(c.speed * 100), set: v => ({ speed: v / 100 }), key: 'speed' }));
    s.insertAdjacentHTML('beforeend', `<p class="hint-line">${_t('變速會改變片段長度；放慢時如果撞到後面的片段會自動截短。')}</p>`);
  }

  // ---------- 小元件 ----------
  section(title, extra = '') {
    const s = document.createElement('section');
    s.className = 'insp-section';
    s.innerHTML = `<h3><span>${title}</span>${extra}</h3>`;
    this.els.inspector.appendChild(s);
    return s;
  }

  row(label, control, wide = false) {
    const r = document.createElement('div');
    r.className = 'field' + (wide ? ' wide' : '');
    const l = document.createElement('span');
    l.className = 'lbl';
    l.textContent = label;
    r.append(l, control);
    return r;
  }

  bind(el, sync) {
    this.bindings.push({ el, sync: (clip, project) => sync(clip, project) });
  }

  /** 滑桿 + 數字輸入 */
  slider(label, { min, max, step, unit = '', decimals = 0, get, set, key, disabled, hardMin, hardMax, reset }) {
    const r = document.createElement('div');
    r.className = 'field';
    const id = `f_${Math.random().toString(36).slice(2, 8)}`;
    r.innerHTML = `<label for="${id}">${label}</label><input type="range" id="${id}"><input class="num" inputmode="decimal" aria-label="${_t('{name} 數值', { name: label || key })}">`;
    const range = r.querySelector('input[type=range]');
    const num = r.querySelector('.num');
    const val = (f) => (typeof f === 'function' ? f(this.store.selectedClip) : f);
    range.step = step;
    const paint = () => {
      const pct = ((+range.value - +range.min) / ((+range.max - +range.min) || 1)) * 100;
      range.style.setProperty('--fill', `${pct}%`);
    };
    const apply = (v) => {
      // 數字欄可以輸入超出滑桿範圍的值（例如把圖層移到畫面外），由 hardMin / hardMax 決定
      v = clamp(Number(v), hardMin ?? val(min), hardMax ?? val(max));
      if (!isFinite(v)) return;
      this.commit((c) => set(v, c), key);
    };
    range.addEventListener('input', () => { paint(); num.value = (+range.value).toFixed(decimals) + unit; apply(range.value); });
    num.addEventListener('change', () => apply(parseFloat(num.value)));
    num.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') num.blur();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
        apply(parseFloat(num.value) + d);
      }
    });
    num.addEventListener('focus', () => num.select());
    range.addEventListener('dblclick', () => apply(reset != null ? reset : key === 'scale' ? 100 : key === 'opacity' || key === 'vol' ? 100 : key === 'speed' ? 100 : ['br', 'ct', 'sat'].includes(key) ? 100 : 0));
    this.bind(range, (c) => {
      if (!c) return;
      range.min = val(min);
      range.max = val(max);
      const v = get(c);
      if (document.activeElement !== range) range.value = v;
      if (document.activeElement !== num) num.value = Number(v).toFixed(decimals) + unit;
      const dis = disabled ? disabled(c) : false;
      range.disabled = dis;
      num.disabled = dis;
      paint();
    });
    return r;
  }

  seg(options, onPick, getValue, iconsOnly = false) {
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.innerHTML = options.map(([v, l]) => `<button class="seg-btn" data-v="${v}" ${iconsOnly ? `aria-label="${v}"` : ''}>${l}</button>`).join('');
    seg.onclick = (e) => { const v = e.target.closest('[data-v]')?.dataset.v; if (v != null) onPick(v); };
    this.bind(seg, (c) => { if (c) seg.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('on', b.dataset.v === getValue(c))); });
    return seg;
  }

  colorInput(onChange) {
    const el = document.createElement('div');
    el.className = 'color';
    el.innerHTML = '<input type="color"><code></code>';
    const input = el.querySelector('input');
    const code = el.querySelector('code');
    input.addEventListener('input', () => { code.textContent = input.value; onChange(input.value); });
    return { el, input, set(v) { input.value = v; code.textContent = v; } };
  }
}
