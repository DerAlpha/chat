/**
 * Flüsterchat – Ablaufsteuerung.
 *
 * Grundregel: Alles, was Inhalt ist, wird hier im Browser verschlüsselt.
 * Der Server bekommt nur die Raum-ID (ein Hash des Codes), ein Zugangstoken
 * und unlesbare Bytes zu sehen.
 */

import {
  cryptoAvailable, generateCode, formatCode, normalizeCode, isCompleteCode, codeLength,
  deriveSecrets, deriveSlot, generateGroupKey, randomRoomId, wrapGroupKey, unwrapGroupKey,
  importKey, encryptJson, decryptJson, encryptBytes, decryptBytes,
  toBase64, fromBase64, randomId,
} from './crypto.js';
import { qrSvg } from './qr.js';
import { CallSession, mediaCryptoAvailable } from './call.js';
import { emojiGroups, searchEmoji, looksLikeEmoji } from './emoji.js';
import { appUrl, baseUrl, basePath } from './base.js';
import { APP_VERSION } from './version.js';
import { t, applyTranslations, setLanguage, getLanguage, detectLanguage, availableLanguages, onLanguageChange } from './i18n.js';
import { listSessions, getSession, saveSession, patchSession, patchSessions, removeSession, getPrefs, setPrefs, storageAvailable } from './session.js';
import { createRoom, claimSlot, roomStatus, overview, uploadBlob, downloadBlob, burnRoom, createConnection, serverConfig, searchGifs, gifMediaUrl, fetchGif, iceConfig, ApiError } from './net.js';
import { prepareImage, readFileBytes, extensionFor, formatBytes, formatDuration, canRecordAudio, startRecording } from './media.js';
import { configureSound, playSound, primeSound } from './sound.js';
import {
  el, make, icon, showScreen, currentScreen, isDesktop, onLayoutChange, toast, busy,
  openSheet, closeSheet, sheetOpen,
  confirmSheet, promptSheet, openLightbox, closeLightbox, lightboxOpen,
  formatClock, formatDay, sameDay, relativeTime, linkify, initial, onLongPress, copyText,
} from './ui.js';

const MAX_ATTACHMENTS = 4;
/** Ausstehende Nachrichten sortieren hinter allem Bestaetigten - und untereinander in Sendereihenfolge. */
const PENDING_SEQ_BASE = Number.MAX_SAFE_INTEGER - 1_000_000;
let pendingCounter = 0;
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
/** So viele zuletzt benutzte Emoji stehen in der Schnellreihe und im Merker. */
const QUICK_REACTIONS = 6;
const RECENT_EMOJI_MAX = 24;
const TYPING_INTERVAL = 2500;
const TYPING_TIMEOUT = 4000;

/** Alles, was die laufende Sitzung ausmacht. */
const app = {
  prefs: null,
  session: null,
  key: null,
  conn: null,
  limits: { maxBlobBytes: 12 * 1024 * 1024 },
  /** Was diese Installation anbietet - kommt von GET api/config. */
  features: { gifs: false, maxGroup: 8, call: { calls: false, discovery: false, relay: false } },
  /** Der laufende Anruf, falls einer läuft. */
  call: null,
  /** Die Anmeldung des Service Workers - über sie kommt die Update-Meldung. */
  swRegistration: null,
  me: null,
  /**
   * Alle anderen im Raum. In einem Zweiergespräch genau einer, in einer
   * Gruppe entsprechend mehr - deshalb eine Zuordnung und kein einzelnes
   * Gegenüber. Wer selbst dran ist, steht in `me` und nicht hier.
   */
  members: new Map(),
  messages: new Map(),
  order: [],
  pending: new Map(),
  attachments: [],
  replyTo: null,
  recorder: null,
  objectUrls: new Set(),
  atBottom: true,
  unread: 0,
  oldestSeq: Infinity,
  hasMore: false,
  loadingMore: false,
  typingTimer: null,
  lastTypingSent: 0,
  connectionStatus: 'idle',
  mediaObserver: null,
  audioPlaying: null,
  inviteFromChat: false,
};

// ===========================================================================
// Start
// ===========================================================================

function boot() {
  dropCacheBuster();
  app.prefs = getPrefs();
  configureSound({ enabled: app.prefs.sound !== false });
  // Browser lassen Ton erst zu, wenn jemand etwas getan hat. Der erste Tipp
  // weckt den Kanal - sonst bliebe die erste Nachricht stumm, die kommt,
  // bevor man selbst etwas angefasst hat.
  //
  // Bewusst dauerhaft und nicht nur einmal: Ein Kanal kann später wieder
  // angehalten werden - iOS tut das nach einem Telefonanruf oder nach Siri,
  // und jeder längere Aufenthalt im Hintergrund tut es auch. Wer nur beim
  // ersten Antippen weckt, ist danach für den Rest der Sitzung stumm, ohne
  // dass irgendetwas darauf hindeutet. primeSound ist billig: bei laufendem
  // Kanal ist es ein Zustandsvergleich.
  for (const art of ['pointerdown', 'keydown']) {
    window.addEventListener(art, primeSound, { passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') primeSound();
    // Im Hintergrund fragt niemand nach der Liste - das kostet nur Akku.
    watchOverview();
  });
  setLanguage(detectLanguage(app.prefs.lang));
  applyTheme(app.prefs.theme);
  applyTranslations();
  wireStaticHandlers();
  onLayoutChange(placeFeatures);
  onLanguageChange(() => {
    applyTranslations();
    refreshDynamicLabels();
  });

  if (!cryptoAvailable) {
    showError(t('errorCrypto'), { retry: false });
    return;
  }

  registerServiceWorker();
  watchForUpdates();
  // Was diese Installation kann, entscheidet der Server. Nebenher holen,
  // damit der Start dadurch nicht langsamer wird.
  void serverConfig().then((remote) => {
    app.features = {
      gifs: remote?.gifs === true,
      // Wie gross eine Gruppe hoechstens werden darf, entscheidet der Server.
      // Ohne Auskunft ein zurueckhaltender Wert - lieber eine Gruppe zu klein
      // anbieten als eine, die beim Anlegen abgewiesen wird.
      maxGroup: Number.isInteger(remote?.maxGroup) ? remote.maxGroup : 8,
      call: remote?.call ?? { discovery: false, relay: false, calls: false },
    };
    updateCallButtons();
    compareVersion(remote?.version);
  }).catch(() => {});
  route();
  window.addEventListener('hashchange', route);
}

/**
 * Das URL-Fragment steuert den Einstieg:
 *   #ABCD-EFGH-JKMN            – Einladung zum Beitreten
 *   #ABCD-EFGH-JKMN.<token>    – eigenes Zweitgeraet
 * Fragmente werden nie an den Server geschickt.
 */
function parseHash() {
  let raw = decodeURIComponent(location.hash.replace(/^#/, '')).trim();
  if (!raw) return null;
  // Ein Gruppen-Link traegt ein Vorzeichen. Damit weiss die App sofort,
  // welchen Weg sie gehen muss - und die Raum-ID, die derselbe Code als
  // Zweierchat ergaebe, wird gar nicht erst gerechnet und nie verschickt.
  const gruppe = raw.startsWith('g:');
  if (gruppe) raw = raw.slice(2);
  const [codePart, tokenPart] = raw.split('.');
  const code = normalizeCode(codePart);
  if (!isCompleteCode(code)) return null;
  return { code: formatCode(code), token: tokenPart || null, group: gruppe };
}

function clearHash() {
  history.replaceState(null, '', location.pathname + location.search);
}

async function route() {
  const invite = parseHash();
  if (invite) {
    clearHash();
    if (invite.group) await enterGroup(invite.code);
    else await enterChat(invite.code, { deviceToken: invite.token });
    return;
  }
  if (currentScreen() === 'chat') return;
  showStart();
}

function showStart() {
  teardownChat();
  renderChatList();
  showScreen('start');
  watchOverview();
}

/**
 * Die drei Stichpunkte stehen am Handy unter der Chatliste. Am Rechner ist
 * dort kein Platz - dafuer ist die rechte Haelfte leer, solange kein Chat
 * offen ist. Also ziehen sie um, statt zweimal im Quelltext zu stehen.
 */
function placeFeatures() {
  const features = el('features');
  const target = el(isDesktop() ? 'slot-empty' : 'slot-start');
  if (features && target && features.parentElement !== target) target.appendChild(features);
}

// ===========================================================================
// Chat anlegen und betreten
// ===========================================================================

async function startNewChat() {
  busy(true, t('joining'));
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateCode();
      const { roomId, keyRaw } = await deriveSecrets(code);
      try {
        await createRoom(roomId);
      } catch (error) {
        // Ein bereits vergebener Code ist extrem unwahrscheinlich - aber nicht unmöglich.
        if (error instanceof ApiError && error.code === 'room_exists') continue;
        throw error;
      }
      const session = saveSession({
        roomId,
        code,
        key: toBase64(keyRaw),
        token: null,
        memberId: null,
        nick: app.prefs.nick ?? '',
        peerNick: '',
        // Selbst vergebene Bezeichnung. Bleibt auf diesem Gerät und geht nie
        // an den Server - sie ist nur dafür da, die eigene Liste zu ordnen.
        label: '',
        createdAt: Date.now(),
        lastActivity: Date.now(),
        readSeq: 0,
        lastMessageAt: 0,
        typing: false,
        unread: 0,
      });
      busy(false);
      await openSession(session, { screen: 'invite' });
      return;
    }
    showError(t('errorRoomExists'));
  } catch (error) {
    busy(false);
    reportError(error);
  } finally {
    busy(false);
  }
}

/**
 * Eine Gruppe anlegen.
 *
 * Der Unterschied zum Zweiergespräch steckt im Schlüssel. Dort IST der Code
 * der Raum: beide Seiten rechnen aus demselben Code dasselbe aus. Das geht
 * hier nicht, denn jede Person bekommt einen eigenen Code - sonst wäre ein
 * einziger weitergereichter Code der Zugang für beliebig viele.
 *
 * Also: ein gewürfelter Gruppenschlüssel, ein gewürfelter Raum, und je
 * Teilnehmer ein Platz. Auf dem Platz liegt der Gruppenschlüssel, verpackt
 * mit einem Schlüssel, den nur dieser eine Code hergibt. Der Server sieht
 * Pakete, die er nicht öffnen kann, und Plätze, die genau einmal aufgehen.
 */
async function startNewGroup() {
  const setup = await askGroupSetup();
  if (!setup) return;

  busy(true, t('joining'));
  try {
    const key = generateGroupKey();
    const roomId = randomRoomId();
    const codes = [];
    const slots = [];
    for (let i = 0; i < setup.count; i += 1) {
      const code = generateCode();
      const { slotId, wrapKeyRaw } = await deriveSlot(code);
      slots.push({ id: slotId, wrapped: await wrapGroupKey(wrapKeyRaw, { key, roomId, name: setup.name }) });
      codes.push(formatCode(code));
    }

    // Wer anlegt, hat selbst keinen Code - die hat er gerade für die anderen
    // erzeugt. Sein Platz kommt deshalb mit der Antwort zurück.
    const room = await createRoom(roomId, slots);

    const session = saveSession({
      roomId,
      // Eine Gruppe hat keinen gemeinsamen Code. Das Feld bleibt leer, damit
      // nirgends einer angeboten wird, den es nicht gibt.
      code: '',
      kind: 'group',
      key: toBase64(key),
      token: room?.you?.token ?? null,
      memberId: room?.you?.id ?? null,
      capacity: room?.capacity ?? setup.count + 1,
      // Die Codes bleiben auf diesem Gerät, damit man sie noch verteilen
      // kann. Sie gehen nie an den Server - der kennt nur die Plätze.
      codes,
      nick: app.prefs.nick ?? '',
      peerNick: '',
      label: setup.name,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      readSeq: 0,
      lastMessageAt: 0,
      typing: false,
      unread: 0,
    });
    busy(false);
    await openSession(session, { screen: 'group' });
  } catch (error) {
    busy(false);
    reportError(error);
  } finally {
    busy(false);
  }
}

/**
 * Fragt Name und Grösse ab. Zwei Felder in einem Blatt - für zwei Angaben
 * hintereinander zwei Dialoge zu öffnen wäre eine Zumutung.
 */
function askGroupSetup() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const name = document.createElement('input');
    name.type = 'text';
    name.placeholder = t('groupNamePlaceholder');
    name.maxLength = 40;
    name.autocomplete = 'off';
    name.id = 'group-name';
    const nameZeile = make('div', 'sheet-field');
    nameZeile.appendChild(name);

    const zahl = document.createElement('input');
    zahl.type = 'number';
    zahl.min = '2';
    // Man selbst zählt mit - deshalb einer weniger als die Kapazität.
    zahl.max = String(Math.max(2, (app.features.maxGroup ?? 8) - 1));
    zahl.value = '2';
    zahl.inputMode = 'numeric';
    zahl.id = 'group-size';
    const label = make('label', 'sheet-field__label', t('groupSize'));
    label.htmlFor = zahl.id;
    const zahlZeile = make('div', 'sheet-field sheet-field--row');
    zahlZeile.append(label, zahl);

    const senden = make('button', 'btn btn--primary', t('create'));
    senden.type = 'button';
    // In dieselbe Umrandung wie die Felder, damit er nicht an den Rand stösst.
    const knopfZeile = make('div', 'sheet-field');
    knopfZeile.appendChild(senden);

    const absenden = () => {
      const wieviele = Math.min(Number(zahl.max), Math.max(2, Number.parseInt(zahl.value, 10) || 2));
      finish({ name: name.value.trim(), count: wieviele });
      closeSheet();
    };
    senden.addEventListener('click', absenden);
    for (const eingabe of [name, zahl]) {
      eingabe.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          absenden();
        }
      });
    }

    // Reihenfolge: erst fragen, dann bestätigen. Ein Knopf zwischen zwei
    // Feldern sieht aus, als wäre man schon fertig.
    openSheet(t('startGroup'), [
      make('p', 'sheet-note', t('groupSetupHint')),
      nameZeile,
      zahlZeile,
      knopfZeile,
    ], { onClose: () => finish(null) });
  });
}

/**
 * Einer Gruppe beitreten - mit einem Code, der auf einen Platz zeigt.
 *
 * Der Beitretende kennt den Raum nicht. Er rechnet aus seinem Code die
 * Platzkennung, löst den Platz ein und bekommt das Paket, das nur sein Code
 * öffnet. Erst darin stehen Schlüssel, Raum und Name.
 */
async function enterGroup(code, { quiet = false } = {}) {
  busy(true, t('joining'));
  try {
    const { slotId, wrapKeyRaw } = await deriveSlot(code);
    let platz;
    try {
      platz = await claimSlot(slotId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) {
        // Den gab es, er ist verbraucht. Das ist die richtige Auskunft -
        // auch beim Nachfassen nach einem getippten Code.
        showError(t('errorCodeUsed'), { retry: false });
        return true;
      }
      if (error instanceof ApiError && error.status === 404) {
        if (quiet) return false;
        showError(t('errorRoomUnknown'), { retry: false });
        return true;
      }
      throw error;
    }

    const inhalt = await unwrapGroupKey(wrapKeyRaw, platz.wrapped);
    if (!inhalt) {
      showError(t('errorGroupPacket'), { retry: false });
      return true;
    }
    // Was im Paket steht, muss zu dem passen, was der Server sagt. Sonst
    // lotst ein untergeschobener Server jemanden in einen fremden Raum -
    // und der Vergleich ist das Einzige, was das bemerken würde.
    if (inhalt.roomId !== platz.roomId) {
      showError(t('errorGroupPacket'), { retry: false });
      return true;
    }

    const bekannt = getSession(platz.roomId);
    const session = saveSession({
      roomId: platz.roomId,
      code: '',
      kind: 'group',
      key: toBase64(inhalt.key),
      token: platz.you?.token ?? bekannt?.token ?? null,
      memberId: platz.you?.id ?? bekannt?.memberId ?? null,
      capacity: platz.capacity ?? bekannt?.capacity ?? 0,
      codes: [],
      nick: bekannt?.nick ?? app.prefs.nick ?? '',
      peerNick: '',
      label: bekannt?.label || inhalt.name || '',
      createdAt: bekannt?.createdAt ?? Date.now(),
      lastActivity: Date.now(),
      readSeq: bekannt?.readSeq ?? 0,
      lastMessageAt: bekannt?.lastMessageAt ?? 0,
      typing: false,
      unread: 0,
    });
    await openSession(session, { screen: 'chat' });
    return true;
  } catch (error) {
    reportError(error);
    return true;
  } finally {
    busy(false);
  }
}

