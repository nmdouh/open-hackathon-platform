// DOM helpers. Everything user-provided goes through textContent or
// attributes set via the DOM API, never through innerHTML.

import { t, lang, errorText } from './i18n.js';

// h('div', { class: 'card', onclick: fn }, 'text', child, [more])
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'value' && 'value' in el) el.value = v;
      else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'required' || k === 'multiple') el[k] = Boolean(v);
      else if (k === 'href' && typeof v === 'string' && /^\s*javascript:/i.test(v)) continue;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(target, ...nodes) {
  target.replaceChildren();
  append(target, nodes);
}

// Only http(s) links from user content become anchors.
export function safeLink(url, label) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow' }, label || url);
}

export function toast(message, kind = 'info') {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast${kind === 'error' ? ' toast--error' : ''}` }, message);
  box.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3500);
}

export function showError(err) {
  toast(errorText(err), 'error');
}

// Runs an async action from a button, disabling it meanwhile.
export async function busy(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (err) {
    showError(err);
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

export function confirmDialog(message, { okLabel, danger = false, withNote = false, notePlaceholder = '' } = {}) {
  return new Promise((resolve) => {
    const note = withNote ? h('textarea', { rows: 3, placeholder: notePlaceholder, 'aria-label': notePlaceholder }) : null;
    const dlg = h('dialog', { 'aria-modal': 'true' },
      h('p', { class: 'pre' }, message),
      note,
      h('div', { class: 'form-actions row--end' },
        h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => close(null) }, t('common.cancel')),
        h('button', { type: 'button', class: `btn${danger ? ' btn--danger' : ''}`, onclick: () => close(withNote ? note.value.trim() : true) }, okLabel || t('common.confirm'))));
    function close(value) {
      dlg.close();
      dlg.remove();
      resolve(value);
    }
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    document.body.append(dlg);
    dlg.showModal();
    (note || dlg.querySelector('.btn:last-child')).focus();
  });
}

// ---- formatting ----
const locale = () => (lang() === 'ar' ? 'ar' : 'en-GB');
export function fmtDate(value, withTime = true) {
  if (!value) return '—';
  const d = new Date(value);
  return new Intl.DateTimeFormat(locale(), withTime
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: 'medium' }).format(d);
}
export function fmtRelative(value) {
  if (!value) return '—';
  const diff = (new Date(value).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}
export function fmtNum(n, digits = 1) {
  if (n === null || n === undefined || n === '') return '—';
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(Number(n));
}

// Picks the Arabic or English variant of a bilingual field, falling back to the other.
export function pick(obj, base) {
  if (!obj) return '';
  const ar = obj[`${base}Ar`];
  const en = obj[`${base}En`];
  return lang() === 'ar' ? (ar || en || '') : (en || ar || '');
}

// <input type="datetime-local"> works in local time without a zone.
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(value) {
  return value ? new Date(value).toISOString() : null;
}

export function badge(text, kind) {
  return h('span', { class: `badge${kind ? ` badge--${kind}` : ''}` }, text);
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', null, label), control, hint ? h('small', null, hint) : null);
}

export function emptyState(text) {
  return h('div', { class: 'empty' }, text);
}

// Reads named form controls into an object (checkbox -> boolean, number -> Number).
export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number') out[el.name] = el.value === '' ? null : Number(el.value);
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value;
  }
  return out;
}

export function splitList(text) {
  return String(text || '').split(/[,،\n]/).map((s) => s.trim()).filter(Boolean);
}
