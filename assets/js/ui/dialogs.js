// 通知（toast）與對話框

import { icon } from './icons.js';
import { _t } from '../i18n.js';

/** 匯出、打包專案檔等長時間工作進行中時，關閉分頁要先提醒 */
export const busy = {
  count: 0,
  start() { this.count++; },
  end() { this.count = Math.max(0, this.count - 1); },
};

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** toast(訊息, { type: 'info'|'success'|'error', action: { label, run }, timeout }) */
export function toast(message, { type = 'info', action = null, timeout = 4200 } = {}) {
  const root = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const ic = type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info';
  el.innerHTML = `${icon(ic)}<span></span>`;
  el.querySelector('span').textContent = message;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { action.run(); dismiss(); };
    el.appendChild(b);
  }
  root.appendChild(el);
  const dismiss = () => {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 200);
  };
  if (timeout) setTimeout(dismiss, timeout);
  while (root.children.length > 4) root.firstChild.remove();
  return dismiss;
}

let openCount = 0;
export const isModalOpen = () => openCount > 0;

/**
 * 開啟對話框。content 可以是 HTML 字串或節點。
 * 回傳 { el, body, close }。按 Esc 或點背景會關閉（dismissible = false 時不會）。
 */
export function openModal({ title, content, footer = '', dismissible = true, onClose = null, width = null }) {
  const root = document.getElementById('modalRoot');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
      <div class="modal-head"><h2 id="modalTitle"></h2><button class="icon-btn" data-close aria-label="${_t('關閉')}">${icon('close')}</button></div>
      <div class="modal-body"></div>
      <div class="modal-foot"></div>
    </div>`;
  const modal = backdrop.querySelector('.modal');
  if (width) modal.style.width = `min(${width}px, 100%)`;
  backdrop.querySelector('h2').textContent = title;
  const body = backdrop.querySelector('.modal-body');
  const foot = backdrop.querySelector('.modal-foot');
  if (typeof content === 'string') body.innerHTML = content; else if (content) body.appendChild(content);
  if (typeof footer === 'string') foot.innerHTML = footer; else if (footer) foot.appendChild(footer);
  if (!foot.childNodes.length) foot.remove();

  const prevFocus = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openCount--;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    onClose?.();
    prevFocus?.focus?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissible) { e.stopPropagation(); close(); }
    if (e.key === 'Tab') trapFocus(modal, e);
  };
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop && dismissible) close(); });
  backdrop.querySelector('[data-close]').onclick = () => { if (dismissible) close(); };
  if (!dismissible) backdrop.querySelector('[data-close]').hidden = true;
  document.addEventListener('keydown', onKey, true);
  root.appendChild(backdrop);
  openCount++;
  requestAnimationFrame(() => (modal.querySelector('[autofocus]') || modal.querySelector('.primary-btn') || modal.querySelector('button:not([data-close])'))?.focus());
  return { el: modal, body, foot, close, setDismissible(v) { dismissible = v; backdrop.querySelector('[data-close]').hidden = !v; } };
}

function trapFocus(container, e) {
  const items = [...container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.disabled && !el.hidden && el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/** 確認對話框，回傳 Promise<boolean> */
export function confirmDialog({ title, message, confirmText = _t('確定'), cancelText = _t('取消'), danger = false }) {
  return new Promise(resolve => {
    let result = false;
    const footer = document.createElement('div');
    footer.style.display = 'contents';
    footer.innerHTML = `<button class="ghost-btn" data-cancel></button><button class="primary-btn ${danger ? 'danger-btn' : ''}" data-ok></button>`;
    footer.querySelector('[data-cancel]').textContent = cancelText;
    footer.querySelector('[data-ok]').textContent = confirmText;
    const m = openModal({ title, content: `<p>${escapeHtml(message)}</p>`, footer, onClose: () => resolve(result) });
    footer.querySelector('[data-cancel]').onclick = () => m.close();
    footer.querySelector('[data-ok]').onclick = () => { result = true; m.close(); };
  });
}