/**
 * Beitreten oder zurueckkehren - je nachdem, was dieses Geraet schon kennt.
 * Ist die Sitzung bekannt, sind Raum-ID und Schluessel schon da und die
 * teure Ableitung entfaellt.
 */
async function enterChat(code, { deviceToken = null, known: knownSession = null } = {}) {
  busy(true, t('joining'));
  try {
    let roomId;
    let keyRaw;
    if (knownSession) {
      roomId = knownSession.roomId;
      keyRaw = fromBase64(knownSession.key);
    } else {
      ({ roomId, keyRaw } = await deriveSecrets(code));
    }
    const known = knownSession ?? getSession(roomId);
    const token = deviceToken ?? known?.token ?? null;

    let status;
    try {
      status = await roomStatus(roomId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        // Vielleicht war es gar kein Zweierchat-Code, sondern ein Platz in
        // einer Gruppe. Ein Gruppen-Link sagt das vorweg; ein von Hand
        // getippter Code sagt gar nichts. Wer ihn abtippt, soll nicht
        // "diesen Chat gibt es nicht" lesen, obwohl er stimmt.
        if (!knownSession && await enterGroup(code, { quiet: true })) return;
        showError(t('errorRoomUnknown'));
        return;
      }
      throw error;
    }
    if (status.full && !token) {
      showError(t('errorRoomFull'), { retry: false });
      return;
    }

    const session = saveSession({
      roomId,
      code: formatCode(code),
      key: toBase64(keyRaw),
      token,
      memberId: known?.memberId ?? null,
      nick: known?.nick ?? app.prefs.nick ?? '',
      peerNick: known?.peerNick ?? '',
      // Muss mitgenommen werden: sonst wäre die eigene Bezeichnung jedes Mal
      // weg, wenn man den Chat wieder betritt.
      label: known?.label ?? '',
      createdAt: known?.createdAt ?? Date.now(),
      lastActivity: Date.now(),
      // Muss mit: sonst gaelte nach jedem Betreten wieder alles als ungelesen.
      readSeq: known?.readSeq ?? 0,
      lastMessageAt: known?.lastMessageAt ?? 0,
      typing: false,
      unread: 0,
    });
    await openSession(session, { screen: status.members >= 1 || token ? 'chat' : 'invite' });
  } catch (error) {
    reportError(error);
  } finally {
    busy(false);
  }
}

/** Baut Schluessel und Verbindung auf und zeigt den passenden Screen. */
async function openSession(session, { screen = 'chat' } = {}) {
  teardownChat();
  app.session = session;
  app.key = await importKey(fromBase64(session.key));
  resetConversation();

  if (screen === 'invite') showInvite(session);
  else if (screen === 'group') showGroupCodes(session);
  else showChatScreen();

  await connect();
  // Erst fragen, wenn der Aufrufer seinen Ladeschleier abgeräumt hat - sonst
  // liegt der über dem Dialog und schluckt jeden Tastendruck.
  setTimeout(() => void askForName(), 0);
}

/** In diesem Seitenaufruf schon gefragt? Einmal reicht. */
let nameAsked = false;

/**
 * Wer sich noch keinen Namen gegeben hat, wird beim Betreten eines Chats
 * einmal danach gefragt. Wer ablehnt, wird nicht weiter behelligt - beim
 * nächsten Aufruf der Seite kommt die Frage wieder, bis ein Name steht.
 */
async function askForName() {
  if (nameAsked) return;
  if ((app.session?.nick ?? '').trim() || (app.prefs.nick ?? '').trim()) return;
  nameAsked = true;
  const opened = app.session.roomId;
  const next = await promptSheet(t('yourName'), {
    placeholder: t('namePlaceholder'),
    note: t('askNameHint'),
    maxLength: 32,
  });
  // Während der Frage kann der Chat längst verlassen worden sein. Verglichen
  // wird die Raum-ID, nicht das Objekt: app.session wird bei jeder Änderung
  // durch ein neues ersetzt, ein Identitätsvergleich wäre immer ungleich.
  if (!next || app.session?.roomId !== opened) return;
  app.session = patchSession(app.session.roomId, { nick: next }) ?? app.session;
  app.prefs = setPrefs({ nick: next });
  sendNick(next);
}

/**
 * Baut die Verbindung auf. Welche Art - WebSocket oder Abholen per HTTP -
 * entscheidet der Server; für den Rest der App sieht beides gleich aus.
 */
async function connect() {
  const opened = app.session;
  const openedRoom = opened.roomId;
  handleConnectionStatus('connecting');
  const connection = await createConnection({
    roomId: opened.roomId,
    token: opened.token,
    onFrame: handleFrame,
    onStatus: handleConnectionStatus,
    onFatal: handleFatalClose,
  });
  // Während des Aufbaus kann der Chat schon wieder verlassen worden sein.
  // Auch hier zählt die Raum-ID: das Sitzungsobjekt selbst wird ausgetauscht,
  // sobald sich irgendeine Kleinigkeit daran ändert.
  if (app.session?.roomId !== openedRoom) {
    connection.close();
    return;
  }
  app.conn = connection;
  connection.connect(true);
}

function teardownChat() {
  // Erst auflegen, dann die Leitung kappen - sonst erfährt das Gegenüber nie,
  // dass hier niemand mehr dran ist.
  app.call?.dispose();
  app.call = null;
  closeCallScreen();
  app.conn?.close();
  app.conn = null;
  app.mediaObserver?.disconnect();
  app.mediaObserver = null;
  stopAudioPlayback();
  for (const url of app.objectUrls) URL.revokeObjectURL(url);
  app.objectUrls.clear();
  blobCache.clear();
  urlCache.clear();
  typingNode = null;
  clearTimeout(app.typingTimer);
  for (const member of app.members.values()) clearTimeout(member.typingTimer);
  forgetPresenceSound();
  app.recorder?.cancel();
  app.recorder = null;
  // Sonst bliebe nach einem Abbruch mitten in der Aufnahme das Eingabefeld verdeckt.
  const recorderBar = el('recorder');
  if (recorderBar) recorderBar.hidden = true;
  const composerForm = el('composer');
  if (composerForm) composerForm.hidden = false;
  app.session = null;
  app.key = null;
  resetConversation();
}

function resetConversation() {
  app.messages.clear();
  app.order = [];
  app.pending.clear();
  app.attachments = [];
  app.replyTo = null;
  app.me = null;
  app.members.clear();
  app.unread = 0;
  app.atBottom = true;
  app.oldestSeq = Infinity;
  app.hasMore = false;
  el('messages')?.replaceChildren();
  renderAttachments();
  renderReplyPreview();
  updateJumpButton();
}

// ===========================================================================
// Einladungs-Screen
// ===========================================================================

function showInvite(session, { fromChat = false } = {}) {
  app.inviteFromChat = fromChat;
  el('code-display').textContent = session.code;
  const link = inviteLink(session.code);
  const frame = el('qr-frame');
  frame.replaceChildren();
  try {
    frame.appendChild(qrSvg(link));
    frame.hidden = false;
  } catch {
    frame.hidden = true;
  }
  el('btn-share').hidden = typeof navigator.share !== 'function';
  setInviteWaiting(fromChat || app.members.size > 0);
  renderChatList();
  showScreen('invite');
}

/**
 * Die Codeliste einer Gruppe: einer je Person.
 *
 * Bewusst untereinander statt einer nach dem anderen. Wer eine Gruppe
 * zusammenstellt, verteilt die Codes in einem Zug an verschiedene Leute -
 * und muss dabei sehen können, welchen er schon vergeben hat.
 */
function showGroupCodes(session) {
  const liste = el('group-codes');
  liste.replaceChildren();
  const codes = session.codes ?? [];

  codes.forEach((code, i) => {
    const eintrag = make('li', 'invite-row');
    eintrag.appendChild(make('span', 'invite-row__nr', String(i + 1)));

    const mitte = make('div', 'invite-row__body');
    mitte.appendChild(make('code', 'invite-row__code', code));
    mitte.appendChild(make('span', 'invite-row__hint', t('groupCodeOnce')));
    eintrag.appendChild(mitte);

    const knoepfe = make('div', 'invite-row__actions');
    // Zum Vorzeigen: wer nebeneinander steht, scannt lieber, als abzutippen.
    const scannen = make('button', 'btn btn--icon');
    scannen.type = 'button';
    scannen.title = t('scanHint');
    scannen.appendChild(icon('i-qr'));
    scannen.addEventListener('click', () => showCodeQr(code, i + 1));
    knoepfe.appendChild(scannen);

    const teilen = make('button', 'btn btn--icon');
    teilen.type = 'button';
    teilen.title = typeof navigator.share === 'function' ? t('shareLink') : t('copyLink');
    teilen.appendChild(icon(typeof navigator.share === 'function' ? 'i-share' : 'i-link'));
    teilen.addEventListener('click', () => void handOutCode(code));
    knoepfe.appendChild(teilen);
    eintrag.appendChild(knoepfe);

    liste.appendChild(eintrag);
  });

  updateGroupProgress();
  renderChatList();
  showScreen('group');
}

/** Einen einzelnen Platz zum Abscannen zeigen. */
function showCodeQr(code, nummer) {
  const teile = [];
  try {
    const rahmen = make('div', 'qr-frame');
    rahmen.appendChild(qrSvg(groupLink(code)));
    teile.push(rahmen);
  } catch {
    // Ohne QR bleibt der Code - abtippen geht immer noch.
  }
  teile.push(make('p', 'sheet-note center', code));
  openSheet(`${t('groupCodes')} · ${nummer}`, teile);
}

/** Einen einzelnen Platz weitergeben - teilen, wenn das Gerät es kann. */
async function handOutCode(code) {
  const link = groupLink(code);
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: t('appName'), url: link });
      return;
    } catch {
      // Abgebrochen oder nicht möglich - dann eben in die Zwischenablage.
    }
  }
  toast(await copyText(link) ? t('copied') : t('copyFailed'));
}

/** Wie viele schon da sind. Steht über der Liste, damit man weiss, wer fehlt. */
function updateGroupProgress() {
  const zeile = el('group-progress');
  if (!zeile || !app.session) return;
  const alle = app.session.capacity || (app.session.codes?.length ?? 0) + 1;
  zeile.textContent = t('groupPresence', { online: app.members.size + 1, total: alle });
}

const inviteLink = (code) => `${baseUrl.href}#${encodeURIComponent(formatCode(code))}`;
/** Ein Platz in einer Gruppe. Das Vorzeichen spart dem Beitretenden eine
    Ableitung, die sonst ins Leere liefe. */
const groupLink = (code) => `${baseUrl.href}#g:${encodeURIComponent(formatCode(code))}`;
const deviceLink = (code, token) =>
  `${baseUrl.href}#${encodeURIComponent(formatCode(code))}.${encodeURIComponent(token)}`;

function setInviteWaiting(peerArrived) {
  const status = el('invite-status');
  status.classList.toggle('is-ready', peerArrived);
  status.querySelector('span:last-child').textContent = peerArrived ? t('peerArrived') : t('waitingForPeer');
  status.querySelector('.dots').hidden = peerArrived;
  el('btn-to-chat').hidden = !(peerArrived || app.inviteFromChat);
}

// ===========================================================================
// Verbindung und eingehende Frames
// ===========================================================================

function handleConnectionStatus(status) {
  app.connectionStatus = status;
  if (status === 'open') hideBanner();
  else if (navigator.onLine === false) showBanner(t('offlineBanner'), true);
  else if (status === 'connecting') showBanner(t('connecting'));
  else if (status === 'reconnecting') showBanner(t('reconnecting'), true);
  updatePeerStatus();
}

function handleFatalClose(code) {
  if (code === 4003) showError(t('errorRoomFull'), { retry: false });
  // Gelöscht ist kein Fehler, sondern ein Ende: zurück auf die Startseite.
  else if (code === 4010) onBurned();
  else showError(t('errorRoomUnknown'), { retry: false });
}

function handleFrame(frame) {
  switch (frame.t) {
    case 'welcome': return onWelcome(frame);
    case 'msg': return onIncomingMessage(frame.message);
    case 'ack': return onAck(frame);
    case 'edit': return onEdit(frame);
    case 'del': return onDelete(frame);
    case 'react': return onReaction(frame);
    case 'read': return onRead(frame);
    case 'typing': return onTyping(frame);
    case 'nick': return onNick(frame);
    case 'sig': return onSignal(frame);
    case 'presence': return onPresence(frame);
    case 'history': return onHistory(frame);
    case 'burned': return onBurned();
    case 'err': return onServerError(frame);
    default: return undefined;
  }
}

async function onWelcome(frame) {
  app.me = { id: frame.you.id, ...findMember(frame.members, frame.you.id) };
  app.limits = frame.room.limits ?? app.limits;
  // Erst die laufende Sitzung aktualisieren: ohne nutzbaren localStorage gibt
  // patchSession() null zurueck, und das Token ginge sonst verloren.
  const patch = { token: frame.you.token, memberId: frame.you.id, lastActivity: Date.now() };
  app.session = { ...app.session, ...patch };
  patchSession(app.session.roomId, patch);
  if (app.conn) app.conn.token = frame.you.token;

  app.members.clear();
  for (const raw of frame.members ?? []) {
    if (raw.id === frame.you.id) continue;
    const member = memberOf(raw.id);
    member.online = raw.online === true;
    member.lastSeen = raw.lastSeen ?? 0;
    member.readSeq = raw.readSeq ?? 0;
    if (raw.nickCt) member.nick = (await safeDecrypt(raw.nickCt))?.n ?? '';
  }
  // Und gleich merken. Ohne das war der Name nur so lange bekannt, wie der
  // Chat offen stand - in der Übersicht stand danach wieder "Gegenüber",
  // bei jedem Chat, und keiner liess sich vom anderen unterscheiden. In einer
  // Gruppe trägt der eigene Name der Gruppe, nicht der eines Mitglieds.
  if (!isGroup()) rememberPeerNick(peerOf()?.nick);
  // Wer beim Betreten schon da ist, ist nicht gerade gekommen. Den Zustand
  // also übernehmen, ohne ihn zu melden.
  soundPresence(anyOnline(), { silent: true });

  if (app.session.nick) sendNick(app.session.nick);

  app.hasMore = frame.hasMore === true;
  await renderHistory(frame.messages, { replace: true });

  if (currentScreen() === 'group') {
    // Wer gerade Codes verteilt, wird nicht in den Chat geschoben - er ist
    // mitten in einer Aufgabe.
    updateGroupProgress();
  } else if (currentScreen() !== 'invite') {
    showChatScreen();
  } else if (app.members.size > 0 && !app.inviteFromChat) {
    // Es war schon jemand da - dann direkt in den Chat.
    showChatScreen();
  } else {
    setInviteWaiting(app.members.size > 0);
  }
  updatePeerStatus();
  markRead();
}

const findMember = (members, id) => members.find((member) => member.id === id) ?? {};

function onServerError(frame) {
  if (frame.cid) {
    const entry = app.pending.get(frame.cid);
    if (entry) markFailed(entry);
  }
  const messages = {
    rate_limited: t('errorRateLimited'),
    message_too_large: t('errorTooLarge', { max: formatBytes(app.limits.maxCiphertextBytes ?? 65536) }),
    room_full: t('errorRoomFull'),
  };
  toast(messages[frame.code] ?? frame.msg ?? t('errorTitle'));
}

function onBurned() {
  if (app.session) removeSession(app.session.roomId);
  teardownChat();
  // Das Gegenueber hat den Chat vernichtet: alles weg, und man steht wieder
  // am Anfang. Dafuer reicht ein Hinweis am Rand nicht - wer gerade woanders
  // hinsieht, bekaeme davon sonst gar nichts mit.
  playSound('error');
  toast(t('burnDone'), 3200);
  showStart();
}

