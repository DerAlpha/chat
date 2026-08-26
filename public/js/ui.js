/** Wiederverwendbare Bausteine der Oberflaeche: Screens, Sheets, Toasts, Zeitangaben. */

import { t, getLanguage } from './i18n.js';

export const el = (id) => document.getElementById(id);

export function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Ein <svg><use href="#i-..."> aus dem Sprite. */
export function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${name}`);
  svg.appendChild(use);
  return svg;
}

// -------------------------------------------------------------------- Screens

const SCREENS = ['start', 'invite', 'join', 'chat', 'error'];
let activeScreen = null;

export function showScreen(name) {
  for (const screen of SCREENS) {
    const node = el(`screen-${screen}`);
    if (!node) continue;
    if (screen === name) {
      node.hidden = false;
      node.setAttribute('data-active', '');
    } else {
      node.hidden = true;
      node.removeAttribute('data-active');
    }
  }
  activeScreen = name;
  document.body.dataset.screen = name;
}

export const currentScreen = () => activeScreen;

// --------------------------------------------------------------------- Toast

let toastTimer = null;

export function toast(message, ms = 2400) {
  const node = el('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, ms);
}

export function busy(on, text = '') {
  const node = el('busy');
  el('busy-text').textContent = text;
  node.hidden = !on;
}

// -------------------------------------------------------------------- Sheets

let sheetCloser = null;

/**
 * Halbhohes Menue von unten.
 * @param {string} title
 * @param {Array<Node|{icon?:string,label:string,hint?:string,value?:string,danger?:boolean,onClick?:Function}>} items
 */
export function openSheet(title, items, { onClose } = {}) {
  const sheet = el('sheet');
  el('sheet-title').textContent = title;
  const body = el('sheet-body');
  body.replaceChildren();

  for (const item of items) {
    if (item instanceof Node) {
      body.appendChild(item);
      continue;
    }
    const button = make('button', `sheet-item${item.danger ? ' is-danger' : ''}`);
    button.type = 'button';
    if (item.icon) button.appendChild(icon(item.icon));
    const text = make('span', 'sheet-item__text');
    text.appendChild(make('span', null, item.label));
    if (item.hint) text.appendChild(make('span', 'sheet-item__hint', item.hint));
    button.appendChild(text);
    if (item.value) button.appendChild(make('span', 'sheet-item__value', item.value));
    button.addEventListener('click', () => {
      if (item.keepOpen !== true) closeSheet();
      item.onClick?.();
    });
    body.appendChild(button);
  }

  sheet.hidden = false;
  sheetCloser = onClose ?? null;
  // Fokus in das Sheet holen, damit Tastatur- und Screenreader-Nutzung funktioniert.
  requestAnimationFrame(() => body.querySelector('button, input')?.focus({ preventScroll: true }));
}

export function closeSheet() {
  const sheet = el('sheet');
  if (sheet.hidden) return;
  sheet.hidden = true;
  const closer = sheetCloser;
  sheetCloser = null;
  closer?.();
}

export const sheetOpen = () => !el('sheet').hidden;

/**
 * Ja/Nein-Rueckfrage als Sheet.
 *
 * Die Antwort wird gesetzt, *bevor* geschlossen wird - sonst gewinnt der
 * Abbruch aus `onClose` das Rennen und jede Bestaetigung verpufft.
 */
export function confirmSheet(title, text, confirmLabel, { danger = true } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const answer = (value) => {
      finish(value);
      closeSheet();
    };
    openSheet(title, [
      make('p', 'sheet-note', text),
      { icon: danger ? 'i-trash' : 'i-check', label: confirmLabel, danger, keepOpen: true, onClick: () => answer(true) },
      { icon: 'i-close', label: t('cancel'), keepOpen: true, onClick: () => answer(false) },
    ], { onClose: () => finish(false) });
  });
}

/** Einzeiliges Eingabefeld als Sheet. */
export function promptSheet(title, { value = '', placeholder = '', maxLength = 40, confirmLabel } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const field = make('div', 'sheet-field');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder;
    input.maxLength = maxLength;
    input.autocomplete = 'off';
    const submit = make('button', 'btn btn--primary', confirmLabel ?? t('save'));
    submit.type = 'button';
    field.append(input, submit);

    const commit = () => {
      // Erst das Ergebnis festhalten, dann schliessen - sonst kommt `onClose`
      // mit dem Abbruch zuvor.
      finish(input.value.trim());
      closeSheet();
    };
    submit.addEventListener('click', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      }
    });

    openSheet(title, [field], { onClose: () => finish(null) });
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}

// ----------------------------------------------------------------- Lightbox

export function openLightbox(url, caption, filename) {
  const box = el('lightbox');
  el('lightbox-image').src = url;
  el('lightbox-image').alt = caption || t('image');
  el('lightbox-caption').textContent = caption ?? '';
  const download = el('lightbox-download');
  download.href = url;
  download.download = filename || 'bild.jpg';
  box.hidden = false;
}

export function closeLightbox() {
  const box = el('lightbox');
  if (box.hidden) return;
  box.hidden = true;
  el('lightbox-image').removeAttribute('src');
}

export const lightboxOpen = () => !el('lightbox').hidden;

// ----------------------------------------------------------------- Zeitangaben

const timeFormat = () => new Intl.DateTimeFormat(getLanguage(), { hour: '2-digit', minute: '2-digit' });
const dayFormat = () => new Intl.DateTimeFormat(getLanguage(), { weekday: 'long', day: 'numeric', month: 'long' });

export const formatClock = (ts) => timeFormat().format(new Date(ts));

export function formatDay(ts) {
  const date = new Date(ts);
  const today = new Date();
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(date)) / 86_400_000);
  if (diffDays === 0) return t('today');
  if (diffDays === 1) return t('yesterday');
  return dayFormat().format(date);
}

export const sameDay = (a, b) =>
  new Date(a).toDateString() === new Date(b).toDateString();

/** "gerade eben", "vor 5 Min.", sonst Uhrzeit bzw. Datum. */
export function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('justNow');
  if (diff < 3_600_000) return t('minutesAgo', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('hoursAgo', { n: Math.floor(diff / 3_600_000) });
  return `${formatDay(ts)}, ${formatClock(ts)}`;
}

// ------------------------------------------------------------------- Linkify

const URL_PATTERN = /\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/gi;

/**
 * Wandelt Links in klickbare Elemente - ohne innerHTML, damit fremder Text
 * niemals als Markup interpretiert wird.
 */
export function linkify(text) {
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  for (const match of String(text).matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) fragment.append(text.slice(lastIndex, start));
    const anchor = document.createElement('a');
    anchor.href = match[0];
    anchor.textContent = match[0];
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer nofollow';
    fragment.append(anchor);
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) fragment.append(text.slice(lastIndex));
  return fragment;
}

/** Erstes sichtbares Zeichen fuer den Avatar. */
export function initial(name) {
  const clean = String(name ?? '').trim();
  if (!clean) return '?';
  return [...clean][0].toUpperCase();
}

// ------------------------------------------------------------- Langes Druecken

/**
 * Ruft `handler` bei langem Druecken (Touch) oder Rechtsklick auf.
 * @returns {() => void} Abmelde-Funktion
 */
export function onLongPress(node, handler, { delay = 480 } = {}) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let fired = false;

  const clear = () => {
    clearTimeout(timer);
    timer = null;
  };

  const down = (event) => {
    if (event.button != null && event.button !== 0 && event.pointerType === 'mouse') return;
    fired = false;
    startX = event.clientX;
    startY = event.clientY;
    clear();
    timer = setTimeout(() => {
      fired = true;
      if (navigator.vibrate) navigator.vibrate(12);
      handler(event);
    }, delay);
  };

  const move = (event) => {
    if (!timer) return;
    if (Math.abs(event.clientX - startX) > 12 || Math.abs(event.clientY - startY) > 12) clear();
  };

  const up = () => clear();

  const contextmenu = (event) => {
    event.preventDefault();
    if (!fired) handler(event);
  };

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', up);
  node.addEventListener('pointerleave', up);
  node.addEventListener('contextmenu', contextmenu);

  return () => {
    clear();
    node.removeEventListener('pointerdown', down);
    node.removeEventListener('pointermove', move);
    node.removeEventListener('pointerup', up);
    node.removeEventListener('pointercancel', up);
    node.removeEventListener('pointerleave', up);
    node.removeEventListener('contextmenu', contextmenu);
  };
}

/** Kopiert Text, mit Rueckfallebene fuer Browser ohne Clipboard-API. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* unten weiterprobieren */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
