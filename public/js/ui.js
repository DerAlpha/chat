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

/** Bildschirme, von denen immer hoechstens einer im Hauptbereich steht. */
const PANES = ['invite', 'group', 'join', 'chat', 'error'];

/**
 * Ab hier ist Platz fuer zwei Spalten. Darunter bleibt es beim Handy-Ablauf:
 * ein Bildschirm nach dem anderen.
 */
const DESKTOP_QUERY = '(min-width: 900px)';
const desktop = typeof window.matchMedia === 'function'
  ? window.matchMedia(DESKTOP_QUERY)
  : null;

export const isDesktop = () => desktop?.matches === true;

const STANDALONE_QUERY = '(display-mode: standalone)';

/**
 * Laeuft die App als eigenes Fenster - also vom Home-Bildschirm gestartet?
 *
 * Zwei Wege, weil keiner allein reicht: `display-mode: standalone` ist der
 * Weg fuer alle anderen, `navigator.standalone` der einzige, den Safari auf
 * dem iPhone kennt.
 */
export const alsAppInstalliert = () => window.navigator.standalone === true
  || window.matchMedia?.(STANDALONE_QUERY).matches === true;

/**
 * iPhone oder iPad?
 *
 * Nicht ueber navigator.platform: ein iPad gibt sich seit iPadOS 13 als
 * "Macintosh" aus. Es verraet sich aber ueber die Zahl der Beruehrungspunkte
 * - ein echter Mac meldet dort null.
 */
export const aufApfelGeraet = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

let activeScreen = null;
const layoutListeners = new Set();

/** Wird gerufen, wenn zwischen Handy- und Rechner-Aufteilung gewechselt wird. */
export function onLayoutChange(listener) {
  layoutListeners.add(listener);
  return () => layoutListeners.delete(listener);
}

function toggleScreen(node, on) {
  if (!node) return;
  node.hidden = !on;
  if (on) node.setAttribute('data-active', '');
  else node.removeAttribute('data-active');
}

/**
 * Am Handy ist genau ein Bildschirm zu sehen. Am Rechner steht die Startseite
 * dauerhaft als Seitenleiste daneben - und wo sonst der Chat waere, wartet
 * solange ein Platzhalter.
 */
function applyLayout() {
  toggleScreen(el('screen-start'), activeScreen === 'start' || isDesktop());
  for (const pane of PANES) toggleScreen(el(`screen-${pane}`), pane === activeScreen);
  toggleScreen(el('screen-empty'), isDesktop() && activeScreen === 'start');
  document.body.dataset.layout = isDesktop() ? 'desktop' : 'mobile';
  for (const listener of layoutListeners) listener(isDesktop());
}

export function showScreen(name) {
  activeScreen = name;
  document.body.dataset.screen = name;
  applyLayout();
}

// Fenster umgezogen oder gedreht: die Aufteilung neu bewerten.
desktop?.addEventListener?.('change', () => {
  if (activeScreen) applyLayout();
});

export const currentScreen = () => activeScreen;

// --------------------------------------------------------------------- Toast

let toastTimer = null;

/**
 * Kurze Meldung. Sie liegt ueber allem - auch ueber einem offenen Blatt -,
 * darf aber nichts abfangen: siehe `pointer-events: none` im Stilblatt.
 */
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
  const vorher = !node.hidden;
  node.hidden = !on;
  // Der Schleier war fuer den Zeiger dicht und fuer die Tastatur offen: der
  // Fokus blieb auf dem Knopf darunter stehen, und die Eingabetaste loeste
  // ihn ein zweites Mal aus - bei "Alle Daten loeschen" ausgerechnet dort.
  if (on && !vorher) fangeFokus(node);
  else if (!on && vorher) gibFokusZurueck(node);
}

// --------------------------------------------------------------- Fokusfalle

/**
 * Was gerade modal offen ist - von unten nach oben gestapelt.
 *
 * `aria-modal="true"` ist eine Behauptung, keine Wirkung: der Browser laesst
 * die Tabulatortaste trotzdem in die Seite dahinter wandern. Gemessen an
 * einem offenen Blatt lagen 16 von 20 Tab-Halten HINTER dem Blatt - auf
 * Knoepfen, die der Schleier zudeckt, mit sichtbarem Fokusring, und die
 * Eingabetaste loeste sie wirklich aus. Hinter dem Fenster "neue Fassung",
 * das sich ausdruecklich nicht wegklicken laesst, liess sich so
 * weiterarbeiten.
 *
 * Ein Stapel und nicht eine einzelne Flaeche, weil es sie uebereinander
 * gibt: die Lupe geht aus einem Blatt heraus auf, der Anruf kommt ueber
 * alles. Gefangen wird immer im obersten.
 */