// ===========================================================================
// Nachrichten: Modell
// ===========================================================================

async function safeDecrypt(ciphertext) {
  if (!ciphertext) return null;
  try {
    return await decryptJson(app.key, ciphertext);
  } catch {
    return null;
  }
}

/** Serverdatensatz plus entschluesselter Inhalt. */
async function toEntry(message) {
  const payload = message.deleted ? null : await safeDecrypt(message.ct);
  const reactions = {};
  for (const [memberId, ct] of Object.entries(message.reactions ?? {})) {
    const value = await safeDecrypt(ct);
    if (value?.e) reactions[memberId] = value.e;
  }
  return {
    id: message.id,
    seq: message.seq,
    from: message.from,
    ts: message.ts,
    deleted: message.deleted === true,
    editedAt: message.editedAt ?? null,
    att: message.att ?? [],
    payload,
    reactions,
    status: 'sent',
    node: null,
  };
}

const isMine = (entry) => entry.pending === true || entry.from === app.me?.id;

// ---------------------------------------------------------------------------
// Wer sonst noch da ist
// ---------------------------------------------------------------------------

/** Ist das hier eine Gruppe oder ein Zweiergespräch? */
const isGroup = () => app.session?.kind === 'group';
/** Alle anderen, in der Reihenfolge, in der sie bekannt wurden. */
const others = () => [...app.members.values()];
/** Im Zweiergespräch das Gegenüber; in einer Gruppe niemand Bestimmtes. */
const peerOf = () => (isGroup() ? null : others()[0] ?? null);
/** Ist gerade überhaupt jemand da? */
const anyOnline = () => others().some((member) => member.online);
const onlineCount = () => others().filter((member) => member.online).length;
const typingNow = () => others().filter((member) => member.typing);

/** Holt ein Mitglied - und legt es an, wenn es noch keines gab. */
function memberOf(id) {
  let member = app.members.get(id);
  if (!member) {
    member = { id, nick: '', online: false, lastSeen: 0, typing: false, readSeq: 0, typingTimer: null };
    app.members.set(id, member);
  }
  return member;
}

/** Wie jemand heisst. */
const nameOf = (id) => memberName(app.members.get(id));

/**
 * Eine Aufzählung von Namen, wie man sie spricht: "Anna", "Anna und Bea",
 * "Anna, Bea und 2 weitere". Ab drei wird gezählt statt aufgezählt - sonst
 * schiebt eine tippende Gruppe die Kopfzeile auseinander.
 */
function nameList(members) {
  const namen = members.map((member) => memberName(member));
  if (namen.length <= 1) return namen[0] ?? '';
  if (namen.length === 2) return t('nameAnd', { first: namen[0], second: namen[1] });
  return t('nameMore', { first: namen[0], second: namen[1], count: namen.length - 2 });
}

/**
 * Wie jemand heisst - und wenn er sich keinen Namen gegeben hat, wenigstens
 * unterscheidbar.
 *
 * In einem Zweiergespräch reicht "Gegenüber": es gibt nur eines. In einer
 * Gruppe hiessen damit alle Namenlosen gleich, und man wüsste bei keiner
 * Blase, von wem sie kommt. Durchnummeriert wird nach der Mitglieds-Kennung,
 * nicht nach der Reihenfolge des Eintreffens - die ist auf jedem Gerät eine
 * andere, und dann hiesse dieselbe Person bei jedem anders.
 */
function memberName(member) {
  const eigener = (member?.nick || '').trim();
  if (eigener) return eigener;
  if (!isGroup() || !member) return t('partner');
  const namenlos = others()
    .filter((anderer) => !(anderer.nick || '').trim())
    .map((anderer) => anderer.id)
    .sort();
  const platz = namenlos.indexOf(member.id);
  return platz < 0 ? t('partner') : t('unnamedMember', { n: platz + 1 });
}

/** Haben alle anderen bis hierher gelesen? */
function allRead(seq) {
  const liste = others();
  return liste.length > 0 && liste.every((member) => (member.readSeq ?? 0) >= seq);
}

function insertEntry(entry) {
  app.messages.set(entry.id, entry);
  app.oldestSeq = Math.min(app.oldestSeq, entry.seq);
  const index = app.order.findIndex((id) => (app.messages.get(id)?.seq ?? 0) > entry.seq);
  if (index === -1) app.order.push(entry.id);
  else app.order.splice(index, 0, entry.id);
  return index;
}

async function renderHistory(messages, { replace = false } = {}) {
  const list = el('messages');
  if (replace) {
    list.replaceChildren();
    app.messages.clear();
    app.order = [];
    app.oldestSeq = Infinity;
  }
  const entries = await Promise.all(messages.map(toEntry));
  for (const entry of entries) insertEntry(entry);
  // Noch nicht quittierte Nachrichten ueberleben einen Wiederaufbau des Verlaufs.
  if (replace) {
    for (const pending of app.pending.values()) insertEntry(pending);
  }
  redrawAll();
  scrollToBottom(true);
}

async function onHistory(frame) {
  app.loadingMore = false;
  app.hasMore = frame.hasMore === true;
  if (!frame.messages.length) return;
  const list = el('messages');
  const previousHeight = list.scrollHeight;
  const previousTop = list.scrollTop;
  const entries = await Promise.all(frame.messages.map(toEntry));
  for (const entry of entries) insertEntry(entry);
  redrawAll();
  // Scrollposition halten, damit einem der Inhalt nicht wegrutscht.
  list.scrollTop = previousTop + (list.scrollHeight - previousHeight);
}

async function onIncomingMessage(message) {
  // Beim Abholen kann dieselbe Nachricht ein zweites Mal hereinkommen -
  // etwa die eigene, die man gerade selbst geschickt hat.
  if (app.messages.has(message.id)) return;
  const entry = await toEntry(message);
  insertEntry(entry);
  redrawAll();

  if (isMine(entry)) {
    scrollToBottom();
    return;
  }
  patchSession(app.session.roomId, { lastActivity: Date.now() });
  if (app.atBottom && document.visibilityState === 'visible') {
    scrollToBottom();
    markRead();
  } else {
    app.unread += 1;
    updateJumpButton();
  }
  notifyIncoming(entry);
}

function onAck(frame) {
  const entry = app.pending.get(frame.cid);
  if (!entry) return;
  app.pending.delete(frame.cid);
  app.messages.delete(entry.id);
  const orderIndex = app.order.indexOf(entry.id);
  if (orderIndex !== -1) app.order.splice(orderIndex, 1);

  // Kam die Nachricht über das Abholen schon zurück, ist sie bereits da.
  if (app.messages.has(frame.id)) {
    redrawAll();
    return;
  }
  entry.id = frame.id;
  entry.seq = frame.seq;
  entry.ts = frame.ts;
  entry.status = 'sent';
  entry.pending = false;
  entry.from = app.me?.id ?? entry.from;
  insertEntry(entry);
  redrawAll();
}

async function onEdit(frame) {
  const entry = app.messages.get(frame.id);
  if (!entry) return;
  entry.payload = await safeDecrypt(frame.ct);
  entry.editedAt = frame.editedAt;
  redrawAll();
}

function onDelete(frame) {
  const entry = app.messages.get(frame.id);
  if (!entry) return;
  entry.deleted = true;
  entry.payload = null;
  entry.reactions = {};
  entry.att = [];
  redrawAll();
}

async function onReaction(frame) {
  const entry = app.messages.get(frame.id);
  if (!entry) return;
  if (frame.ct == null) delete entry.reactions[frame.from];
  else {
    const value = await safeDecrypt(frame.ct);
    if (value?.e) entry.reactions[frame.from] = value.e;
  }
  redrawAll();
}

function onRead(frame) {
  if (frame.from === app.me?.id) return;
  const member = app.members.get(frame.from);
  if (member) member.readSeq = Math.max(member.readSeq ?? 0, frame.seq);
  redrawAll();
}

function onTyping(frame) {
  if (frame.from === app.me?.id) return;
  const member = app.members.get(frame.from);
  if (!member) return;
  member.typing = frame.on === true;
  // Je Person eine eigene Frist: mit einer gemeinsamen würde in einer Gruppe
  // der eine das Tippen des anderen abräumen.
  clearTimeout(member.typingTimer);
  if (member.typing) {
    member.typingTimer = setTimeout(() => {
      member.typing = false;
      updatePeerStatus();
      syncTypingBubble();
    }, TYPING_TIMEOUT);
  }
  updatePeerStatus();
  syncTypingBubble();
}

async function onNick(frame) {
  if (frame.from === app.me?.id) return;
  const value = await safeDecrypt(frame.ct);
  const member = memberOf(frame.from);
  member.nick = value?.n ?? '';
  if (!isGroup()) rememberPeerNick(member.nick);
  updatePeerStatus();
  // In der Gruppe steht der Name über jeder fremden Blase - die müssen mit.
  if (isGroup()) redrawAll();
}

/**
 * Merkt sich, wie das Gegenüber heisst - für die Übersicht auf der
 * Startseite. Ein leerer Name überschreibt keinen bekannten: wer seinen
 * Namen wieder löscht, soll nicht dafür sorgen, dass die eigene Liste
 * plötzlich wieder aus lauter "Gegenüber" besteht.
 */
function rememberPeerNick(nick) {
  const sauber = (nick ?? '').trim();
  if (!sauber || !app.session || app.session.peerNick === sauber) return;
  app.session = patchSession(app.session.roomId, { peerNick: sauber }) ?? { ...app.session, peerNick: sauber };
  renderChatList();
}

function onPresence(frame) {
  if (frame.from === app.me?.id) return;
  const member = memberOf(frame.from);
  member.online = frame.online;
  member.lastSeen = frame.lastSeen;
  if (!frame.online) {
    member.typing = false;
    clearTimeout(member.typingTimer);
    // Wer weg ist, kann nicht mehr reden. Lieber ehrlich beenden, als eine
    // tote Leitung offen stehen lassen.
    // In einer Gruppe gibt es (noch) keine Anrufe - und ohne sie auch
    // niemanden, dessen Weggehen eine Leitung beendet.
    if (!isGroup() && app.call?.busy) app.call.finish('remote_hangup');
  }
  // Gemeldet wird nicht jeder Einzelne, sondern ob überhaupt jemand da ist:
  // im Zweiergespräch ist das dasselbe, in einer Gruppe erspart es ein
  // Glockenspiel, sobald sich mehrere gleichzeitig bewegen.
  soundPresence(anyOnline());
  updateGroupProgress();
  if (currentScreen() === 'invite' && frame.online) {
    setInviteWaiting(true);
    if (!app.inviteFromChat) {
      toast(t('peerArrived'));
      showChatScreen();
    }
  }
  updatePeerStatus();
  syncTypingBubble();
  redrawAll();
}

/**
 * Kommen und Gehen hörbar machen - aber erst, wenn es wirklich eines ist.
 *
 * Anwesenheit zappelt. Beim WebSocket meldet der Server "weg", sobald der
 * letzte Socket zugeht: jede Bildschirmsperre, jeder Wechsel von WLAN auf
 * Mobilfunk, jedes Einfrieren eines Hintergrund-Tabs. Beim Abholen per HTTP
 * liegen zwischen Zeitablauf und nächstem Poll nur wenige Sekunden Reserve.
 * Wer im Zug sitzt, löst so alle paar Minuten ein Kommen und ein Gehen aus.
 *
 * Deshalb klingt es erst, wenn der neue Zustand ein paar Sekunden gehalten
 * hat - und gar nicht, wenn er vorher zurückkippt. Ein Zappler bleibt still,
 * wer wirklich kommt, wird ein paar Sekunden später gemeldet. Das ist bei
 * einer Nebeninformation der bessere Tausch.
 */
const PRESENCE_SETTLE = 4000;
let presenceTimer = null;
/** Der zuletzt gemeldete Zustand. `null` heisst: noch nie etwas gemeldet. */
let presenceSounded = null;

/**
 * @param {boolean} online
 * @param {{silent?: boolean}} [options] `silent` übernimmt den Zustand, ohne
 *   ihn zu melden - für den Augenblick, in dem man den Chat betritt.
 */
function soundPresence(online, { silent = false } = {}) {
  clearTimeout(presenceTimer);
  presenceTimer = null;
  // Beim ersten Mal gibt es nichts zu melden: dass jemand da ist, wenn man
  // hereinkommt, ist kein Kommen.
  if (silent || presenceSounded === null) {
    presenceSounded = online;
    return;
  }
  // Zurückgekippt, bevor der Ton fällig war: dann ist nichts geschehen.
  if (online === presenceSounded) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    presenceSounded = online;
    playSound(online ? 'join' : 'leave');
  }, PRESENCE_SETTLE);
}

/** Beim Verlassen eines Chats darf kein Ton mehr aus dem alten nachkommen. */
function forgetPresenceSound() {
  clearTimeout(presenceTimer);
  presenceTimer = null;
  presenceSounded = null;
}

// ===========================================================================
// Nachrichten: Darstellung
// ===========================================================================

function showChatScreen() {
  // Am Rechner steht die Liste daneben und soll den offenen Chat hervorheben.
  renderChatList();
  showScreen('chat');
  // Am Handy verschwindet die Liste - dann muss auch niemand nach ihr fragen.
  watchOverview();
  updateCallButtons();
  updatePeerStatus();
  redrawAll();
  scrollToBottom(true);
  requestAnimationFrame(() => scrollToBottom(true));
}

/**
 * Zeichnet die Liste neu. Bei zwei Personen und wenigen hundert Nachrichten
 * ist das schnell genug - und deutlich weniger fehleranfaellig als
 * differenzielle Updates.
 */
function redrawAll() {
  const list = el('messages');
  if (!list || currentScreen() !== 'chat') return;
  const fragment = document.createDocumentFragment();
  let previous = null;

  if (app.hasMore) {
    const more = make('button', 'btn btn--ghost load-more', t('loadOlder'));
    more.type = 'button';
    more.id = 'load-older';
    more.disabled = app.loadingMore;
    more.addEventListener('click', loadMore);
    fragment.appendChild(more);
  }

  for (const id of app.order) {
    const entry = app.messages.get(id);
    if (!entry) continue;
    if (!previous || !sameDay(previous.ts, entry.ts)) {
      fragment.appendChild(make('div', 'day-sep', formatDay(entry.ts)));
    }
    const sameSender = previous
      && previous.from === entry.from
      && sameDay(previous.ts, entry.ts)
      && entry.ts - previous.ts < 5 * 60 * 1000;
    fragment.appendChild(buildMessageNode(entry, sameSender));
    previous = entry;
  }

  list.replaceChildren(fragment);
  syncTypingBubble();
  observeMedia();
  if (app.atBottom) scrollToBottom(true);
}

let typingNode = null;

/** Haengt die Tippblase an oder nimmt sie weg, ohne die Liste neu zu bauen. */
function syncTypingBubble() {
  const list = el('messages');
  if (!list) return;
  const shouldShow = typingNow().length > 0 && currentScreen() === 'chat';
  if (!shouldShow) {
    typingNode?.remove();
    return;
  }
  if (!typingNode) {
    typingNode = make('div', 'msg msg--in');
    const bubble = make('div', 'bubble typing-bubble');
    bubble.append(make('i'), make('i'), make('i'));
    typingNode.appendChild(bubble);
  }
  list.appendChild(typingNode);
  if (app.atBottom) scrollToBottom(true);
}

function buildMessageNode(entry, sameSender) {
  const mine = isMine(entry);
  const wrapper = make('div', `msg ${mine ? 'msg--out' : 'msg--in'}${sameSender ? ' msg--same' : ''}`);
  wrapper.dataset.id = entry.id;

  const bubble = make('div', 'bubble');
  // In einer Gruppe steht über fremden Blasen, von wem sie kommt - sonst
  // wüsste niemand, wer gerade spricht. Nur beim ersten Beitrag einer Folge:
  // bei jeder einzelnen Zeile wäre es eine Wand aus Namen.
  if (isGroup() && !mine && !sameSender) {
    bubble.appendChild(make('span', 'bubble__from', nameOf(entry.from)));
  }
  const payload = entry.payload;

  if (entry.deleted) {
    bubble.classList.add('is-deleted');
    bubble.appendChild(make('span', 'bubble__text', t('messageDeleted')));
  } else if (!payload) {
    bubble.classList.add('is-deleted');
    bubble.appendChild(make('span', 'bubble__text', t('undecryptable')));
  } else {
    if (payload.reply) bubble.appendChild(buildQuote(payload.reply));
    const media = payload.media;
    if (payload.kind === 'image' && entry.att[0]) {
      bubble.classList.add('is-media');
      bubble.appendChild(buildImageNode(entry, media));
    } else if (payload.kind === 'audio' && entry.att[0]) {
      bubble.appendChild(buildVoiceNode(entry, media));
    } else if (payload.kind === 'file' && entry.att[0]) {
      bubble.appendChild(buildFileNode(entry, media));
    }
    if (payload.text) {
      const text = make('span', 'bubble__text');
      text.appendChild(linkify(payload.text));
      bubble.appendChild(text);
    }
  }

  bubble.appendChild(buildMeta(entry, mine));
  wrapper.appendChild(bubble);

  const reactions = Object.entries(entry.reactions ?? {});
  if (reactions.length) {
    const row = make('div', 'reactions');
    for (const [memberId, emoji] of reactions) {
      const chip = make('button', `reaction${memberId === app.me?.id ? ' is-mine' : ''}`, emoji);
      chip.type = 'button';
      chip.addEventListener('click', () => pickReaction(entry, emoji));
      row.appendChild(chip);
    }
    wrapper.appendChild(row);
  }

  if (!entry.deleted) {
    onLongPress(bubble, () => openMessageMenu(entry));
    // Ohne Finger gibt es kein langes Druecken. Am Rechner erscheint deshalb
    // beim Ueberfahren ein Knopf neben der Blase; die rechte Maustaste tut es
    // weiterhin auch.
    const more = make('button', 'msg__more');
    more.type = 'button';
    more.setAttribute('aria-label', t('menu'));
    more.appendChild(icon('i-more'));
    more.addEventListener('click', () => openMessageMenu(entry));
    wrapper.appendChild(more);
  }
  entry.node = wrapper;
  return wrapper;
}

function buildQuote(reply) {
  const quote = make('div', 'quote');
  // Wer zitiert wird, steht mit Namen da - in einer Gruppe ist "das
  // Gegenüber" schlicht falsch, es gibt mehrere.
  const wer = reply.from === app.me?.id ? t('you') : (isGroup() ? nameOf(reply.from) : peerName());
  quote.appendChild(make('strong', null, wer));
  quote.appendChild(document.createTextNode(reply.text ?? ''));
  quote.addEventListener('click', () => jumpTo(reply.id));
  return quote;
}

function buildMeta(entry, mine) {
  const meta = make('div', 'bubble__meta');
  if (entry.editedAt) meta.appendChild(make('span', null, t('edited')));
  meta.appendChild(make('span', null, formatClock(entry.ts)));
  if (!mine) return meta;

  if (entry.status === 'sending') meta.appendChild(icon('i-clock'));
  else if (entry.status === 'failed') {
    const retry = make('button', 'btn btn--ghost', '↻');
    retry.type = 'button';
    retry.addEventListener('click', () => resend(entry));
    meta.appendChild(retry);
  } else if (allRead(entry.seq)) {
    // In einer Gruppe erst, wenn WIRKLICH alle gelesen haben. Alles andere
    // wäre eine Bestätigung, die man nicht bekommen hat.
    const mark = icon('i-check-double');
    mark.classList.add('is-read');
    meta.appendChild(mark);
  } else if (anyOnline()) {
    meta.appendChild(icon('i-check-double'));
  } else {
    meta.appendChild(icon('i-check'));
  }
  return meta;
}

function buildImageNode(entry, media) {
  const wrap = make('div', 'image-wrap');
  const image = make('img', 'bubble__image is-loading');
  image.alt = entry.payload?.text || t('image');
  image.decoding = 'async';
  if (media?.width && media?.height) {
    image.width = media.width;
    image.height = media.height;
    wrap.style.aspectRatio = `${media.width} / ${media.height}`;
  }
  const cached = urlCache.get(entry.att[0]);
  if (cached) {
    image.src = cached;
    image.dataset.ready = '1';
    image.classList.remove('is-loading');
  } else if (media?.thumb) {
    image.src = media.thumb;
  }
  image.dataset.blob = entry.att[0];
  image.dataset.name = media?.name ?? 'bild.jpg';
  image.addEventListener('click', () => {
    if (image.dataset.ready === '1') openLightbox(image.src, entry.payload?.text ?? '', image.dataset.name);
  });
  wrap.appendChild(image);
  return wrap;
}

function buildVoiceNode(entry, media) {
  const row = make('div', 'voice');
  const play = make('button', 'voice__play');
  play.type = 'button';
  play.setAttribute('aria-label', t('voiceMessage'));
  play.appendChild(icon('i-play'));

  const wave = make('div', 'voice__wave');
  // Feste Pseudo-Wellenform: hübsch, ohne die Audiodatei vorher zu dekodieren.
  const bars = 26;
  for (let i = 0; i < bars; i += 1) {
    const bar = make('i');
    const height = 25 + 60 * Math.abs(Math.sin((i + entry.seq) * 1.7));
    bar.style.height = `${height}%`;
    wave.appendChild(bar);
  }
  const time = make('span', 'voice__time', formatDuration(media?.duration ?? 0));
  row.append(play, wave, time);

  play.addEventListener('click', () => toggleVoice(entry, { play, wave, time, media }));
  return row;
}

function buildFileNode(entry, media) {
  const row = make('div', 'file-row');
  row.appendChild(icon('i-file'));
  const name = make('span', 'file-row__name', media?.name ?? t('file'));
  const size = make('span', 'file-row__size', formatBytes(media?.size ?? 0));
  const download = make('button', 'btn btn--icon');
  download.type = 'button';
  download.setAttribute('aria-label', t('save'));
  download.appendChild(icon('i-download'));
  download.addEventListener('click', () => downloadAttachment(entry, media));
  row.append(name, size, download);
  return row;
}

// --------------------------------------------------------------- Medien laden

function observeMedia() {
  app.mediaObserver?.disconnect();
  const list = el('messages');
  if (!list) return;
  app.mediaObserver = new IntersectionObserver((entries) => {
    for (const record of entries) {
      if (!record.isIntersecting) continue;
      const image = record.target;
      app.mediaObserver.unobserve(image);
      void loadImage(image);
    }
  }, { root: list, rootMargin: '400px 0px' });

  for (const image of list.querySelectorAll('img[data-blob]')) {
    if (image.dataset.ready === '1') continue;
    app.mediaObserver.observe(image);
  }
}

const blobCache = new Map();
const urlCache = new Map();

/** Fertige Objekt-URL fuer einen Anhang - einmal entschluesseln reicht. */
async function attachmentUrl(blobId, mime) {
  if (urlCache.has(blobId)) return urlCache.get(blobId);
  const bytes = await fetchAttachment(blobId);
  const url = objectUrl(bytes, mime);
  urlCache.set(blobId, url);
  return url;
}

async function fetchAttachment(blobId) {
  if (blobCache.has(blobId)) return blobCache.get(blobId);
  const promise = (async () => {
    const sealed = await downloadBlob(app.session.roomId, app.session.token, blobId);
    return decryptBytes(app.key, sealed);
  })();
  blobCache.set(blobId, promise);
  try {
    return await promise;
  } catch (error) {
    blobCache.delete(blobId);
    throw error;
  }
}

function objectUrl(bytes, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
  app.objectUrls.add(url);
  return url;
}

async function loadImage(image) {
  const blobId = image.dataset.blob;
  if (!blobId || image.dataset.ready === '1') return;
  try {
    const entry = app.messages.get(image.closest('.msg')?.dataset.id ?? '');
    image.src = await attachmentUrl(blobId, entry?.payload?.media?.mime ?? 'image/jpeg');
    image.dataset.ready = '1';
    image.classList.remove('is-loading');
  } catch {
    image.classList.remove('is-loading');
    image.alt = t('errorImage');
  }
}

async function downloadAttachment(entry, media) {
  try {
    busy(true, '');
    const url = await attachmentUrl(entry.att[0], media?.mime);
    const anchor = make('a');
    anchor.href = url;
    anchor.download = media?.name ?? 'datei';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } catch {
    toast(t('errorUpload'));
  } finally {
    busy(false);
  }
}

function stopAudioPlayback() {
  if (!app.audioPlaying) return;
  app.audioPlaying.audio.pause();
  app.audioPlaying.onStop?.();
  app.audioPlaying = null;
}

async function toggleVoice(entry, view) {
  if (app.audioPlaying?.id === entry.id) {
    stopAudioPlayback();
    return;
  }
  stopAudioPlayback();
  try {
    const audio = new Audio(await attachmentUrl(entry.att[0], view.media?.mime ?? 'audio/webm'));
    const bars = [...view.wave.children];
    const reset = () => {
      view.play.replaceChildren(icon('i-play'));
      for (const bar of bars) bar.classList.remove('is-played');
      view.time.textContent = formatDuration(view.media?.duration ?? 0);
    };
    audio.addEventListener('timeupdate', () => {
      const total = Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : (view.media?.duration ?? 1);
      const ratio = Math.min(1, audio.currentTime / total);
      bars.forEach((bar, index) => bar.classList.toggle('is-played', index / bars.length <= ratio));
      view.time.textContent = formatDuration(audio.currentTime);
    });
    audio.addEventListener('ended', () => {
      reset();
      app.audioPlaying = null;
    });
    view.play.replaceChildren(icon('i-pause'));
    app.audioPlaying = { id: entry.id, audio, onStop: reset };
    await audio.play();
  } catch {
    toast(t('errorUpload'));
    stopAudioPlayback();
  }
}

// ===========================================================================
// Scrollen, Kopfzeile, Banner
// ===========================================================================

function scrollToBottom(instant = false) {
  const list = el('messages');
  if (!list) return;
  const behavior = instant ? 'auto' : 'smooth';
  list.scrollTo({ top: list.scrollHeight, behavior });
  app.atBottom = true;
  app.unread = 0;
  updateJumpButton();
}

function updateJumpButton() {
  const button = el('jump-down');
  if (!button) return;
  button.hidden = app.atBottom;
  const badge = el('jump-badge');
  badge.hidden = app.unread === 0;
  badge.textContent = String(Math.min(99, app.unread));
}

/**
 * Wie ein Chat heisst - in der Übersicht wie in der Kopfzeile.
 *
 * Reihenfolge mit Absicht: eine selbst vergebene Bezeichnung gewinnt immer,
 * denn sie ist die ausdrückliche Ansage des Nutzers. Danach der Name, den
 * das Gegenüber sich gegeben hat. Und erst wenn beides fehlt, das blasse
 * "Gegenüber" - das dann hoffentlich nur noch bei einem einzigen Chat steht.
 */
function chatTitle(session) {
  const eigene = (session?.label || '').trim();
  if (eigene) return eigene;
  // Eine Gruppe ohne Namen ist immer noch eine Gruppe.
  if (session?.kind === 'group') return t('group');
  return (session?.peerNick || '').trim() || t('partner');
}

function peerName() {
  const eigene = (app.session?.label || '').trim();
  if (eigene) return eigene;
  if (isGroup()) return t('group');
  return peerOf()?.nick || app.session?.peerNick || t('partner');
}

function updatePeerStatus() {
  if (currentScreen() !== 'chat') return;
  el('peer-name').textContent = peerName();
  el('peer-avatar').textContent = initial(peerName());

  const status = el('peer-status');
  status.classList.remove('is-online', 'is-typing');
  if (app.connectionStatus === 'connecting' || app.connectionStatus === 'reconnecting') {
    status.textContent = t('connecting');
    return;
  }
  const tippen = typingNow();
  if (tippen.length > 0) {
    status.textContent = isGroup() ? t('typingSome', { names: nameList(tippen) }) : t('typing');
    status.classList.add('is-typing');
    return;
  }
  if (isGroup()) {
    // In einer Gruppe hilft "zuletzt gesehen" niemandem - gefragt ist, wie
    // viele gerade da sind. Man selbst zählt mit: sonst stünde "0 von 5",
    // während man selbst im Chat sitzt.
    const da = onlineCount() + 1;
    const alle = app.session?.capacity || app.members.size + 1;
    status.textContent = t('groupPresence', { online: da, total: alle });
    if (da > 1) status.classList.add('is-online');
    return;
  }
  const gegenueber = peerOf();
  if (!gegenueber) {
    status.textContent = t('neverSeen');
    return;
  }
  if (gegenueber.online) {
    status.textContent = t('online');
    status.classList.add('is-online');
    return;
  }
  status.textContent = gegenueber.lastSeen ? t('lastSeen', { time: relativeTime(gegenueber.lastSeen) }) : t('offline');
}

function showBanner(text, warn = false) {
  const banner = el('banner');
  banner.textContent = text;
  banner.classList.toggle('is-warn', warn);
  banner.hidden = false;
}

function hideBanner() {
  el('banner').hidden = true;
}

function jumpTo(messageId) {
  const node = el('messages')?.querySelector(`[data-id="${CSS.escape(messageId)}"]`);
  if (!node) return;
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const bubble = node.querySelector('.bubble');
  bubble?.classList.add('is-selected');
  setTimeout(() => bubble?.classList.remove('is-selected'), 1200);
}

function loadMore() {
  if (app.loadingMore || !app.hasMore) return;
  app.loadingMore = true;
  const button = el('load-older');
  if (button) button.disabled = true;
  app.conn?.send({ t: 'history', before: app.oldestSeq, limit: 100 });
}

// ===========================================================================
// Senden
// ===========================================================================

async function sendMessage() {
  const input = el('message-input');
  const text = input.value.trim();
  const attachments = app.attachments.filter((item) => item.blobId);
  if (!text && attachments.length === 0) return;
  if (!app.conn || !app.me) {
    toast(t('connecting'));
    return;
  }

  input.value = '';
  autoGrow(input);
  updateSendButton();
  // Kaum mehr als ein Antippen - die Quittung fürs Abschicken. Dass sie auch
  // angekommen ist, sagt er nicht; dafür meldet sich markFailed().
  playSound('send');
  stopTyping();

  const reply = app.replyTo
    ? { id: app.replyTo.id, from: app.replyTo.from, text: previewOf(app.replyTo).slice(0, 120) }
    : null;
  app.replyTo = null;
  renderReplyPreview();

  if (attachments.length === 0) {
    await deliver({ v: 1, kind: 'text', text, reply }, []);
  } else {
    // Erster Anhang bekommt den Text als Bildunterschrift, die weiteren gehen einzeln raus.
    for (let i = 0; i < attachments.length; i += 1) {
      const item = attachments[i];
      await deliver({
        v: 1,
        // Ein GIF ist für die Gegenseite schlicht ein Bild.
        kind: item.kind === 'gif' ? 'image' : item.kind,
        text: i === 0 ? text : '',
        reply: i === 0 ? reply : null,
        media: item.media,
      }, [item.blobId]);
    }
    // Per Identitaet, nicht per Merkmal: waehrend des Sendens kann ein neuer
    // Anhang fertig hochgeladen worden sein, der noch nicht mitgeschickt wurde.
    app.attachments = app.attachments.filter((item) => !attachments.includes(item));
    renderAttachments();
  }
  scrollToBottom();
}

/** Verschluesselt, zeigt die Nachricht sofort an und schickt sie los. */
async function deliver(payload, blobIds) {
  const cid = randomId(8);
  const entry = {
    id: `local:${cid}`,
    cid,
    seq: PENDING_SEQ_BASE + (pendingCounter += 1),
    from: app.me?.id ?? '__pending__',
    ts: Date.now(),
    deleted: false,
    editedAt: null,
    att: blobIds,
    payload,
    reactions: {},
    status: 'sending',
    pending: true,
    node: null,
  };
  app.pending.set(cid, entry);
  insertEntry(entry);
  redrawAll();

  try {
    const ct = await encryptJson(app.key, payload);
    app.conn.send({ t: 'msg', cid, ct, blobs: blobIds });
    patchSession(app.session.roomId, { lastActivity: Date.now() });
  } catch {
    markFailed(entry);
  }
}