const modale = [];
/** Wohin der Fokus zurueckgeht, wenn eine Flaeche wieder zugeht. */
const rueckweg = new WeakMap();

const FOKUSSIERBAR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Was in dieser Flaeche wirklich zu erreichen ist - versteckte Aeste zaehlen nicht mit. */
function fokusZiele(flaeche) {
  return [...flaeche.querySelectorAll(FOKUSSIERBAR)]
    .filter((n) => !n.hidden && n.getClientRects().length > 0 && !n.closest('[hidden]'));
}

/**
 * Den Fokus in `flaeche` holen und dort festhalten.
 *
 * @param {HTMLElement} flaeche
 * @param {{auf?: HTMLElement|null}} [optionen] `auf` setzt das erste Ziel
 *   ausdruecklich - fuer Flaechen, deren erster Knopf etwas zerstoert.
 */
export function fangeFokus(flaeche, { auf } = {}) {
  halteFokusFest();
  const vorher = document.activeElement;
  rueckweg.set(flaeche, vorher instanceof HTMLElement && vorher !== document.body ? vorher : null);
  const schon = modale.indexOf(flaeche);
  if (schon >= 0) modale.splice(schon, 1);
  modale.push(flaeche);
  // Eine Flaeche ganz ohne Bedienelement - der Schleier etwa - nimmt den
  // Fokus selbst auf. Sonst bliebe er draussen und die Falle griffe ins Leere.
  if (!flaeche.hasAttribute('tabindex')) flaeche.setAttribute('tabindex', '-1');
  requestAnimationFrame(() => {
    if (modale[modale.length - 1] !== flaeche) return;
    const ziel = auf ?? fokusZiele(flaeche)[0] ?? flaeche;
    ziel.focus({ preventScroll: true });
  });
}

/**
 * Die Flaeche gibt den Fokus wieder her - moeglichst dorthin zurueck, wo er
 * herkam. Ohne das faellt er auf <body>, und der naechste Tabulator faengt
 * wieder ganz oben auf der Seite an.
 */
export function gibFokusZurueck(flaeche) {
  const i = modale.lastIndexOf(flaeche);
  if (i >= 0) modale.splice(i, 1);
  const zurueck = rueckweg.get(flaeche);
  rueckweg.delete(flaeche);
  if (zurueck && zurueck.isConnected && !zurueck.closest('[hidden]') && zurueck.getClientRects().length > 0) {
    zurueck.focus({ preventScroll: true });
    return;
  }
  // Der Ausloeser ist weg (der Verlauf wurde neu gebaut, der Knopf
  // ausgeblendet). Dann wenigstens in die offene Flaeche darunter, statt
  // den Fokus auf <body> fallen zu lassen.
  const darunter = modale[modale.length - 1];
  if (darunter) (fokusZiele(darunter)[0] ?? darunter).focus({ preventScroll: true });
}

/**
 * Der Zuhoerer haengt erst dran, wenn wirklich etwas modal offen ist - und
 * nicht schon beim Laden des Moduls. Ein Modul soll beim Einlesen nichts tun.
 */
let faengtSchon = false;
function halteFokusFest() {
  if (faengtSchon) return;
  faengtSchon = true;
  document.addEventListener('keydown', beiTabulator, true);
}

function beiTabulator(ereignis) {
  if (ereignis.key !== 'Tab' || modale.length === 0) return;
  const oben = modale[modale.length - 1];
  const ziele = fokusZiele(oben);
  if (ziele.length === 0) {
    ereignis.preventDefault();
    oben.focus({ preventScroll: true });
    return;
  }
  const erster = ziele[0];
  const letzter = ziele[ziele.length - 1];
  const aktiv = document.activeElement;
  if (!oben.contains(aktiv)) {
    ereignis.preventDefault();
    (ereignis.shiftKey ? letzter : erster).focus({ preventScroll: true });
  } else if (ereignis.shiftKey && aktiv === erster) {
    ereignis.preventDefault();
    letzter.focus({ preventScroll: true });
  } else if (!ereignis.shiftKey && aktiv === letzter) {
    ereignis.preventDefault();
    erster.focus({ preventScroll: true });
  }
}