function markFailed(entry) {
  entry.status = 'failed';
  // Der Ton beim Abschicken ist eine Quittung fürs Abschicken, nicht fürs
  // Ankommen - im Funkloch behauptet er also das Gegenteil dessen, was
  // passiert. Deshalb muss der Fehlschlag hörbar sein.
  playSound('error');
  redrawAll();
}

async function resend(entry) {
  entry.status = 'sending';
  redrawAll();
  try {
    const ct = await encryptJson(app.key, entry.payload);
    app.conn.send({ t: 'msg', cid: entry.cid, ct, blobs: entry.att });
  } catch {
    markFailed(entry);
  }
}

const previewOf = (entry) => {
  if (entry.deleted) return t('messageDeleted');
  const payload = entry.payload;
  if (!payload) return t('undecryptable');
  if (payload.text) return payload.text;
  if (payload.kind === 'image') return `🖼 ${t('image')}`;
  if (payload.kind === 'audio') return `🎤 ${t('voiceMessage')}`;
  if (payload.kind === 'file') return `📎 ${payload.media?.name ?? t('file')}`;
  return '';
};

function sendNick(nick) {
  if (!app.conn) return;
  if (!nick) {
    app.conn.send({ t: 'nick', ct: null });
    return;
  }
  encryptJson(app.key, { n: nick })
    .then((ct) => app.conn?.send({ t: 'nick', ct }))
    .catch(() => {});
}

// ===========================================================================
// Anrufe
// ===========================================================================

/**
 * Ein- und ausgehende Signale werden je in einer Reihe abgearbeitet.
 * Verschlüsseln ist asynchron, und ohne Reihe könnte ein Adresskandidat vor
 * dem Angebot ankommen, zu dem er gehört.
 */
let signalOut = Promise.resolve();
let signalIn = Promise.resolve();
let callTicker = null;
let ringTone = null;
/** Der gerade laufende Klingelklang - damit er sich beim Annehmen abbrechen lässt. */
let ringHandle = null;
let lastRemoteStream = null;
let lastLocalStream = null;
/** Klingelt es gerade? Nur der Wechsel löst eine Benachrichtigung aus. */
let ringing = false;

/** Verschickt ein Aushandlungspaket - verschlüsselt wie jede Nachricht. */
function sendSignal(payload) {
  // Schlüssel und Verbindung jetzt festhalten, nicht erst gleich: bis das
  // Paket verschlüsselt ist, kann längst ein anderer Chat offen sein - und
  // dann ginge es mit dem falschen Schlüssel an den falschen Raum.
  const key = app.key;
  const conn = app.conn;
  if (!key || !conn) return;
  signalOut = signalOut
    .then(async () => {
      conn.send({ t: 'sig', ct: await encryptJson(key, payload) });
    })
    .catch(() => {});
}

/** Ein Aushandlungspaket vom Gegenüber. */
function onSignal(frame) {
  // Beim Abholen per HTTP kommen eigene Frames zurück - die sind hier nichts wert.
  if (frame.from === app.me?.id) return;
  signalIn = signalIn
    .then(async () => {
      const payload = await safeDecrypt(frame.ct);
      // In der Zwischenzeit kann der Chat verlassen worden sein.
      if (!payload || !app.session || !app.key) return;
      // Erst beim ersten echten Signal eine Sitzung anlegen: sonst fragt jeder
      // Seitenaufruf nach Mikrofonrechten, bevor überhaupt jemand anruft.
      await ensureCall().receive(payload);
    })
    .catch(() => {});
}

function ensureCall() {
  if (app.call) return app.call;
  const roomId = app.session.roomId;
  app.call = new CallSession({
    send: sendSignal,
    ice: async () => {
      const body = await iceConfig(roomId, app.session.token);
      return { iceServers: body?.iceServers ?? [] };
    },
    onChange: renderCall,
    // Die Raum-ID hängt am Code, den nur diese beiden kennen. Damit lassen
    // sich Prüfzeichen nicht aus einem anderen Gespräch herüberkopieren.
    salt: roomId,
    // Grundlage für die zweite Schicht über Ton und Bild. Der Schlüssel
    // steckt im Code und war nie auf dem Server.
    roomKey: fromBase64(app.session.key),
    relayOnly: relayOnlyWanted(),
  });
  return app.call;
}

const relayOnlyWanted = () => app.prefs.hideIp === true && app.features.call?.relay === true;

/** Ruft an. @param {'audio'|'video'} kind */
async function startCall(kind) {
  if (!app.session || !app.conn) return;
  if (app.call?.busy) {
    toast(t('callBusyHere'));
    return;
  }
  if (!anyOnline()) {
    toast(t('callNeedsPeer'));
    return;
  }
  const call = ensureCall();
  call.relayOnly = relayOnlyWanted();
  try {
    await call.invite(kind);
  } catch {
    // Warum es nicht ging, sagt renderCall über den Endgrund.
  }
}

/** Zeigt oder verbirgt die beiden Knöpfe in der Kopfzeile. */
function updateCallButtons() {
  const audio = el('btn-call-audio');
  const video = el('btn-call-video');
  if (!audio || !video) return;
  // In einer Gruppe bleiben die Knoepfe weg. Der Aushandlungskanal geht an
  // alle, und der Schluessel fuer Ton und Bild haengt am Raumschluessel -
  // jedes Mitglied koennte damit ein fremdes Gespraech mithoeren. Das
  // gehoert geloest, bevor es hier einen Knopf gibt.
  const offer = app.features.call?.calls === true && currentScreen() === 'chat' && !isGroup();
  audio.hidden = !offer;
  video.hidden = !offer;
}

// ------------------------------------------------------------- Darstellung

/**
 * Warum der Anruf zu Ende ist, in einem Satz.
 *
 * Bewusst ein `switch` statt einer Tabelle mit Schluesselnamen: so sieht der
 * Pruefer der Uebersetzungen jeden Schluessel im Quelltext stehen und merkt
 * es, wenn einer fehlt.
 */
function callEndLabel(reason) {
  switch (reason) {
    case 'hangup':
    case 'remote_hangup': return t('callEndedHangup');
    case 'declined': return t('callEndedDeclined');
    case 'no_answer': return t('callEndedNoAnswer');
    case 'busy': return t('callEndedBusy');
    case 'failed': return t('callEndedFailed');
    case 'no_device': return t('callEndedNoDevice');
    case 'no_permission': return t('callEndedNoPermission');
    default: return '';
  }
}

function renderCall(state) {
  const overlay = el('call');
  if (!overlay) return;

  if (state.state === 'idle' || state.state === 'ended') {
    if (state.state === 'ended' && state.endReason) {
      const label = callEndLabel(state.endReason);
      if (label) toast(label);
      playSound(state.endReason === 'failed' || state.endReason.startsWith('no_') ? 'error' : 'callEnd');
    }
    closeCallScreen();
    return;
  }

  overlay.hidden = false;
  document.body.classList.add('is-calling');
  overlay.dataset.state = state.state;
  overlay.dataset.kind = state.kind;

  el('call-name').textContent = peerName();
  el('call-avatar').textContent = initial(peerName());
  el('call-state').textContent = callStateLabel(state);

  bindStream(el('call-remote'), state.remoteStream, 'remote');
  bindStream(el('call-local'), state.localStream, 'local');
  const showLocal = Boolean(state.localStream?.getVideoTracks().length) && !state.cameraOff;
  el('call-local').hidden = !showLocal;
  // Solange kein fremdes Bild da ist, steht der Name gross in der Mitte. Das
  // Videofeld bleibt trotzdem stehen: dort läuft der Ton, und ein Element mit
  // display:none ist der falsche Ort dafür. Ohne Bild ist es schlicht schwarz.
  const remoteVideo = Boolean(state.remoteStream?.getVideoTracks().length);
  el('call-person').hidden = remoteVideo && state.state === 'active';

  const incoming = state.state === 'ringing';
  if (incoming !== ringing) {
    ringing = incoming;
    notifyCall(state);
  }
  el('call-incoming').hidden = !incoming;
  el('call-actions').hidden = incoming;

  const muteButton = el('call-mute');
  muteButton.classList.toggle('is-off', state.muted);
  muteButton.querySelector('use').setAttribute('href', state.muted ? '#i-mic-off' : '#i-mic');
  muteButton.querySelector('span').textContent = state.muted ? t('callUnmute') : t('callMute');

  const hasCamera = Boolean(state.localStream?.getVideoTracks().length);
  const cameraButton = el('call-camera');
  cameraButton.classList.toggle('is-off', hasCamera && state.cameraOff);
  cameraButton.querySelector('use').setAttribute('href', hasCamera && !state.cameraOff ? '#i-video' : '#i-video-off');
  cameraButton.querySelector('span').textContent = hasCamera && !state.cameraOff ? t('callCameraOff') : t('callCamera');
  el('call-flip').hidden = !hasCamera || state.cameraOff;

  const safety = el('call-safety');
  safety.hidden = !state.safety;
  safety.classList.toggle('is-double', state.doubleEncrypted === true);
  el('call-safety-code').textContent = state.safety;

  // Genau einmal, wenn die Leitung zustande kommt.
  if (state.state === 'active' && !callTicker) playSound('callStart');

  el('call-timer').hidden = state.state !== 'active';
  updateCallTimer(state.startedAt);
  if (state.state === 'active' && !callTicker) {
    callTicker = setInterval(() => updateCallTimer(app.call?.startedAt ?? 0), 1000);
  }

  const hint = el('call-hint');
  const text = callHint(state);
  hint.textContent = text;
  hint.hidden = !text;

  if (incoming) startRingTone();
  else stopRingTone();
}

/**
 * Ein Anruf, der nur im Vordergrund klingelt, ist ein verpasster Anruf.
 * Deshalb geht dieselbe Benachrichtigung heraus wie bei einer Nachricht -
 * mit einem Hinweis, worum es geht, aber ohne Inhalt.
 */
let callNotification = null;