// -------------------------------------------------------------------- Sheets

let sheetCloser = null;

/**
 * Halbhohes Menue von unten.
 * @param {string} title
 * @param {Array<Node|{icon?:string,label:string,hint?:string,value?:string,danger?:boolean,onClick?:Function}>} items
 * @param {{onClose?: Function, autofocus?: boolean}} [options] `autofocus:
 *   false` legt den Fokus auf das Blatt selbst statt auf den ersten Knopf.
 *   Für Blätter, deren erster Knopf etwas zerstört: sonst genügt ein
 *   Tastendruck, der noch vom vorigen Blatt stammt.
 */
export function openSheet(title, items, { onClose, autofocus = true } = {}) {
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
  // Fokus in das Blatt holen UND dort festhalten - siehe fangeFokus().
  // `autofocus: false` laesst ihn auf dem Blatt selbst statt auf dem ersten
  // Knopf; die Falle gilt in beiden Faellen.
  fangeFokus(sheet, { auf: autofocus ? undefined : sheet });
}

export function closeSheet() {
  const sheet = el('sheet');
  if (sheet.hidden) return;
  sheet.hidden = true;
  gibFokusZurueck(sheet);
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
export function promptSheet(title, { value = '', placeholder = '', maxLength = 40, confirmLabel, note } = {}) {
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
    // Ohne Namen heisst das Feld im Barrierefreiheitsbaum gar nichts. Der
    // Titel des Blattes steht direkt darueber und sagt genau das Richtige -
    // ein Platzhalter waere kein Ersatz, er verschwindet beim Tippen.
    input.setAttribute('aria-labelledby', 'sheet-title');
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

    openSheet(title, note ? [make('p', 'sheet-note', note), field] : [field], { onClose: () => finish(null) });
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
  fangeFokus(box);
}

export function closeLightbox() {
  const box = el('lightbox');
  if (box.hidden) return;
  box.hidden = true;
  gibFokusZurueck(box);
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
/**
 * @param {number} ts
 * @param {{kurz?: boolean}} [wie] `kurz` fuer enge Stellen - die Chatliste.
 *   Dort steht die Zeit in einer Spalte von rund 135 Bildpunkten, und
 *   "Donnerstag, 27. August, 22:16" ist 177 breit. Ausgeschrieben gehoert
 *   das in die Trennzeile des Verlaufs, wo eine ganze Zeile Platz ist.
 */
export function relativeTime(ts, { kurz = false } = {}) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('justNow');
  if (diff < 3_600_000) return t('minutesAgo', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('hoursAgo', { n: Math.floor(diff / 3_600_000) });
  if (kurz) {
    const tage = Math.round((Date.now() - ts) / 86_400_000);
    // Bis eine Woche zurueck reicht der Wochentag, danach das reine Datum.
    return tage <= 6
      ? new Intl.DateTimeFormat(getLanguage(), { weekday: 'short' }).format(new Date(ts))
      : new Intl.DateTimeFormat(getLanguage(), { day: '2-digit', month: '2-digit', year: '2-digit' }).format(new Date(ts));
  }
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

/** Wie weit und wie lange nach dem Loslassen ein Geisterklick zaehlt. */
const GHOST_RADIUS = 24;
const GHOST_WINDOW = 400;
/** So lange nach einem ausgeloesten Langdruck gehoert ein contextmenu noch dazu. */
const CONTEXT_GRACE = 700;

/**
 * Nach dem Loslassen schickt der Browser noch einen Klick hinterher - auch
 * nach langem Druecken. Der landet auf dem Hintergrund des eben geoeffneten
 * Menues und wuerde es sofort wieder schliessen. Bisher hat der Browser den
 * Klick von sich aus verschluckt, weil er beim Halten zu markieren anfing;
 * seit das unterbunden ist, muessen wir das selbst tun.
 *
 * Geschluckt wird ausschliesslich der Klick, der zu genau diesem Druck gehoert:
 * dieselbe Stelle, kurze Frist. Kommt gar keiner - der Browser laesst ihn aus,
 * sobald der Finger zu weit gerutscht ist -, darf der naechste echte Tipp
 * trotzdem durch. Ein Fanghaken, der blind den ersten Klick frisst, macht die
 * halbe Oberflaeche fuer einen Moment taub.
 */
function swallowGhostClick(x, y) {
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    window.removeEventListener('click', swallow, true);
  };
  const swallow = (event) => {
    if (Math.abs(event.clientX - x) <= GHOST_RADIUS && Math.abs(event.clientY - y) <= GHOST_RADIUS) {
      event.stopPropagation();
      event.preventDefault();
    }
    stop();
  };
  window.addEventListener('click', swallow, true);
  const timer = setTimeout(stop, GHOST_WINDOW);
}

/**
 * Ruft `handler` bei langem Druecken (Touch) oder Rechtsklick auf.
 * @returns {() => void} Abmelde-Funktion
 */
export function onLongPress(node, handler, { delay = 480 } = {}) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  /** Wann der Langdruck zuletzt ausgeloest hat - 0 heisst: in dieser Geste nicht. */
  let firedAt = 0;
  /**
   * Wann zuletzt ein Langdruck *mit dem Finger* ausgeloest hat. Nur dann
   * schickt das Betriebssystem noch ein eigenes contextmenu hinterher, das
   * unterdrueckt werden muss. Ein langer Druck mit der Maus erzeugt keines -
   * dort darf die rechte Maustaste sofort wieder das Menue oeffnen.
   */
  let touchMenuAt = 0;
  let pressing = false;
  let armed = false;
  let byTouch = false;

  const clear = () => {
    clearTimeout(timer);
    timer = null;
  };

  const down = (event) => {
    if (event.button != null && event.button !== 0 && event.pointerType === 'mouse') return;
    firedAt = 0;
    armed = false;
    pressing = true;
    byTouch = event.pointerType !== 'mouse';
    startX = event.clientX;
    startY = event.clientY;
    clear();
    timer = setTimeout(() => {
      firedAt = Date.now();
      if (byTouch) touchMenuAt = firedAt;
      if (navigator.vibrate) navigator.vibrate(12);
      handler(event);
    }, delay);
  };

  const move = (event) => {
    if (!timer) return;
    if (Math.abs(event.clientX - startX) > 12 || Math.abs(event.clientY - startY) > 12) clear();
  };

  /** Losgelassen: erst hier - und nur hier - kann ein Geisterklick folgen. */
  const release = () => {
    clear();
    if (pressing && firedAt && !armed) {
      armed = true;
      swallowGhostClick(startX, startY);
    }
    pressing = false;
    byTouch = false;
  };

  /**
   * Der Zeiger verlaesst die Blase. Das passiert mit der Maus schon beim
   * blossen Darueberfahren, ganz ohne gedrueckte Taste - hier darf deshalb
   * nur der angefangene Druck abgebrochen werden, sonst nichts.
   */
  const leave = () => clear();

  const contextmenu = (event) => {
    event.preventDefault();
    // Genau ein contextmenu gehoert noch zum eben gehaltenen Finger - das
    // wird verschluckt, damit das Menue nicht zweimal aufgeht. Jedes weitere
    // oeffnet es wieder, sonst waere die rechte Maustaste auf dieser Blase
    // hinterher dauerhaft tot.
    if (touchMenuAt && Date.now() - touchMenuAt < CONTEXT_GRACE) {
      touchMenuAt = 0;
      return;
    }
    touchMenuAt = 0;
    handler(event);
  };

  // Mit dem Finger soll erst gar keine Markierung entstehen. Mit der Maus
  // bleibt das Markieren, wie man es vom Schreibtisch kennt.
  //
  // Die CSS-Regel dazu haengt an "(pointer: coarse)" und trifft damit reine
  // Touchgeraete. Auf einem Notebook mit Touchscreen ist der Hauptzeiger die
  // Maus - dort greift nur diese Zeile, und zwar genau dann, wenn wirklich
  // ein Finger im Spiel ist.
  const selectstart = (event) => {
    if (byTouch) event.preventDefault();
  };

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', release);
  node.addEventListener('pointercancel', release);
  node.addEventListener('pointerleave', leave);
  node.addEventListener('contextmenu', contextmenu);
  node.addEventListener('selectstart', selectstart);

  return () => {
    clear();
    node.removeEventListener('pointerdown', down);
    node.removeEventListener('pointermove', move);
    node.removeEventListener('pointerup', release);
    node.removeEventListener('pointercancel', release);
    node.removeEventListener('pointerleave', leave);
    node.removeEventListener('contextmenu', contextmenu);
    node.removeEventListener('selectstart', selectstart);
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