function notifyCall(state) {
  closeCallNotification();
  if (state.state !== 'ringing') return;
  announce(`${peerName()}: ${callStateLabel(state)}`);
  if (!app.prefs.notifications || typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
  try {
    callNotification = new Notification(peerName(), {
      body: callStateLabel(state),
      icon: appUrl('img/icon-192.png'),
      badge: appUrl('img/badge.png'),
      tag: `anruf:${app.session?.roomId ?? ''}`,
      requireInteraction: true,
    });
    callNotification.onclick = () => {
      window.focus();
      closeCallNotification();
    };
  } catch { /* Benachrichtigungen sind Beiwerk */ }
}

function closeCallNotification() {
  try { callNotification?.close(); } catch { /* schon zu */ }
  callNotification = null;
}

function callStateLabel(state) {
  switch (state.state) {
    case 'calling': return t('callRinging');
    case 'ringing': return state.kind === 'video' ? t('callIncomingVideo') : t('callIncoming');
    case 'connecting': return t('callConnecting');
    case 'active': return t('callActive');
    default: return '';
  }
}

/**
 * Ein ehrlicher Hinweis, wenn etwas fehlt oder anders läuft als gedacht -
 * lieber das als eine Funktion, die stillschweigend nicht klappt.
 */
function callHint(state) {
  if (state.state === 'active') {
    if (state.relayed === true) return t('callRouteRelay');
    if (state.relayed === false) return t('callRouteDirect');
    return '';
  }
  if (app.features.call?.relay === false && state.state !== 'ringing') return t('callNoRelayHint');
  return '';
}

/** Setzt einen Strom nur dann neu, wenn er sich wirklich geändert hat. */
function bindStream(video, stream, slot) {
  const last = slot === 'remote' ? lastRemoteStream : lastLocalStream;
  if (last === stream) return;
  if (slot === 'remote') lastRemoteStream = stream;
  else lastLocalStream = stream;
  video.srcObject = stream ?? null;
  if (stream) video.play?.().catch(() => {});
}

function updateCallTimer(startedAt) {
  const node = el('call-timer');
  if (!node || !startedAt) return;
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  node.textContent = `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function closeCallScreen() {
  ringing = false;
  closeCallNotification();
  const overlay = el('call');
  if (overlay) {
    overlay.hidden = true;
    delete overlay.dataset.state;
  }
  document.body.classList.remove('is-calling');
  stopRingTone();
  clearInterval(callTicker);
  callTicker = null;
  bindStream(el('call-remote'), null, 'remote');
  bindStream(el('call-local'), null, 'local');
}

/** Es klingelt: alle zwei Sekunden ein Ton und ein kurzes Rütteln. */
function startRingTone() {
  if (ringTone) return;
  const beat = () => {
    // Den Griff aufheben: der Klang dauert 0,7 s, das Klingeln wiederholt
    // sich alle 2 s. Wer im falschen Drittel annimmt, hörte ihn sonst noch
    // weiterlaufen, während schon der Ton für den stehenden Anruf darüber
    // liegt - zwei Klänge gleichzeitig, wo einer den anderen ablösen soll.
    ringHandle = playSound('ring') || null;
    if (navigator.vibrate) navigator.vibrate([120, 100, 120]);
  };
  beat();
  ringTone = setInterval(beat, 2000);
}

function stopRingTone() {
  ringHandle?.stop();
  ringHandle = null;
  if (!ringTone) return;
  clearInterval(ringTone);
  ringTone = null;
  if (navigator.vibrate) navigator.vibrate(0);
}

/**
 * Der Kamera-Knopf macht zweierlei: läuft schon Bild, schaltet er es ab und
 * wieder an. Bei einem Sprachanruf schaltet er die Kamera überhaupt erst zu -
 * dafür wird im Hintergrund neu ausgehandelt.
 */
async function switchCamera() {
  const call = app.call;
  if (!call) return;
  if (call.localStream?.getVideoTracks().length) {
    call.toggleCamera();
    return;
  }
  try {
    await call.addCamera();
  } catch {
    toast(t('callEndedNoPermission'));
  }
}

/** Erklärt die Prüfzeichen - der Handgriff, der auch ohne Vertrauen trägt. */
function showSafetySheet() {
  const code = app.call?.safety ?? '';
  // Ehrlich sagen, wie viele Schichten wirklich laufen - nicht behaupten,
  // was der Browser gerade nicht kann.
  const layers = app.call?.doubleEncrypted
    ? t('callLayersDouble')
    : (mediaCryptoAvailable() ? t('callLayersPeer') : t('callLayersBrowser'));
  openSheet(t('callSafetyTitle'), [
    make('p', 'sheet-note', t('callSafetyYours')),
    make('p', 'call-safety__big', code),
    make('p', 'sheet-note', t('callSafetyText')),
    make('p', 'sheet-note', layers),
  ]);
}

function markRead() {
  if (!app.conn || !app.order.length) return;
  let highest = 0;
  for (const id of app.order) {
    const entry = app.messages.get(id);
    if (entry && !isMine(entry) && !entry.pending) highest = Math.max(highest, entry.seq);
  }
  if (highest > 0) app.conn.send({ t: 'read', seq: highest });
  // Und merken, wo man steht. Ohne das faengt die Zaehlung in der Uebersicht
  // nach jedem Neuladen wieder bei null an - und alles gaelte als ungelesen.
  noteRead(highest);
}

/** Den eigenen Lesestand festhalten und den Punkt in der Uebersicht loeschen. */
function noteRead(seq) {
  if (!app.session) return;
  const bisher = app.session.readSeq ?? 0;
  if (seq <= bisher && (app.session.unread ?? 0) === 0) return;
  const patch = { readSeq: Math.max(bisher, seq), unread: 0 };
  app.session = patchSession(app.session.roomId, patch) ?? { ...app.session, ...patch };
  renderChatList();
}

// --------------------------------------------------------------- Tippanzeige

function noticeTyping() {
  const now = Date.now();
  if (now - app.lastTypingSent > TYPING_INTERVAL) {
    app.lastTypingSent = now;
    app.conn?.send({ t: 'typing', on: true });
  }
  clearTimeout(app.typingTimer);
  app.typingTimer = setTimeout(stopTyping, TYPING_TIMEOUT);
}

function stopTyping() {
  clearTimeout(app.typingTimer);
  if (app.lastTypingSent === 0) return;
  app.lastTypingSent = 0;
  app.conn?.send({ t: 'typing', on: false });
}

// ===========================================================================
// Anhänge
// ===========================================================================

async function addFiles(files, kind) {
  const list = [...files].slice(0, MAX_ATTACHMENTS - app.attachments.length);
  if (!list.length) {
    if (files.length) toast(t('errorTooLarge', { max: `${MAX_ATTACHMENTS}` }));
    return;
  }
  for (const file of list) {
    const item = {
      localId: randomId(6),
      kind,
      file,
      media: null,
      blobId: null,
      progress: 0,
      previewUrl: null,
      failed: false,
    };
    app.attachments.push(item);
    renderAttachments();
    void prepareAndUpload(item);
  }
  updateSendButton();
}

async function prepareAndUpload(item) {
  try {
    let bytes;
    if (item.kind === 'image') {
      const prepared = await prepareImage(item.file);
      bytes = prepared.bytes;
      item.media = {
        // Bewusst nicht der Originalname: "IMG_20260826_143107.jpg" verrät
        // Aufnahmezeit und Gerätehersteller. Das Bild selbst ist beim
        // Verkleinern schon von allen Metadaten befreit worden.
        name: `bild.${extensionFor(prepared.mime)}`,
        mime: prepared.mime,
        size: bytes.length,
        width: prepared.width,
        height: prepared.height,
        thumb: prepared.thumb,
      };
      item.previewUrl = prepared.thumb || null;
    } else if (item.kind === 'gif') {
      // Die Bytes holt der eigene Server bei Giphy; verschlüsselt werden sie
      // hier, wie jeder andere Anhang auch. Wer das GIF empfängt, spricht
      // nie mit Giphy - es kommt als ganz normaler Anhang an.
      const loaded = await fetchGif(item.ref);
      bytes = loaded.bytes;
      item.media = {
        name: `gif.${extensionFor(loaded.mime)}`,
        mime: loaded.mime,
        size: bytes.length,
        width: item.width,
        height: item.height,
      };
    } else if (item.kind === 'audio') {
      bytes = item.bytes;
      item.media = {
        name: 'sprachnachricht',
        mime: item.mime,
        size: bytes.length,
        duration: item.duration,
      };
    } else {
      bytes = await readFileBytes(item.file);
      item.media = {
        name: item.file.name || 'datei',
        mime: item.file.type || 'application/octet-stream',
        size: bytes.length,
      };
    }

    if (bytes.length > app.limits.maxBlobBytes) {
      throw new ApiError('too_large', t('errorTooLarge', { max: formatBytes(app.limits.maxBlobBytes) }));
    }

    const sealed = await encryptBytes(app.key, bytes);
    const uploaded = await uploadBlob(app.session.roomId, app.session.token, sealed, (ratio) => {
      item.progress = ratio;
      renderAttachments();
    });
    item.blobId = uploaded.id;
    item.progress = 1;
  } catch (error) {
    item.failed = true;
    toast(error instanceof ApiError && error.code === 'too_large' ? error.message : t('errorUpload'));
    app.attachments = app.attachments.filter((other) => other !== item);
  }
  renderAttachments();
  updateSendButton();
}

function renderAttachments() {
  const container = el('attachments');
  if (!container) return;
  container.replaceChildren();
  container.hidden = app.attachments.length === 0;

  for (const item of app.attachments) {
    const box = make('div', 'attachment');
    if (item.previewUrl) {
      const image = make('img');
      image.src = item.previewUrl;
      image.alt = '';
      box.appendChild(image);
    } else {
      box.appendChild(icon(item.kind === 'audio' ? 'i-mic' : 'i-file'));
    }
    if (item.progress < 1) {
      const bar = make('span', 'attachment__progress');
      bar.style.width = `${Math.round(item.progress * 100)}%`;
      box.appendChild(bar);
    }
    const remove = make('button', 'attachment__remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', t('removeAttachment'));
    remove.appendChild(icon('i-close'));
    remove.addEventListener('click', () => {
      app.attachments = app.attachments.filter((other) => other !== item);
      renderAttachments();
      updateSendButton();
    });
    box.appendChild(remove);
    container.appendChild(box);
  }
}

function renderReplyPreview() {
  const preview = el('reply-preview');
  if (!preview) return;
  preview.hidden = !app.replyTo;
  if (app.replyTo) el('reply-preview-text').textContent = previewOf(app.replyTo);
}

// ===========================================================================
// Sprachnachricht
// ===========================================================================

async function beginRecording() {
  if (!canRecordAudio()) {
    toast(t('errorMic'));
    return;
  }
  try {
    const recorder = await startRecording({
      onTick: (seconds) => { el('rec-time').textContent = formatDuration(seconds); },
      onLevel: (level) => { el('rec-level-bar').style.width = `${Math.round(level * 100)}%`; },
    });
    app.recorder = recorder;
    el('rec-time').textContent = '0:00';
    el('recorder').setAttribute('aria-label', t('recording'));
    el('recorder').hidden = false;
    el('composer').hidden = true;
  } catch {
    toast(t('errorMic'));
  }
}

async function finishRecording(send) {
  const recorder = app.recorder;
  app.recorder = null;
  el('recorder').hidden = true;
  el('composer').hidden = false;
  if (!recorder) return;

  if (!send) {
    recorder.cancel();
    return;
  }
  const result = await recorder.stop();
  if (result.duration < 0.4 || result.bytes.length === 0) return;

  const item = {
    localId: randomId(6),
    kind: 'audio',
    file: null,
    bytes: result.bytes,
    mime: result.mime,
    duration: result.duration,
    media: null,
    blobId: null,
    progress: 0,
    previewUrl: null,
  };
  app.attachments.push(item);
  renderAttachments();
  await prepareAndUpload(item);
  if (item.blobId) await sendMessage();
}

// ===========================================================================
// Menüs
// ===========================================================================

function openAttachSheet() {
  openSheet(t('attach'), [
    {
      icon: 'i-image',
      label: t('fromGallery'),
      hint: t('fromGalleryHint'),
      onClick: () => el('file-gallery').click(),
    },
    {
      icon: 'i-camera',
      label: t('fromCamera'),
      hint: t('fromGalleryHint'),
      onClick: () => el('file-camera').click(),
    },
    {
      // Ehrlich bleiben: eine Datei geht Byte für Byte raus. Bei einem Video
      // steckt der Aufnahmeort oft mit drin, und daran ändert die App nichts.
      icon: 'i-file',
      label: t('anyFile'),
      hint: t('anyFileHint'),
      onClick: () => el('file-any').click(),
    },
    ...(app.features.gifs ? [{
      icon: 'i-gif',
      label: t('searchGif'),
      hint: t('searchGifHint'),
      onClick: openGifPicker,
    }] : []),
  ]);
}

/**
 * GIF-Suche. Läuft vollständig über den eigenen Server: Giphy sieht ihn,
 * nicht das Gerät. Die Vorschaubilder kommen von der eigenen Adresse, also
 * bleibt auch die strenge CSP unangetastet.
 */
function openGifPicker() {
  let laufendeSuche = 0;
  let tippTimer = null;

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'emoji-search';
  search.placeholder = t('searchGifPlaceholder');
  search.autocomplete = 'off';
  search.setAttribute('aria-label', t('searchGifPlaceholder'));

  const grid = make('div', 'gif-grid');
  const status = make('p', 'sheet-note');

  const zeigen = async (query) => {
    const lauf = ++laufendeSuche;
    status.textContent = t('searching');
    status.hidden = false;
    try {
      const { items } = await searchGifs(query);
      // Eine ältere Suche darf eine neuere nicht überschreiben.
      if (lauf !== laufendeSuche) return;
      grid.replaceChildren();
      if (!items.length) {
        status.textContent = t('noGifsFound');
        return;
      }
      status.hidden = true;
      for (const item of items) grid.appendChild(gifButton(item));
    } catch {
      if (lauf !== laufendeSuche) return;
      status.textContent = t('gifServiceDown');
      status.hidden = false;
    }
  };

  search.addEventListener('input', () => {
    clearTimeout(tippTimer);
    // Nicht bei jedem Tastendruck losschicken - das wären zwölf Bilder je
    // Buchstabe über den eigenen Server.
    tippTimer = setTimeout(() => void zeigen(search.value.trim()), 350);
  });

  const box = make('div', 'gif-picker');
  box.append(search, status, grid);
  openSheet(t('searchGif'), [box], { onClose: () => clearTimeout(tippTimer) });
  requestAnimationFrame(() => search.focus({ preventScroll: true }));
  void zeigen('');
}

function gifButton(item) {
  const button = make('button', 'gif-grid__item');
  button.type = 'button';
  button.setAttribute('aria-label', item.title || 'GIF');
  const image = make('img');
  image.src = gifMediaUrl(item.preview);
  image.alt = item.title || '';
  image.loading = 'lazy';
  // Platz freihalten, damit das Raster beim Nachladen nicht springt.
  image.style.aspectRatio = `${item.width} / ${item.height}`;
  button.appendChild(image);
  button.addEventListener('click', () => {
    closeSheet();
    addGif(item);
  });
  return button;
}

function addGif(item) {
  if (app.attachments.length >= MAX_ATTACHMENTS) {
    toast(t('errorTooLarge', { max: `${MAX_ATTACHMENTS}` }));
    return;
  }
  const entry = {
    localId: randomId(6),
    kind: 'gif',
    ref: item.full,
    width: item.width,
    height: item.height,
    media: null,
    blobId: null,
    progress: 0,
    previewUrl: gifMediaUrl(item.preview),
    failed: false,
  };
  app.attachments.push(entry);
  renderAttachments();
  void prepareAndUpload(entry);
  updateSendButton();
}

function openMessageMenu(entry) {
  const mine = isMine(entry);
  const items = [buildReactionRow(entry)];

  items.push({ icon: 'i-reply', label: t('reply'), onClick: () => {
    app.replyTo = entry;
    renderReplyPreview();
    el('message-input').focus();
  } });

  if (entry.payload?.text) {
    items.push({ icon: 'i-copy', label: t('copy'), onClick: async () => {
      toast(await copyText(entry.payload.text) ? t('copied') : t('copyFailed'));
    } });
  }
  if (mine && entry.payload?.kind === 'text' && entry.status === 'sent') {
    items.push({ icon: 'i-edit', label: t('edit'), onClick: () => editMessage(entry) });
  }
  if (mine && entry.status === 'sent') {
    items.push({ icon: 'i-trash', label: t('deleteMessage'), danger: true, onClick: () => {
      app.conn?.send({ t: 'del', id: entry.id });
    } });
  }
  openSheet(formatClock(entry.ts), items);
}

/**
 * Die Schnellreihe: erst das zuletzt Benutzte, dann die Vorgaben zum
 * Auffüllen - und am Ende der Weg zu allen übrigen Emoji.
 */
function quickReactions() {
  const recent = (app.prefs.recentEmoji ?? []).filter((emoji) => typeof emoji === 'string');
  const list = [...recent];
  for (const emoji of REACTIONS) {
    if (list.length >= QUICK_REACTIONS) break;
    if (!list.includes(emoji)) list.push(emoji);
  }
  return list.slice(0, QUICK_REACTIONS);
}

function rememberEmoji(emoji) {
  const recent = [emoji, ...(app.prefs.recentEmoji ?? []).filter((item) => item !== emoji)];
  app.prefs = setPrefs({ recentEmoji: recent.slice(0, RECENT_EMOJI_MAX) });
}

function buildReactionRow(entry) {
  const row = make('div', 'emoji-row');
  for (const emoji of quickReactions()) {
    row.appendChild(emojiButton(emoji, () => {
      closeSheet();
      pickReaction(entry, emoji);
    }));
  }
  const more = make('button', 'emoji-more');
  more.type = 'button';
  more.setAttribute('aria-label', t('moreEmoji'));
  more.appendChild(icon('i-plus'));
  more.addEventListener('click', () => openEmojiPicker(entry));
  row.appendChild(more);
  return row;
}

/** Ausgeschrieben, damit die Übersetzungsprüfung die Schlüssel auch findet. */
function groupTitle(id) {
  switch (id) {
    case 'smileys': return t('groupSmileys');
    case 'gestures': return t('groupGestures');
    case 'people': return t('groupPeople');
    case 'nature': return t('groupNature');
    case 'food': return t('groupFood');
    case 'activity': return t('groupActivity');
    case 'travel': return t('groupTravel');
    default: return t('groupObjects');
  }
}

function emojiButton(emoji, onClick) {
  const button = make('button', null, emoji);
  button.type = 'button';
  button.setAttribute('aria-label', emoji);
  button.addEventListener('click', onClick);
  return button;
}

function pickReaction(entry, emoji) {
  rememberEmoji(emoji);
  void toggleReaction(entry, emoji);
}

/**
 * Alle Emoji zur Auswahl - mit Suche und einem Feld für alles, was die
 * mitgelieferte Liste nicht kennt.
 */
function openEmojiPicker(entry) {
  const choose = (emoji) => {
    closeSheet();
    pickReaction(entry, emoji);
  };

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'emoji-search';
  search.placeholder = t('searchEmoji');
  search.autocomplete = 'off';
  search.setAttribute('aria-label', t('searchEmoji'));

  const results = make('div', 'emoji-grid');
  const groups = make('div', 'emoji-groups');

  const paint = () => {
    const query = search.value.trim();
    if (!query) {
      results.hidden = true;
      groups.hidden = false;
      return;
    }
    groups.hidden = true;
    results.hidden = false;
    results.replaceChildren();
    const found = searchEmoji(query);
    if (!found.length) {
      // Auch ein eingefügtes Emoji ist eine gültige Antwort auf die Suche.
      if (looksLikeEmoji(query)) {
        results.appendChild(emojiButton(query, () => choose(query)));
        return;
      }
      results.appendChild(make('p', 'sheet-note', t('noEmojiFound')));
      return;
    }
    for (const emoji of found.slice(0, 120)) {
      results.appendChild(emojiButton(emoji, () => choose(emoji)));
    }
  };
  search.addEventListener('input', paint);
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const first = results.querySelector('button');
    if (first) first.click();
  });

  const recent = (app.prefs.recentEmoji ?? []).slice(0, 16);
  if (recent.length) {
    groups.appendChild(make('h4', 'emoji-group__title', t('recentEmoji')));
    const grid = make('div', 'emoji-grid');
    for (const emoji of recent) grid.appendChild(emojiButton(emoji, () => choose(emoji)));
    groups.appendChild(grid);
  }
  for (const group of emojiGroups()) {
    groups.appendChild(make('h4', 'emoji-group__title', groupTitle(group.id)));
    const grid = make('div', 'emoji-grid');
    for (const emoji of group.emoji) grid.appendChild(emojiButton(emoji, () => choose(emoji)));
    groups.appendChild(grid);
  }

  const box = make('div', 'emoji-picker');
  box.append(search, results, groups);
  results.hidden = true;

  openSheet(t('chooseEmoji'), [box]);
  requestAnimationFrame(() => search.focus({ preventScroll: true }));
}

async function toggleReaction(entry, emoji) {
  const mine = entry.reactions?.[app.me?.id];
  if (mine === emoji) {
    app.conn?.send({ t: 'react', id: entry.id, ct: null });
    return;
  }
  const ct = await encryptJson(app.key, { e: emoji });
  app.conn?.send({ t: 'react', id: entry.id, ct });
}

async function editMessage(entry) {
  const next = await promptSheet(t('edit'), { value: entry.payload.text ?? '', maxLength: 2000 });
  if (next == null || next === entry.payload.text) return;
  const ct = await encryptJson(app.key, { ...entry.payload, text: next });
  app.conn?.send({ t: 'edit', id: entry.id, ct });
}

function openChatMenu() {
  // Achtung: `Notification?.permission` wuerde werfen, wenn es die API gar
  // nicht gibt - Optional Chaining schuetzt nicht vor unbekannten Bezeichnern.
  const notificationsBlocked = typeof Notification !== 'undefined' && Notification.permission === 'denied';
  const notificationLabel = notificationsBlocked
    ? t('notificationsBlocked')
    : (app.prefs.notifications ? t('switchOn') : t('switchOff'));

  openSheet(t('menu'), [
    { icon: 'i-users', label: t('yourName'), value: app.session?.nick || '–', onClick: changeNick },
    {
      icon: 'i-edit',
      label: t('renameChat'),
      hint: t('renameChatHint'),
      value: app.session?.label || '–',
      onClick: () => void renameChat(app.session.roomId),
    },
    // In einer Gruppe gibt es keinen gemeinsamen Code, sondern einen je
    // Person - und die hat nur, wer sie angelegt hat.
    ...(isGroup()
      ? (app.session?.codes?.length
        ? [{ icon: 'i-qr', label: t('groupCodes'), onClick: () => showGroupCodes(app.session) }]
        : [])
      : [{ icon: 'i-qr', label: t('showCode'), onClick: () => showInvite(app.session, { fromChat: true }) }]),
    // Der Geraete-Link traegt den Code. Ohne Code kein Link - fuer Gruppen
    // braeuchte er einen eigenen Weg, den es noch nicht gibt.
    ...(isGroup() ? [] : [{
      icon: 'i-link',
      label: t('linkDevice'),
      hint: t('linkDeviceHint'),
      onClick: shareDeviceLink,
    }]),
    { icon: 'i-bell', label: t('notifications'), value: notificationLabel, onClick: toggleNotifications },
    {
      icon: app.prefs.sound ? 'i-sound' : 'i-sound-off',
      label: t('sound'),
      value: app.prefs.sound ? t('switchOn') : t('switchOff'),
      onClick: toggleSound,
    },
    ...(app.features.call?.relay === true ? [{
      icon: 'i-shield',
      label: t('callHideIp'),
      hint: t('callHideIpHint'),
      value: app.prefs.hideIp ? t('switchOn') : t('switchOff'),
      onClick: toggleHideIp,
    }] : []),
    { icon: 'i-sun', label: t('theme'), value: themeLabel(), onClick: cycleTheme },
    { icon: 'i-globe', label: t('language'), value: getLanguage().toUpperCase(), onClick: cycleLanguage },
    { icon: 'i-info', label: t('about'), onClick: showAbout },
    { icon: 'i-close', label: t('leaveChat'), onClick: leaveChat },
    { icon: 'i-trash', label: t('burnChat'), danger: true, onClick: burnCurrentChat },
  ]);
}

function toggleHideIp() {
  app.prefs = setPrefs({ hideIp: !app.prefs.hideIp });
  if (app.call) app.call.relayOnly = relayOnlyWanted();
  toast(app.prefs.hideIp ? t('callHideIp') + ': ' + t('switchOn') : t('callHideIp') + ': ' + t('switchOff'));
}

async function changeNick() {
  const next = await promptSheet(t('yourName'), {
    value: app.session?.nick ?? '',
    placeholder: t('namePlaceholder'),
    maxLength: 32,
  });
  if (next == null) return;
  app.session = patchSession(app.session.roomId, { nick: next }) ?? app.session;
  app.prefs = setPrefs({ nick: next });
  sendNick(next);
}

async function shareDeviceLink() {
  if (!app.session?.token) return;
  const link = deviceLink(app.session.code, app.session.token);
  if (navigator.share) {
    try {
      await navigator.share({ title: t('appName'), url: link });
      return;
    } catch { /* Abbruch ist kein Fehler */ }
  }
  toast(await copyText(link) ? t('copied') : t('copyFailed'));
}

async function burnCurrentChat() {
  // In einer Gruppe trifft es alle - das muss dastehen, bevor jemand tippt.
  const frage = isGroup() ? t('burnConfirmGroup') : t('burnConfirm');
  const ok = await confirmSheet(t('burnChat'), frage, t('confirm'));
  if (!ok) return;
  const session = app.session;
  try {
    app.conn?.send({ t: 'burn' });
    await burnRoom(session.roomId, session.token).catch(() => {});
  } finally {
    removeSession(session.roomId);
    teardownChat();
    toast(t('burnDone'));
    showStart();
  }
}

const leaveChat = () => leaveSession(app.session.roomId);

/**
 * Einen Chat vom Gerät nehmen. Ist es der gerade offene, muss auch die
 * Verbindung abgebaut werden: sonst läuft er weiter, obwohl Schlüssel und
 * Geräte-Token schon aus dem Speicher gelöscht sind - und ist nach dem
 * nächsten Neuladen unwiederbringlich weg, weil der Raum weiter besetzt ist.
 *
 * Am Handy war dieser Weg nie erreichbar, weil die Liste hinter dem offenen
 * Chat lag. Am Rechner steht sie daneben.
 */
async function leaveSession(roomId) {
  if (!roomId) return;
  const ok = await confirmSheet(t('leaveChat'), t('leaveConfirm'), t('confirm'), { danger: false });
  if (!ok) return;
  removeSession(roomId);
  if (app.session?.roomId === roomId) {
    teardownChat();
    showStart();
  } else {
    renderChatList();
  }
}

function showAbout() {
  openSheet(t('about'), [
    make('p', 'sheet-note', t('aboutText')),
    make('p', 'sheet-note', t('aboutRetention')),
  ]);
}

// ===========================================================================
// Einstellungen: Design, Sprache, Benachrichtigungen
// ===========================================================================

const THEMES = ['auto', 'light', 'dark'];

function themeLabel() {
  return { auto: t('themeAuto'), light: t('themeLight'), dark: t('themeDark') }[app.prefs.theme];
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.system = dark ? 'dark' : 'light';
  const effectiveDark = theme === 'dark' || (theme === 'auto' && dark);
  // Beide Angaben setzen, nicht nur die erste: im Grundgerüst steht je eine
  // für hell und für dunkel, damit der Balken schon vor dem ersten Skript
  // stimmt. Der Browser nimmt die, deren media-Bedingung passt - wer hier nur
  // eine ändert, ändert auf dem jeweils anderen Gerät gar nichts.
  const farbe = effectiveDark ? '#0f1319' : '#f6f7f9';
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute('content', farbe);
  }
  const label = el('theme-label');
  if (label) label.textContent = themeLabel();
}

function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(app.prefs.theme) + 1) % THEMES.length];
  app.prefs = setPrefs({ theme: next });
  applyTheme(next);
  toast(themeLabel());
}

function cycleLanguage() {
  const next = availableLanguages[(availableLanguages.indexOf(getLanguage()) + 1) % availableLanguages.length];
  app.prefs = setPrefs({ lang: next });
  setLanguage(next);
}

function refreshDynamicLabels() {
  const langLabel = el('lang-label');
  if (langLabel) langLabel.textContent = getLanguage().toUpperCase();
  applyTheme(app.prefs.theme);
  if (currentScreen() === 'chat') {
    updateCallButtons();
    updatePeerStatus();
    redrawAll();
  }
  // Am Rechner steht die Liste immer da - also auch immer nachziehen.
  if (currentScreen() === 'start' || isDesktop()) renderChatList();
  if (currentScreen() === 'invite') setInviteWaiting(app.members.size > 0);
  if (currentScreen() === 'group') updateGroupProgress();
}

function toggleSound() {
  app.prefs = setPrefs({ sound: !app.prefs.sound });
  configureSound({ enabled: app.prefs.sound });
  // Wer den Ton anschaltet, soll gleich hören, worauf er sich einlässt.
  if (app.prefs.sound) playSound('notify');
  toast(app.prefs.sound ? t('soundOn') : t('soundOff'));
}

async function toggleNotifications() {
  if (typeof Notification === 'undefined') {
    toast(t('notificationsBlocked'));
    return;
  }
  if (app.prefs.notifications) {
    app.prefs = setPrefs({ notifications: false });
    toast(t('notificationsOff'));
    return;
  }
  const permission = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();
  if (permission !== 'granted') {
    toast(t('notificationsBlocked'));
    return;
  }
  app.prefs = setPrefs({ notifications: true });
  toast(t('notificationsOn'));
}

/** Sagt Screenreadern genau eine neue Nachricht an - nicht den ganzen Verlauf. */
function announce(text) {
  const region = el('live-region');
  if (!region || !text) return;
  region.textContent = '';
  // Ein Tick Pause, damit auch zweimal derselbe Text angesagt wird.
  requestAnimationFrame(() => { region.textContent = text; });
}

function notifyIncoming(entry) {
  announce(`${senderLabel(entry)}: ${previewOf(entry)}`);
  const sichtbar = document.visibilityState === 'visible';
  const vomSystem = !sichtbar && systemMeldung(entry);
  // Wer hinsieht, braucht kein Signal - nur eine Bestätigung. Wer woanders
  // ist, bekommt den eigentlichen Benachrichtigungston.
  //
  // Ausser das Betriebssystem meldet sich schon selbst: dessen Meldung bringt
  // ihren eigenen Ton mit, und zwei Töne übereinander sind einer zu viel.
  // Dann hat der vom System Vorrang - er kommt auch dann noch durch, wenn der
  // Browser die Seite im Hintergrund längst gedrosselt hat.
  if (!vomSystem) playSound(sichtbar ? 'receive' : 'notify');
}

/**
 * Die Meldung des Betriebssystems. Gibt zurück, ob sie wirklich herausging -
 * daran hängt, ob die App zusätzlich einen eigenen Ton spielt.
 */
/**
 * Was ueber der Meldung steht. Im Zweiergespraech reicht der Name des
 * Gegenuebers; in einer Gruppe muss dazu, WER geschrieben hat - sonst meldet
 * sich die Gruppe, und man weiss nicht, von wem.
 */
function senderLabel(entry) {
  if (!isGroup()) return peerName();
  return t('groupFrom', { who: nameOf(entry.from), group: peerName() });
}

function systemMeldung(entry) {
  if (!app.prefs.notifications || typeof Notification === 'undefined') return false;
  if (Notification.permission !== 'granted') return false;
  try {
    const notification = new Notification(senderLabel(entry), {
      body: previewOf(entry).slice(0, 140),
      icon: appUrl('img/icon-192.png'),
      badge: appUrl('img/badge.png'),
      tag: app.session.roomId,
      renotify: false,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
    return true;
  } catch {
    // Benachrichtigungen sind Beiwerk - dann eben der eigene Ton.
    return false;
  }
}

// ===========================================================================
// Startseite: Liste der eigenen Chats
// ===========================================================================

function renderChatList() {
  const list = el('chat-list');
  const section = el('chats-section');
  if (!list || !section) return;
  const sessions = listSessions();
  section.hidden = sessions.length === 0;
  list.replaceChildren();

  for (const session of sessions) {
    const item = make('li');
    const button = make('button', 'chat-list__item');
    button.type = 'button';
    if (session.roomId === app.session?.roomId) {
      button.classList.add('is-active');
      button.setAttribute('aria-current', 'true');
    }
    const name = chatTitle(session);
    const avatar = make('div', 'avatar avatar--sm', initial(name));
    const text = make('div', 'chat-list__text');
    text.appendChild(make('span', 'chat-list__name', name));
    text.appendChild(chatListMeta(session));
    button.append(avatar, text);
    const ungelesen = session.unread ?? 0;
    if (ungelesen > 0) {
      const punkt = make('span', 'pill pill--unread', ungelesen > 99 ? '99+' : String(ungelesen));
      punkt.setAttribute('aria-label', t('unreadCount', { n: ungelesen }));
      button.appendChild(punkt);
    }
    button.appendChild(icon('i-chevron-down'));
    button.addEventListener('click', () => void openFromList(session));
    onLongPress(button, () => openSessionMenu(session));
    item.appendChild(button);
    list.appendChild(item);
  }
}

/**
 * Die zweite Zeile eines Eintrags.
 *
 * Schreibt dort gerade jemand, hat das Vorrang - das ist die einzige Angabe,
 * die gleich wieder verschwindet. Sonst steht da, wann zuletzt etwas KAM.
 * Frueher stand hier der eigene letzte Besuch; das sah aus wie "gerade eben",
 * obwohl seit Tagen nichts gekommen war.
 */
function chatListMeta(session) {
  if (session.typing) {
    const zeile = make('span', 'chat-list__meta is-typing', t('typing'));
    return zeile;
  }
  const zusatz = (session.peerNick || '').trim();
  const hinweis = zusatz && zusatz !== chatTitle(session) ? zusatz : (zusatz ? '' : session.code);
  // Ohne eine einzige fremde Nachricht gibt es nichts zu datieren - dann
  // bleibt es beim Hinweis, und wo auch der fehlt, bei gar nichts.
  const wann = session.lastMessageAt ? relativeTime(session.lastMessageAt) : '';
  const teile = [hinweis, wann].filter(Boolean);
  return make('span', 'chat-list__meta', teile.join(' \u00b7 '));
}

/** Einen Chat aus der Liste oeffnen - Gruppen haben keinen Code. */
function openFromList(session) {
  if (session.kind === 'group') return openSession({ ...session, unread: 0 }, { screen: 'chat' });
  return enterChat(session.code, { known: session });
}

/**
 * Haelt die Liste auf der Startseite lebendig.
 *
 * Die App ist immer nur mit EINEM Raum verbunden. Ueber die anderen erfaehrt
 * sie nichts - ausser sie fragt nach. Das tut sie hier, aber nur, solange die
 * Liste ueberhaupt zu sehen ist und die Seite im Vordergrund steht: im
 * Hintergrund zu fragen kostet Akku und beantwortet niemandem eine Frage.
 */
/**
 * Wie oft nachgefragt wird, solange die Liste zu sehen ist.
 *
 * Der Takt richtet sich nach der Tippanzeige, nicht nach den Nachrichten:
 * wer aufhoert zu tippen, gilt noch 4 s als tippend (TYPING_TIMEOUT), und der
 * Server vergisst es nach 5 s. Wer seltener fragt als das, verpasst das
 * Tippen regelmaessig - und eine Anzeige, die meistens fehlt, ist schlimmer
 * als keine.
 */
const OVERVIEW_INTERVAL = 4500;
let overviewTimer = null;
let overviewLaeuft = false;

function watchOverview() {
  stopOverview();
  if (document.visibilityState !== 'visible') return;
  // Am Rechner steht die Liste dauerhaft neben dem Chat.
  if (!(currentScreen() === 'start' || isDesktop())) return;
  void refreshOverview();
  overviewTimer = setInterval(() => void refreshOverview(), OVERVIEW_INTERVAL);
}

function stopOverview() {
  clearInterval(overviewTimer);
  overviewTimer = null;
}

async function refreshOverview() {
  if (overviewLaeuft) return;
  // Nach dem offenen Chat wird nicht gefragt: zu dem besteht eine Verbindung,
  // ueber die alles ohnehin sofort ankommt. Am Rechner steht die Liste neben
  // dem Chat, und ohne diese Ausnahme fragte die App dauernd nach etwas, das
  // sie schon weiss - beim Abholen per HTTP ist das eine Anfrage zu viel je
  // Runde, und davon lebt der Webspace nicht besser.
  const gefragt = listSessions()
    .filter((session) => session.token && session.roomId !== app.session?.roomId);
  if (gefragt.length === 0) return;
  overviewLaeuft = true;
  try {
    const antwort = await overview(gefragt.map((session) => ({
      roomId: session.roomId,
      token: session.token,
      seq: session.readSeq ?? 0,
    })));
    let geaendert = false;
    let verschwunden = 0;
    // Erst sammeln, dann einmal schreiben. Jeden Chat einzeln zu speichern
    // hiesse bei zehn Chats zehn volle Schreibvorgaenge - alle paar Sekunden.
    const patches = new Map();
    const bekanntNach = new Map(listSessions().map((session) => [session.roomId, session]));
    for (const eintrag of antwort?.rooms ?? []) {
      const bekannt = bekanntNach.get(eintrag.roomId);
      if (!bekannt) continue;
      if (eintrag.gone) {
        // Den Raum gibt es nicht mehr - vernichtet, waehrend wir woanders
        // waren, oder nach langer Stille verfallen. Ohne ihn ist die Sitzung
        // wertlos: der Verlauf liegt auf dem Server, nicht hier.
        //
        // Aber nicht wortlos: ein Chat, der beim Hinsehen verschwindet, sieht
        // aus wie ein Fehler der App.
        const warOffen = eintrag.roomId === app.session?.roomId;
        removeSession(eintrag.roomId);
        verschwunden += 1;
        geaendert = true;
        // Am Rechner steht die Liste neben dem offenen Chat. Verschwindet
        // ausgerechnet der, waere sonst die Sitzung weg und der Bildschirm
        // noch da - mit einem Raum, den es nicht mehr gibt.
        if (warOffen) {
          teardownChat();
          showStart();
        }
        continue;
      }
      // Der offene Chat zaehlt sich selbst - dort ist man ja dabei.
      const offen = eintrag.roomId === app.session?.roomId;
      const patch = {
        unread: offen ? 0 : eintrag.unread ?? 0,
        lastMessageAt: eintrag.lastMessageAt || bekannt.lastMessageAt || 0,
        typing: offen ? false : eintrag.typing === true,
      };
      if (patch.unread !== (bekannt.unread ?? 0)
        || patch.lastMessageAt !== (bekannt.lastMessageAt ?? 0)
        || patch.typing !== (bekannt.typing === true)) {
        patches.set(eintrag.roomId, patch);
      }
    }
    if (patchSessions(patches)) geaendert = true;
    if (geaendert) renderChatList();
    if (verschwunden > 0) toast(t('chatGone'), 3600);
  } catch {
    // Keine Verbindung, kein Drama - beim naechsten Mal wieder.
  } finally {
    overviewLaeuft = false;
  }
}

function openSessionMenu(session) {
  openSheet(chatTitle(session), [
    { icon: 'i-edit', label: t('renameChat'), hint: t('renameChatHint'), onClick: () => void renameChat(session.roomId) },
    { icon: 'i-copy', label: t('copyCode'), value: session.code, onClick: async () => {
      toast(await copyText(session.code) ? t('copied') : t('copyFailed'));
    } },
    { icon: 'i-close', label: t('leaveChat'), danger: true, onClick: () => void leaveSession(session.roomId) },
  ]);
}

/**
 * Gibt einem Chat einen eigenen Namen. Bleibt auf diesem Gerät: der Server
 * bekommt ihn nie zu sehen, und das Gegenüber auch nicht.
 */
async function renameChat(roomId) {
  const session = getSession(roomId) ?? (app.session?.roomId === roomId ? app.session : null);
  if (!session) return;
  const next = await promptSheet(t('renameChat'), {
    value: session.label ?? '',
    placeholder: session.peerNick || t('renameChatPlaceholder'),
    note: t('renameChatHint'),
    maxLength: 40,
  });
  if (next == null) return;
  const gespeichert = patchSession(roomId, { label: next.trim() });
  if (app.session?.roomId === roomId) app.session = gespeichert ?? { ...app.session, label: next.trim() };
  renderChatList();
  if (currentScreen() === 'chat') updatePeerStatus();
}

// ===========================================================================
// Fehleranzeige
// ===========================================================================

function showError(message, { retry = true } = {}) {
  busy(false);
  playSound('error');
  el('error-text').textContent = message;
  el('error-retry').hidden = !retry;
  showScreen('error');
}

function reportError(error) {
  if (error instanceof ApiError) {
    if (error.code === 'rate_limited') return showError(t('errorRateLimited'));
    if (error.status === 404) return showError(t('errorRoomUnknown'));
    if (error.code === 'network' || error.status === 0) return showError(t('errorNetwork'));
    if (error.code === 'room_exists') return showError(t('errorRoomExists'));
  }
  console.error(error);
  showError(t('errorNetwork'));
}

// ===========================================================================
// Eingabe-Kleinkram
// ===========================================================================

function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
}

function updateSendButton() {
  const hasText = el('message-input').value.trim().length > 0;
  const hasUpload = app.attachments.some((item) => item.blobId);
  const ready = hasText || hasUpload;
  el('btn-send').hidden = !ready;
  el('btn-record').hidden = ready || !canRecordAudio();
}

function formatCodeInput(input) {
  const clean = normalizeCode(input.value);
  input.value = formatCode(clean);
  const complete = isCompleteCode(clean);
  el('btn-do-join').disabled = !complete;
  el('join-error').hidden = true;
  return complete;
}

// ===========================================================================
// Ereignisse verdrahten
// ===========================================================================

function wireStaticHandlers() {
  el('btn-start').addEventListener('click', () => void startNewChat());
  el('btn-group').addEventListener('click', () => void startNewGroup());
  el('group-back').addEventListener('click', showStart);
  el('btn-group-to-chat').addEventListener('click', showChatScreen);
  el('btn-join').addEventListener('click', () => {
    el('code-input').value = '';
    el('btn-do-join').disabled = true;
    showScreen('join');
    setTimeout(() => el('code-input').focus(), 60);
  });
  el('update-now').addEventListener('click', () => void applyUpdate());
  el('btn-lang').addEventListener('click', cycleLanguage);
  el('btn-theme').addEventListener('click', cycleTheme);
  el('btn-about').addEventListener('click', showAbout);

  // --- Einladen ---
  el('invite-back').addEventListener('click', () => {
    if (app.inviteFromChat) showChatScreen();
    else showStart();
  });
  el('btn-copy-code').addEventListener('click', async () => {
    toast(await copyText(app.session.code) ? t('copied') : t('copyFailed'));
  });
  el('btn-copy-link').addEventListener('click', async () => {
    toast(await copyText(inviteLink(app.session.code)) ? t('copied') : t('copyFailed'));
  });
  el('btn-share').addEventListener('click', async () => {
    try {
      await navigator.share({
        title: t('appName'),
        text: t('codeHint'),
        url: inviteLink(app.session.code),
      });
    } catch { /* Abbruch ist kein Fehler */ }
  });
  el('btn-to-chat').addEventListener('click', showChatScreen);

  // --- Beitreten ---
  el('join-back').addEventListener('click', showStart);
  const codeInput = el('code-input');
  codeInput.addEventListener('input', () => formatCodeInput(codeInput));
  codeInput.addEventListener('paste', () => setTimeout(() => formatCodeInput(codeInput), 0));
  el('join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!formatCodeInput(codeInput)) {
      el('join-error').textContent = t('enterCodeHint');
      el('join-error').hidden = false;
      return;
    }
    void enterChat(codeInput.value);
  });
  el('btn-paste').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      const match = normalizeCode(text.split('#').pop() ?? text);
      codeInput.value = formatCode(match);
      formatCodeInput(codeInput);
    } catch {
      codeInput.focus();
    }
  });

  // --- Chat ---
  el('chat-back').addEventListener('click', showStart);
  el('chat-menu').addEventListener('click', openChatMenu);
  el('btn-call-audio').addEventListener('click', () => void startCall('audio'));
  el('btn-call-video').addEventListener('click', () => void startCall('video'));

  // --- Anruf ---
  el('call-accept').addEventListener('click', () => void app.call?.accept().catch(() => {}));
  el('call-decline').addEventListener('click', () => app.call?.hangUp('declined'));
  el('call-hangup').addEventListener('click', () => app.call?.hangUp('hangup'));
  el('call-mute').addEventListener('click', () => app.call?.toggleMute());
  el('call-camera').addEventListener('click', () => void switchCamera());
  el('call-flip').addEventListener('click', () => void app.call?.flipCamera());
  el('call-safety').addEventListener('click', showSafetySheet);
  el('jump-down').addEventListener('click', () => {
    scrollToBottom();
    markRead();
  });
  el('reply-cancel').addEventListener('click', () => {
    app.replyTo = null;
    renderReplyPreview();
  });

  const messageInput = el('message-input');
  messageInput.addEventListener('input', () => {
    autoGrow(messageInput);
    updateSendButton();
    noticeTyping();
  });
  messageInput.addEventListener('keydown', (event) => {
    // Auf dem Handy soll Enter eine neue Zeile machen; am Schreibtisch senden.
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (window.matchMedia('(pointer: coarse)').matches) return;
    event.preventDefault();
    void sendMessage();
  });
  el('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    void sendMessage();
  });

  el('btn-attach').addEventListener('click', openAttachSheet);
  el('btn-record').addEventListener('click', () => void beginRecording());
  el('rec-send').addEventListener('click', () => void finishRecording(true));
  el('rec-cancel').addEventListener('click', () => void finishRecording(false));

  for (const [id, kind] of [['file-gallery', 'image'], ['file-camera', 'image'], ['file-any', 'file']]) {
    el(id).addEventListener('change', (event) => {
      void addFiles(event.target.files ?? [], kind);
      event.target.value = '';
    });
  }

  const messages = el('messages');
  messages.addEventListener('scroll', () => {
    const distance = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
    const wasAtBottom = app.atBottom;
    app.atBottom = distance < 80;
    if (app.atBottom) {
      app.unread = 0;
      if (!wasAtBottom) markRead();
    }
    updateJumpButton();
    if (messages.scrollTop < 60 && app.hasMore) loadMore();
  }, { passive: true });

  // --- Overlays ---
  el('sheet-backdrop').addEventListener('click', closeSheet);
  el('sheet-grip').addEventListener('click', closeSheet);
  el('lightbox-close').addEventListener('click', closeLightbox);
  el('error-home').addEventListener('click', showStart);
  el('error-retry').addEventListener('click', () => {
    if (app.session) void enterChat(app.session.code);
    else showStart();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (lightboxOpen()) closeLightbox();
    else if (sheetOpen()) closeSheet();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (currentScreen() === 'chat' && app.atBottom) markRead();
  });

  window.matchMedia?.('(prefers-color-scheme: dark)')
    .addEventListener?.('change', () => applyTheme(app.prefs.theme));

  // Wenn die Bildschirmtastatur aufgeht, soll das Neueste sichtbar bleiben.
  window.visualViewport?.addEventListener('resize', () => {
    if (currentScreen() === 'chat' && app.atBottom) scrollToBottom(true);
  });

  window.addEventListener('beforeunload', () => {
    stopTyping();
  });

  if (!storageAvailable) {
    // Ohne lokalen Speicher gibt es keinen Weg zurueck in einen Chat.
    console.warn('localStorage ist nicht verfuegbar - Chats werden nicht gemerkt.');
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      // updateViaCache: 'none' - der Worker selbst darf nie aus dem
      // Zwischenspeicher kommen. Sonst prüft der Browser mit einer alten
      // Kopie, ob es eine neue gibt, und findet natürlich keine.
      .register(appUrl('sw.js'), { scope: basePath, updateViaCache: 'none' })
      .then((registration) => {
        app.swRegistration = registration;
        // Steht schon einer bereit, war die Seite beim letzten Mal offen.
        if (registration.waiting && navigator.serviceWorker.controller) showUpdateScreen();
        registration.addEventListener('updatefound', () => {
          const kommend = registration.installing;
          if (!kommend) return;
          kommend.addEventListener('statechange', () => {
            // "installed" bei vorhandenem Controller heisst: eine neue
            // Fassung liegt bereit, die alte läuft noch.
            if (kommend.state === 'installed' && navigator.serviceWorker.controller) showUpdateScreen();
          });
        });
        void registration.update().catch(() => {});
      })
      .catch(() => {});
  });
}

// ===========================================================================
// Aktualisieren
// ===========================================================================

/** So oft wird nachgesehen, ob es eine neue Fassung gibt. */
const UPDATE_CHECK_INTERVAL = 15 * 60 * 1000;

/**
 * Hält Ausschau nach einer neuen Fassung.
 *
 * Zwei Wege, weil keiner allein reicht: der Service Worker meldet sich, wenn
 * er eine neue Hülle geholt hat - das ist der Normalfall. Gibt es keinen
 * (kein HTTPS, abgeschaltet, alter Browser), bleibt der Vergleich mit dem
 * Server: der liefert dieselbe Fassung aus, die auch in der ausgelieferten
 * version.js steht. Weichen die ab, ist die Kopie im Browser alt.
 */
function watchForUpdates() {
  const nachsehen = () => {
    void app.swRegistration?.update().catch(() => {});
    void serverConfig().then((remote) => compareVersion(remote?.version)).catch(() => {});
  };
  setInterval(nachsehen, UPDATE_CHECK_INTERVAL);
  // Wer die App nach Stunden wieder hervorholt, soll nicht erst warten.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') nachsehen();
  });
}

/**
 * Vergleicht die Fassung des Servers mit der eigenen.
 *
 * Bewusst nur bei einem eindeutigen Unterschied. Kommt keine Auskunft -
 * Netz weg, alte Auslieferung ohne Angabe -, passiert nichts: niemand soll
 * wegen eines Netzfehlers aus seinem Chat ausgesperrt werden.
 */
function compareVersion(serverVersion) {
  const dort = String(serverVersion ?? '').trim();
  if (!dort || !APP_VERSION || dort === APP_VERSION) return;
  showUpdateScreen();
}

/** Zeigt die Aufforderung. Sie lässt sich nicht wegklicken - mit Absicht. */
function showUpdateScreen() {
  const screen = el('update');
  if (!screen || !screen.hidden) return;
  screen.hidden = false;
  // Das Fenster nimmt den ganzen Bildschirm ein - wer gerade woanders
  // hinsieht, soll wenigstens hören, dass etwas passiert ist.
  playSound('notify');
  // Was gerade läuft, wird beendet: mit einer veralteten Kopie
  // weiterzutelefonieren hilft niemandem.
  app.call?.dispose();
  app.call = null;
  closeCallScreen();
  closeSheet();
  el('update-now')?.focus({ preventScroll: true });
}

/**
 * Holt alles neu - so gründlich, wie es Strg+Umschalt+R täte, und das auch
 * auf dem Handy, wo es diese Tastenkombination gar nicht gibt.
 *
 * Der Reihe nach: den wartenden Worker übernehmen lassen, jeden
 * Zwischenspeicher leeren, die Worker abmelden. Danach holt der Browser
 * alles wieder vom Server. Die Chats liegen im localStorage und bleiben
 * davon unberührt.
 */
async function applyUpdate() {
  const knopf = el('update-now');
  if (knopf) {
    knopf.disabled = true;
    const beschriftung = knopf.querySelector('span');
    if (beschriftung) beschriftung.textContent = t('updateWorking');
  }
  try {
    const registrations = await navigator.serviceWorker?.getRegistrations?.() ?? [];
    for (const registration of registrations) {
      registration.waiting?.postMessage({ type: 'skipWaiting' });
    }
    if (typeof caches !== 'undefined') {
      const namen = await caches.keys();
      await Promise.all(namen.map((name) => caches.delete(name)));
    }
    // Erst abmelden, wenn die Speicher leer sind - sonst legt ein noch
    // laufender Worker sie beim Abmelden gleich wieder an.
    await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
  } catch {
    // Auch wenn das Aufräumen scheitert: neu laden ist besser als bleiben.
  }
  reloadFromServer();
}

/**
 * Neu laden, ohne dass der Browser aus seinem eigenen Zwischenspeicher
 * bedient. `location.reload(true)` gibt es nicht mehr; verlässlich ist ein
 * Aufruf derselben Adresse mit einem einmaligen Anhängsel - danach wird der
 * Anhang gleich wieder entfernt, damit keine Spur in der Adresszeile bleibt.
 */
function reloadFromServer() {
  const ziel = new URL(location.href);
  ziel.searchParams.set('frisch', Date.now().toString(36));
  location.replace(ziel.toString());
}

/**
 * Beim Start: das Anhängsel von oben wieder loswerden. Es hat seinen Zweck
 * erfüllt, sobald die Seite geladen ist, und hätte in einem geteilten Link
 * nichts verloren.
 */
function dropCacheBuster() {
  if (!location.search.includes('frisch=')) return;
  const ziel = new URL(location.href);
  ziel.searchParams.delete('frisch');
  history.replaceState(null, '', ziel.pathname + ziel.search + ziel.hash);
}

boot();
