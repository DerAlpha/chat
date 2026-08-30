/**
 * Flüsterchat – Ablaufsteuerung.
 *
 * Grundregel: Alles, was Inhalt ist, wird hier im Browser verschlüsselt.
 * Der Server bekommt nur die Raum-ID (ein Hash des Codes), ein Zugangstoken
 * und unlesbare Bytes zu sehen.
 */

import {
  cryptoAvailable, generateCode, formatCode, normalizeCode, isCompleteCode,
  deriveSecrets, deriveSlot, generateGroupKey, randomRoomId, wrapGroupKey, unwrapGroupKey,
  importKey, encryptJson, decryptJson, encryptBytes, decryptBytes,
  toBase64, fromBase64, randomId, deriveHideKey, randomSalt,
} from './crypto.js';
import { qrSvg } from './qr.js';
import { CallSession, mediaCryptoAvailable } from './call.js';
import { emojiGroups, searchEmoji, looksLikeEmoji } from './emoji.js';
import { appUrl, baseUrl, basePath } from './base.js';
import { APP_VERSION } from './version.js';
import { CHANGELOG, NEUESTE_AENDERUNG } from './changelog.js';
import { t, applyTranslations, setLanguage, getLanguage, detectLanguage, availableLanguages, onLanguageChange } from './i18n.js';
import { listSessions, getSession, saveSession, patchSession, patchSessions, removeSession, wipeStorage, getPrefs, setPrefs, etwasGespeichert, storageAvailable, listHidden, addHidden, removeHidden, replaceHidden } from './session.js';
import { createRoom, claimSlot, roomStatus, overview, uploadBlob, downloadBlob, burnRoom, leaveRoom, addSlots, putAvatar, fetchAvatar, deleteAvatar, createConnection, serverConfig, searchGifs, gifMediaUrl, fetchGif, iceConfig, ApiError } from './net.js';
import { prepareImage, readFileBytes, extensionFor, formatBytes, formatDuration, canRecordAudio, startRecording, openForCrop, finishAvatar, closeSource } from './media.js';
import { configureSound, playSound, primeSound } from './sound.js';
import {
  el, make, icon, showScreen, currentScreen, isDesktop, onLayoutChange, toast, busy,
  openSheet, closeSheet, sheetOpen, fangeFokus, gibFokusZurueck,
  confirmSheet, promptSheet, openLightbox, closeLightbox, lightboxOpen,
  formatClock, formatDay, sameDay, relativeTime, linkify, initial, onLongPress, copyText,
  alsAppInstalliert, aufApfelGeraet,
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
  /** Was gerade in der Suchleiste steht. */
  suche: '',
  /**
   * Versteckte Chats, die die eingetippte Zeichenfolge gerade aufgeschlossen
   * hat. Nur im Arbeitsspeicher: wird die Leiste geleert oder die Seite neu
   * geladen, sind sie wieder weg.
   */
  entdeckt: [],
  me: null,
  /**
   * Alle anderen im Raum. In einem Zweiergespräch genau einer, in einer
   * Gruppe entsprechend mehr - deshalb eine Zuordnung und kein einzelnes
   * Gegenüber. Wer selbst dran ist, steht in `me` und nicht hier.
   */
  members: new Map(),
  /** Das eigene Recht in diesem Raum: 'admin' oder 'member'. */
  myRole: 'member',
  /** Fassung des Gruppenbildes - aendert sie sich, wird es neu geholt. */
  groupAvatarVer: null,
  /**
   * Profilbilder dieses Raums, entschluesselt: Besitzer -> {ver, url}.
   * Die Bilder gehoeren zum Raum, nicht zum Geraet - beim Verlassen des
   * Chats werden die Adressen wieder freigegeben.
   */
  avatars: new Map(),
  messages: new Map(),
  order: [],
  pending: new Map(),
  attachments: [],
  replyTo: null,
  /**
   * Geht die naechste Nachricht verdeckt hinaus?
   *
   * Gilt fuer genau eine und faellt danach zurueck. Andersherum waere es die
   * gefaehrlichere Voreinstellung - wer es vergisst, schickt tagelang
   * Flaechen statt Saetzen.
   */
  sendHidden: false,
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
    // Aus den Augen heisst zu: was aufgeschlossen war, wird wieder
    // weggeschlossen - siehe versteckeSchliessen().
    if (document.visibilityState === 'hidden') versteckeSchliessen();
    // Im Hintergrund fragt niemand nach der Liste - das kostet nur Akku.
    watchOverview();
  });
  setLanguage(detectLanguage(app.prefs.lang));
  applyTheme(app.prefs.theme);
  applyTranslations();
  wireStaticHandlers();
  // Was beim letzten Mal als "tippt" gespeichert wurde, stimmt jetzt sicher
  // nicht mehr.
  tippenLoeschen();
  // Die Erlaubnis kann laengst widerrufen sein, ohne dass es jemand sagt.
  meldungenAbgleichen();
  // Nach einer Aktualisierung zeigt sich von selbst, was neu ist.
  changelogNachUpdate();
  watchStatusWidth();
  watchViewportHeight();
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
    name.maxLength = 40;
    name.autocomplete = 'off';
    name.id = 'group-name';
    // Eine richtige Beschriftung, wie sie das Feld darunter schon hat. Ein
    // Platzhalter ist keine: er verschwindet beim ersten Zeichen, und im
    // Barrierefreiheitsbaum hiess das Feld gar nichts.
    const nameLabel = make('label', 'sheet-field__label', t('groupNamePlaceholder'));
    nameLabel.htmlFor = name.id;
    const nameZeile = make('div', 'sheet-field');
    nameZeile.append(nameLabel, name);

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

    // Wie beim Zweiergespraech: den gespeicherten Eintrag als Grundlage
    // nehmen, damit nichts still verlorengeht, was dort schon steht.
    const bekannt = getSession(platz.roomId);
    const session = saveSession({
      ...(bekannt ?? {}),
      roomId: platz.roomId,
      code: '',
      kind: 'group',
      key: toBase64(inhalt.key),
      token: platz.you?.token ?? bekannt?.token ?? null,
      memberId: platz.you?.id ?? bekannt?.memberId ?? null,
      // Wer ueber einen neuen Code hereinkommt, ist ein neues Mitglied - unter
      // der neuen Kennung liegt kein Bild. Die alte Marke wuerde das Hochladen
      // kurzschliessen, und das Bild kaeme nie wieder in den Raum.
      avatarSig: (platz.you?.id && platz.you.id !== bekannt?.memberId) ? null : (bekannt?.avatarSig ?? null),
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
    // Wer den Code eines gerade aufgeschlossenen Verstecks eintippt, soll
    // dorthin - und nicht einen zweiten Eintrag im Klartext danebenlegen.
    const versteckt = app.entdeckt.find((eintrag) => eintrag.roomId === roomId);
    if (versteckt) {
      await openSession({ ...versteckt, unread: 0 }, { screen: 'chat' });
      return;
    }
    const known = knownSession ?? getSession(roomId);
    // Der Schnappschuss aus der Liste kann aelter sein als der Speicher: das
    // Token, das seither dazukam, faellt sonst weg und der Raum gilt als voll.
    const token = deviceToken ?? known?.token ?? getSession(roomId)?.token ?? null;

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

    // Auf dem Gespeicherten aufbauen, nicht neu aufzaehlen. Eine feste Liste
    // vergisst still jedes Feld, das spaeter dazukommt - und saveSession
    // ersetzt den Eintrag ganz, es gibt kein Zusammenfuehren. So gingen beim
    // blossen Oeffnen aus der Liste die Sperren fuer Profilbilder verloren,
    // und das Bild lag beim naechsten Betreten wieder im Raum.
    //
    // `known` ist der Schnappschuss, den die Chatliste in ihren Klick
    // eingeschlossen hat - er kann alt sein. Fuer alles, was wirklich
    // aufbewahrt wird, gilt der frische Stand.
    const stand = getSession(roomId) ?? {};
    const session = saveSession({
      ...stand,
      roomId,
      code: formatCode(code),
      key: toBase64(keyRaw),
      token,
      memberId: known?.memberId ?? stand.memberId ?? null,
      nick: known?.nick ?? stand.nick ?? app.prefs.nick ?? '',
      peerNick: known?.peerNick ?? stand.peerNick ?? '',
      // Muss mitgenommen werden: sonst wäre die eigene Bezeichnung jedes Mal
      // weg, wenn man den Chat wieder betritt.
      label: known?.label ?? stand.label ?? '',
      createdAt: known?.createdAt ?? stand.createdAt ?? Date.now(),
      lastActivity: Date.now(),
      // Muss mit: sonst gaelte nach jedem Betreten wieder alles als ungelesen.
      readSeq: known?.readSeq ?? stand.readSeq ?? 0,
      lastMessageAt: known?.lastMessageAt ?? stand.lastMessageAt ?? 0,
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
  app.session = merkeSession(app.session.roomId, { nick: next }) ?? app.session;
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
  for (const bild of app.avatars.values()) URL.revokeObjectURL(bild.url);
  app.avatars.clear();
  app.groupAvatarVer = null;
  app.myRole = 'member';
  typingNode = null;
  schonGezeigt.clear();
  aufgedeckt.clear();
  gemeldet.clear();
  versteckeSeenBlase();
  app.sendHidden = false;
  renderSpoilerBar();
  stopKeepAtBottom();
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
    case 'role': return onRole(frame);
    case 'avatar': return onAvatarChanged(frame);
    case 'reveal': return onRevealed(frame);
    case 'left': return onMemberLeft(frame);
    case 'capacity': return onCapacity(frame);
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
  // merkeSession() null zurueck, und das Token ginge sonst verloren.
  const patch = { token: frame.you.token, memberId: frame.you.id, lastActivity: Date.now() };
  app.session = { ...app.session, ...patch };
  merkeSession(app.session.roomId, patch);
  if (app.conn) app.conn.token = frame.you.token;

  app.members.clear();
  app.groupAvatarVer = frame.room?.avatarVer ?? null;
  for (const raw of frame.members ?? []) {
    if (raw.id === frame.you.id) continue;
    const member = memberOf(raw.id);
    member.online = raw.online === true;
    member.lastSeen = raw.lastSeen ?? 0;
    member.readSeq = raw.readSeq ?? 0;
    member.role = raw.role === 'admin' ? 'admin' : 'member';
    member.left = raw.left === true;
    member.avatarVer = raw.avatarVer ?? null;
    if (raw.nickCt) {
      const angaben = await safeDecrypt(raw.nickCt);
      member.nick = angaben?.n ?? '';
      member.bio = angaben?.b ?? '';
    }
  }
  app.myRole = findMember(frame.members, frame.you.id).role === 'admin' ? 'admin' : 'member';
  entrumpleAusgeblendete();
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
  // Bilder kommen nach: sie sind Beiwerk und sollen den Chat nicht aufhalten.
  void loadAvatars();
  void publishMyAvatar();

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
    // Der Absender hat die Gruppe verlassen - hier stand einmal etwas von ihm.
    gone: message.gone === true,
    editedAt: message.editedAt ?? null,
    att: message.att ?? [],
    payload,
    reactions,
    /** Wer diese verdeckte Nachricht schon aufgedeckt hat. */
    revealedBy: Array.isArray(message.revealedBy) ? message.revealedBy : [],
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
/**
 * Alle anderen, in der Reihenfolge, in der sie bekannt wurden.
 *
 * Wer die Gruppe verlassen hat, zaehlt nicht mehr mit: nicht bei "3 von 5
 * da", nicht beim Tippen und nicht bei der Nummerierung der Namenlosen.
 * Sein Platz bleibt trotzdem belegt - sein Code ist verbraucht.
 */
const others = () => [...app.members.values()].filter((member) => member.left !== true);
/** Im Zweiergespräch das Gegenüber; in einer Gruppe niemand Bestimmtes. */
const peerOf = () => (isGroup() ? null : others()[0] ?? null);
/** Ist gerade überhaupt jemand da? */
const anyOnline = () => others().some((member) => member.online);
const onlineCount = () => others().filter((member) => member.online).length;
const typingNow = () => others().filter((member) => member.typing);

/** Holt ein Mitglied - und legt es an, wenn es noch keines gab. */
function memberOf(id) {
  const leer = () => ({
    id, nick: '', bio: '', online: false, lastSeen: 0, typing: false, readSeq: 0, typingTimer: null,
    role: 'member', left: false, avatarVer: null,
  });
  // Ein Frame ohne Absender darf kein Mitglied erfinden. Sonst steht in der
  // Gruppe jemand in der Liste, den es nicht gibt - und weil Namenlose
  // durchnummeriert werden, verschieben sich damit auch die Namen aller
  // anderen.
  if (typeof id !== 'string' || id === '') return leer();
  let member = app.members.get(id);
  if (!member) {
    member = leer();
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
  // Bewusst ueber ALLE bekannten Mitglieder, auch ueber die gegangenen:
  // sonst ruecken beim Austritt eines Namenlosen alle dahinter eine Nummer
  // vor, und der ganze schon gelesene Verlauf traegt ploetzlich andere
  // Namen.
  const namenlos = [...app.members.values()]
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

/**
 * Wer hat eine Nachricht schon gelesen - und wer noch nicht?
 *
 * Gelesen heisst: das Geraet hat gemeldet, bis hierher gelesen zu haben.
 * Alles andere liegt bereit; ob es dort schon angekommen ist, weiss nur das
 * andere Geraet. Genau so steht es auch in der Anzeige - eine Behauptung,
 * die man nicht belegen kann, gehoert nicht in eine Lesebestaetigung.
 */
function seenSplit(seq) {
  const gelesen = [];
  const offen = [];
  for (const member of others()) {
    ((member.readSeq ?? 0) >= seq ? gelesen : offen).push(member);
  }
  return { gelesen, offen };
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
  // Ein frisch geoeffneter Chat faehrt nicht dreihundert Blasen ein: was
  // beim Betreten schon da ist, steht einfach da.
  markiereAlsGezeigt();
  redrawAll();
  scrollToBottom(true);
  keepAtBottom();
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
  // Nachgeladene alte Nachrichten sind alt - sie fahren nicht ein.
  markiereAlsGezeigt();
  redrawAll();
  if (app.atBottom) {
    // Wer unten stand, will unten bleiben - auch wenn oben etwas dazukam.
    scrollToBottom(true);
    return;
  }
  // Sonst die Ansicht halten, damit einem der Inhalt nicht wegrutscht.
  // Ohne behavior 'instant' wuerde die CSS-Regel scroll-behavior daraus
  // eine Animation machen, und man saehe den Verlauf davonrutschen.
  list.scrollTo({ top: previousTop + (list.scrollHeight - previousHeight), behavior: 'instant' });
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
  merkeSession(app.session.roomId, { lastActivity: Date.now() });
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

/** Jemand hat eine verdeckt geschickte Nachricht aufgedeckt. */
function onRevealed(frame) {
  const entry = app.messages.get(frame.id);
  const wer = String(frame.from ?? '');
  if (!entry || !wer) return;
  if (!Array.isArray(entry.revealedBy)) entry.revealedBy = [];
  if (entry.revealedBy.includes(wer)) return;
  entry.revealedBy.push(wer);
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
  member.bio = value?.b ?? '';
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
  app.session = merkeSession(app.session.roomId, { peerNick: sauber }) ?? { ...app.session, peerNick: sauber };
  renderChatList();
}

// ===========================================================================
// Profilbilder
// ===========================================================================

/**
 * Kantenlaenge des Bildchens, das fuer die Chatliste im Geraet bleibt.
 *
 * Das grosse Bild gehoert zum Raum und wird dort geholt. Fuer die Liste auf
 * der Startseite gibt es aber keine Verbindung zu zwanzig Raeumen - also
 * bleibt von jedem Chat eine winzige Fassung hier liegen. Bei 64 Punkten
 * sind das ein paar Kilobyte je Chat.
 */
const LIST_AVATAR_EDGE = 64;

/**
 * Holt ein Profilbild, entschluesselt es und merkt es sich.
 *
 * Verglichen wird ueber die Fassung: aendert jemand sein Bild, bekommt es
 * eine neue Kennung, und erst dann wird neu geladen. Sonst liegt es hier.
 */
async function ensureAvatar(owner, ver) {
  if (!app.session?.token || !app.key) return null;
  // Ausgeblendet oder gar nicht da: nicht holen und nichts behalten. Diese
  // eine Stelle deckt alle Wege ab, auf denen ein Bild hereinkommt - das
  // Betreten des Raums genauso wie die Meldung "hat sein Bild geaendert".
  // Sonst holte ein ausgeblendetes Bild sich beim naechsten Wechsel selbst
  // zurueck.
  if (!ver || bildVersteckt(owner)) {
    vergissBild(owner);
    return null;
  }
  const bekannt = app.avatars.get(owner);
  if (bekannt?.ver === ver) return bekannt.url;
  try {
    const sealed = await fetchAvatar(app.session.roomId, app.session.token, owner, ver);
    if (!sealed) return null;
    const bytes = await decryptBytes(app.key, sealed);
    // Noch einmal fragen: zwischen Anfrage und Antwort liegen Sekunden, und
    // in denen kann der Knopf gedrueckt worden sein. Sonst legt der laufende
    // Abruf die entschluesselte Kopie danach doch wieder ab.
    if (bildVersteckt(owner)) return null;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/*' }));
    if (bekannt) URL.revokeObjectURL(bekannt.url);
    app.avatars.set(owner, { ver, url, bytes });
    return url;
  } catch {
    // Kein Bild ist kein Fehler - dann bleibt der Anfangsbuchstabe stehen.
    return null;
  }
}

/**
 * Wirft aus der Ausblendliste, was es hier nicht mehr gibt.
 *
 * Mitglieds-Kennungen gelten je Raum und werden bei jedem Beitritt neu
 * vergeben. Wer eine Gruppe verlaesst und spaeter ueber einen neuen Code
 * zurueckkommt, ist eine andere Kennung - die alte bliebe sonst fuer immer
 * in der Liste stehen.
 */
function entrumpleAusgeblendete() {
  const liste = app.session?.hiddenAvatars ?? [];
  if (liste.length === 0 || app.members.size === 0) return;
  const bleibt = liste.filter((owner) => owner === 'group' || app.members.has(owner));
  if (bleibt.length === liste.length) return;
  const patch = { hiddenAvatars: bleibt };
  app.session = merkeSession(app.session.roomId, patch) ?? { ...app.session, ...patch };
}

/**
 * Alle Bilder dieses Raums holen und danach einmal neu zeichnen.
 *
 * Wichtig ist der Fall, in dem es NICHTS zu holen gibt: genau dann hat jemand
 * sein Bild weggenommen, waehrend man nicht verbunden war. Die Live-Meldung
 * dazu hat man verpasst, und niemand spielt sie nach. Wer hier vorzeitig
 * aussteigt, laesst das Bildchen auf der Startseite tagelang stehen.
 */
async function loadAvatars() {
  const raum = app.session?.roomId;
  const wer = [...app.members.values()]
    .filter((member) => member.avatarVer)
    .map((member) => [member.id, member.avatarVer]);
  if (app.groupAvatarVer) wer.push(['group', app.groupAvatarVer]);
  if (wer.length > 0) await Promise.all(wer.map(([owner, ver]) => ensureAvatar(owner, ver)));
  if (app.session?.roomId !== raum) return;
  rememberChatAvatar(raum);
  updatePeerStatus();
  redrawAll();
}

/**
 * Wessen Bild man in diesem Chat nicht sehen will.
 *
 * Eine Entscheidung ueber die eigene Anzeige, kein Schutz vor dem Server: das
 * Bild liegt weiter in diesem Raum, und die Person merkt nichts davon. Auf
 * diesem Geraet ist es dagegen wirklich weg - es wird nicht mehr geholt, die
 * entschluesselte Kopie kommt weg, und das Bildchen der Uebersicht auch. Wer
 * sein EIGENES Bild vor jemandem verbergen will, braucht den anderen Weg:
 * dann liegt es dort gar nicht erst.
 */
const bildVersteckt = (owner) => Boolean(owner) && (app.session?.hiddenAvatars ?? []).includes(owner);

/**
 * Die Adresse des Bildes von jemandem - oder null.
 *
 * Die Pruefung hier ist die zweite Sperre, nicht die erste: geholt wird ein
 * ausgeblendetes Bild schon in ensureAvatar() nicht. Sie steht trotzdem da,
 * weil sie den Satz "ausgeblendet heisst nicht zu sehen" wahr macht,
 * unabhaengig davon, was gerade im Zwischenspeicher liegt - und das ist
 * billiger als die Zusicherung an jeder Anzeigestelle einzeln zu pruefen.
 */
const avatarUrl = (owner) => (bildVersteckt(owner) ? null : app.avatars.get(owner)?.url ?? null);

/** Welches Bild steht fuer diesen Chat? In einer Gruppe ihres, sonst das des Gegenuebers. */
function chatAvatarOwner() {
  if (isGroup()) return 'group';
  return peerOf()?.id ?? null;
}

/**
 * Ein rundes Bildfeld: das Bild, wenn es eines gibt, sonst der Anfangsbuchstabe.
 */
function avatarNode(owner, name, extra = '') {
  const knoten = make('div', `avatar${extra ? ` ${extra}` : ''}`);
  const url = owner ? avatarUrl(owner) : null;
  if (url) {
    const bild = make('img', 'avatar__img');
    bild.src = url;
    bild.alt = '';
    knoten.appendChild(bild);
    knoten.classList.add('has-image');
  } else {
    knoten.textContent = initial(name);
  }
  return knoten;
}

/** Setzt ein vorhandenes Bildfeld neu - Bild oder Buchstabe. */
function fillAvatar(knoten, owner, name) {
  if (!knoten) return;
  const url = owner ? avatarUrl(owner) : null;
  if (!url) {
    knoten.classList.remove('has-image');
    knoten.textContent = initial(name);
    return;
  }
  const vorhanden = knoten.querySelector('img');
  if (vorhanden?.src === url) return;
  knoten.classList.add('has-image');
  const bild = make('img', 'avatar__img');
  bild.src = url;
  bild.alt = '';
  knoten.replaceChildren(bild);
}

/**
 * Legt eine winzige Fassung des Chatbildes ins Geraet - fuer die Liste auf
 * der Startseite, die keine Verbindung zu diesem Raum hat.
 */
function rememberChatAvatar(erwartet = app.session?.roomId) {
  // Wer inzwischen in einem anderen Chat steht, hat hier nichts mehr
  // aufzuraeumen: das Bildchen dieses anderen Chats gehoert ihm nicht.
  // Die Aufrufer starten teils vor einem Abruf, der Sekunden dauern kann.
  if (!app.session || app.session.roomId !== erwartet) return;
  const owner = chatAvatarOwner();
  const eintrag = owner ? app.avatars.get(owner) : null;
  // Ausgeblendet, oder es gibt dort gar kein Bild: dann muss auch das
  // Bildchen der Uebersicht weg - sonst zeigt ausgerechnet die Startseite
  // weiter, was es im Chat nicht mehr gibt.
  //
  // "Gibt es dort kein Bild" entscheidet die Fassung, nicht der
  // Zwischenspeicher. Ein Abruf kann fehlschlagen - ein Serverfehler, ein
  // abgebrochenes Netz -, und daraus zu schliessen, das Bild sei weg, hiesse
  // die Uebersicht wegen einer Stoerung leerzuraeumen.
  if (bildVersteckt(owner) || !hatBildFassung(owner)) {
    vergissListenbild();
    return;
  }
  if (!eintrag?.bytes) return;
  // Den Raum und den Besitzer jetzt festhalten: das Verkleinern dauert
  // mehrere Bildaufbauten, und wer inzwischen in einen anderen Chat
  // gewechselt ist, bekaeme dort sonst dieses Bild in die Liste geschrieben.
  const roomId = app.session.roomId;
  shrinkToDataUrl(eintrag.bytes).then((klein) => {
    if (!klein) return;
    const stand = getSession(roomId);
    if (!stand) return;
    // In der Zwischenzeit ausgeblendet? Dann nicht doch noch hinschreiben.
    // Sonst gewinnt das haengende Verkleinern gegen den Knopf, und das
    // ausgeblendete Gesicht stuende dauerhaft auf der Startseite.
    if ((stand.hiddenAvatars ?? []).includes(owner)) return;
    // Nichts schreiben, wenn sich nichts geaendert hat: jeder Schreibvorgang
    // legt die ganze Chatliste neu ab.
    if (stand.listAvatar === klein) return;
    const gemerkt = merkeSession(roomId, { listAvatar: klein });
    if (!gemerkt) return;
    if (app.session?.roomId === roomId) app.session = gemerkt;
    renderChatList();
  }).catch(() => { /* ohne Bildchen eben mit Buchstabe */ });
}

/** Sagt der Server, dass es fuer diesen Besitzer ueberhaupt ein Bild gibt? */
function hatBildFassung(owner) {
  if (!owner) return false;
  if (owner === 'group') return Boolean(app.groupAvatarVer);
  return Boolean(app.members.get(owner)?.avatarVer);
}

/**
 * Nimmt das Bildchen dieses Chats aus der Uebersicht.
 *
 * Gebraucht an zwei Stellen: wenn das Gegenueber sein Bild wegnimmt, und
 * wenn man es selbst ausblendet. Ohne das zeigte die Startseite noch
 * tagelang, was es im Chat nicht mehr zu sehen gibt.
 */
function vergissListenbild() {
  if (!app.session?.listAvatar) return;
  const gemerkt = merkeSession(app.session.roomId, { listAvatar: null });
  if (gemerkt) app.session = gemerkt;
  renderChatList();
}

/** Die entschluesselte Kopie eines Bildes wegwerfen. */
function vergissBild(owner) {
  const alt = app.avatars.get(owner);
  if (!alt) return;
  URL.revokeObjectURL(alt.url);
  app.avatars.delete(owner);
}

/** Verkleinert Bildbytes zu einer kleinen Data-URL. */
async function shrinkToDataUrl(bytes) {
  const blob = new Blob([bytes]);
  const bild = await createImageBitmap(blob).catch(() => null);
  if (!bild) return null;
  const canvas = document.createElement('canvas');
  canvas.width = LIST_AVATAR_EDGE;
  canvas.height = LIST_AVATAR_EDGE;
  const stift = canvas.getContext('2d');
  stift.imageSmoothingQuality = 'high';
  stift.drawImage(bild, 0, 0, LIST_AVATAR_EDGE, LIST_AVATAR_EDGE);
  if (typeof bild.close === 'function') bild.close();
  const url = canvas.toDataURL('image/jpeg', 0.7);
  return url.length < 24_000 ? url : null;
}

/**
 * Ist das eigene Bild in diesem Chat verborgen?
 *
 * Das ist die ernstgemeinte Haelfte des Verbergens: verborgen heisst, dass
 * das Bild in diesem Raum gar nicht erst liegt. Das Gegenueber sieht den
 * Anfangsbuchstaben, weil es nichts anderes gibt - nicht, weil es gebeten
 * wurde, wegzusehen.
 */
const meinBildVerborgen = (session = app.session) => session?.hideMyAvatar === true;

/**
 * Bilder gehen der Reihe nach hoch und wieder weg.
 *
 * Hinlegen und Wegnehmen sind zwei Anfragen an denselben Ort. Laufen sie
 * gleichzeitig - weil jemand den Schalter umlegt, waehrend das Betreten des
 * Raums noch hochlaedt -, entscheidet der Zufall, was am Ende dort liegt.
 * Und der Zufall darf hier nicht entscheiden.
 */
let bildWarteschlange = Promise.resolve();
const nacheinander = (aufgabe) => {
  bildWarteschlange = bildWarteschlange.then(aufgabe, aufgabe);
  return bildWarteschlange;
};

/**
 * Schickt das eigene Bild in diesen Raum - aber nur, wenn es dort noch nicht
 * (oder in einer aelteren Fassung) liegt.
 *
 * Das Bild selbst wohnt in den Einstellungen und gilt fuer alle Chats. In
 * jeden Raum muss es trotzdem einzeln: es wird mit dem Schluessel DIESES
 * Raums verschluesselt, und niemand sonst soll es aufmachen koennen.
 */
/**
 * Welcher Raum jetzt gemeint ist.
 *
 * Alles, was in die Warteschlange geht, bekommt das mit. Zwischen Einreihen
 * und Ausfuehren kann jemand den Chat gewechselt haben, und eine Aufgabe,
 * die erst beim Ausfuehren nachsieht, wo sie steht, raeumt dann im falschen
 * Raum auf. Genau so verschwand ein Bild aus einem Chat, in dem niemand
 * etwas verborgen hatte.
 */
const jetzigerRaum = () => ({
  roomId: app.session?.roomId ?? null,
  token: app.session?.token ?? null,
  wer: app.me?.id ?? null,
});

function publishMyAvatar({ force = false } = {}) {
  const ziel = jetzigerRaum();
  const verborgen = meinBildVerborgen();
  const liegtDort = Boolean(app.me?.avatarVer || app.session?.avatarSig);
  return nacheinander(() => bildHochladen(ziel, { force, verborgen, liegtDort }));
}

/** @returns {Promise<boolean>} ob danach wirklich ein Bild im Raum liegt */
async function bildHochladen(ziel, { force, verborgen, liegtDort }) {
  if (!ziel.roomId || !ziel.token || !ziel.wer) return false;
  // Dort verborgen: nicht hochladen - und wegnehmen, falls doch etwas
  // daliegt. Das kann sein, weil die Sperre ohne Verbindung gesetzt wurde
  // oder weil ein zweites eigenes Geraet das Bild hingelegt hat.
  if (verborgen) {
    if (liegtDort) await bildWegnehmen(ziel);
    return false;
  }
  const roh = app.prefs?.avatar;
  if (!roh) return false;
  const marke = app.prefs.avatarSig ?? '';
  if (!force && getSession(ziel.roomId)?.avatarSig === marke) return true;
  // Verschluesselt wird mit dem Schluessel DIESES Raums, und den gibt es nur,
  // solange man darin steht. Wer inzwischen woanders ist, laesst es: beim
  // Betreten wird ohnehin wieder hochgeladen.
  if (app.session?.roomId !== ziel.roomId || !app.key) return false;
  const { roomId, token, wer } = ziel;
  try {
    const bytes = fromBase64(roh.slice(roh.indexOf(',') + 1));
    const sealed = await encryptBytes(app.key, bytes);
    await putAvatar(roomId, token, wer, sealed);
    const patch = { avatarSig: marke };
    const gemerkt = merkeSession(roomId, patch);
    if (app.session?.roomId === roomId) app.session = gemerkt ?? { ...app.session, ...patch };
    return true;
  } catch {
    // Beim naechsten Betreten wieder - ein Bild ist kein Grund fuer eine Fehlermeldung.
    return false;
  }
}

/**
 * Das eigene Bild aus diesem einen Raum wegnehmen.
 *
 * Nicht zu verwechseln mit removeMyAvatar(): dort wird das Bild ueberall
 * weggenommen und auch aus den Einstellungen. Hier bleibt es bestehen und
 * gilt in allen anderen Chats weiter - nur in diesem einen liegt es nicht.
 */
async function bildWegnehmen(ziel = jetzigerRaum()) {
  const { roomId, token, wer } = ziel;
  if (!roomId || !token || !wer) return false;
  try {
    await deleteAvatar(roomId, token, wer);
    if (app.me?.id === wer) app.me.avatarVer = null;
    const patch = { avatarSig: null };
    const gemerkt = merkeSession(roomId, patch);
    if (app.session?.roomId === roomId) app.session = gemerkt ?? { ...app.session, ...patch };
    return true;
  } catch {
    // Ein Raum, der gerade nicht erreichbar ist, bekommt es beim naechsten
    // Betreten mit: publishMyAvatar() raeumt dort dann auf.
    return false;
  }
}

function onAvatarChanged(frame) {
  const owner = String(frame.from ?? '');
  const ver = frame.ver ?? null;
  // Das eigene Bild kommt als Meldung zurueck - der Server schickt sie an
  // alle im Raum, und das sind wir selbst auch. Wuerde memberOf() darauf
  // anspringen, staende man als eigenes Gegenueber in der eigenen
  // Mitgliederliste: "2 von 3 da", obwohl nur einer da ist.
  if (owner === app.me?.id) return;
  if (owner === 'group') app.groupAvatarVer = ver;
  else memberOf(owner).avatarVer = ver;
  // Verschwindet das Bild dieses Chats, muss auch das Bildchen in der Liste weg.
  if (!ver && owner === chatAvatarOwner()) vergissListenbild();
  const raum = app.session?.roomId;
  void ensureAvatar(owner, ver).then(() => {
    if (app.session?.roomId !== raum) return;
    rememberChatAvatar(raum);
    updatePeerStatus();
    redrawAll();
  });
}

function onRole(frame) {
  const ziel = String(frame.to ?? '');
  const recht = frame.role === 'admin' ? 'admin' : 'member';
  if (ziel === app.me?.id) {
    app.myRole = recht;
    toast(recht === 'admin' ? t('roleYouAdmin') : t('roleYouMember'));
  } else {
    memberOf(ziel).role = recht;
  }
  updatePeerStatus();
}

/**
 * Jemand hat die Gruppe verlassen. Seine Nachrichten sind schon auf dem
 * Server zu Platzhaltern geworden - die Anzeige zieht nach.
 */
function onMemberLeft(frame) {
  const wer = String(frame.from ?? '');
  if (wer === app.me?.id) return;
  const member = memberOf(wer);
  member.left = true;
  member.online = false;
  member.typing = false;
  member.avatarVer = null;
  member.nick = '';
  member.bio = '';
  clearTimeout(member.typingTimer);
  for (const eintrag of app.messages.values()) {
    if (eintrag.from !== wer) continue;
    eintrag.gone = true;
    eintrag.deleted = true;
    eintrag.payload = null;
    eintrag.reactions = {};
    eintrag.att = [];
  }
  redrawAll();
  updatePeerStatus();
}

/** Die Gruppe hat weitere Plaetze bekommen. */
function onCapacity(frame) {
  const platz = Number(frame.capacity);
  if (!Number.isInteger(platz) || platz <= 0) return;
  if (app.session) {
    app.session = merkeSession(app.session.roomId, { capacity: platz }) ?? { ...app.session, capacity: platz };
  }
  updatePeerStatus();
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
  keepAtBottom();
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
    // Wer die Gruppe verlassen hat, nimmt seine Nachrichten mit. An ihrer
    // Stelle steht eine Zeile - und zwar eine je Person, nicht eine je
    // verschwundener Nachricht: sonst stuende dasselbe zwanzigmal
    // untereinander.
    if (entry.gone) {
      if (!previous?.gone || previous.from !== entry.from) {
        fragment.appendChild(make('div', 'day-sep day-sep--left', t('memberLeft')));
      }
      previous = entry;
      continue;
    }
    // Ohne bekannten Absender wird nicht zusammengefasst: zwei Blasen ohne
    // Absender kaemen sonst als eine Folge derselben Person heraus, und die
    // zweite verloere ihren Namen darueber.
    const sameSender = previous
      && Boolean(entry.from)
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
    // Eigene Klasse, obwohl sie aussieht wie eine eingehende Blase: sie ist
    // keine Nachricht. Wer Nachrichten zaehlt - die Oberflaeche wie die
    // Tests -, muss sie auslassen koennen, sonst gilt ein Tippen als
    // angekommene Nachricht.
    typingNode = make('div', 'msg msg--in msg--typing');
    const bubble = make('div', 'bubble typing-bubble');
    bubble.append(make('i'), make('i'), make('i'));
    typingNode.appendChild(bubble);
  }
  list.appendChild(typingNode);
  if (app.atBottom) scrollToBottom(true);
}

/**
 * Welche Nachrichten schon einmal auf dem Bildschirm standen.
 *
 * Die Liste wird bei jeder Aenderung komplett neu aufgebaut - bei jeder
 * Lesebestaetigung, bei jedem Tippen des Gegenuebers. Ohne dieses Gedaechtnis
 * huepfte dabei jedes Mal der ganze Verlauf. Bewegen soll sich nur, was
 * wirklich neu ist.
 */
const schonGezeigt = new Set();

/** Alles, was gerade da ist, gilt als gezeigt - ohne Bewegung. */
function markiereAlsGezeigt() {
  for (const id of app.order) schonGezeigt.add(id);
}

// ===========================================================================
// Verborgene Nachrichten
//
// Der Absender entscheidet vor dem Abschicken, dass eine Nachricht verdeckt
// ankommen soll. Beim Empfaenger steht dann eine Flaeche statt des Inhalts;
// ein Antippen deckt auf, das naechste deckt wieder zu.
//
// Verdeckt heisst hier: nicht im Bild. Der Inhalt wird nicht unscharf
// gezeichnet und nicht dahintergelegt, sondern gar nicht erst gebaut - was
// nicht dasteht, kann auch niemand im Vorbeigehen mitlesen oder aus einem
// Bildschirmfoto herausrechnen.
//
// Die Kennzeichnung reist im verschluesselten Paket mit. Der Server sieht
// nicht, welche Nachricht verdeckt ist - fuer ihn ist alles derselbe
// Zahlensalat.
// ===========================================================================

/**
 * Welche Nachrichten gerade aufgedeckt sind.
 *
 * Nur fuer diesen Besuch. Wer den Chat verlaesst und wiederkommt, findet
 * alles wieder zugedeckt vor - sonst waere das Verbergen eine einmalige
 * Huerde und keine Eigenschaft der Nachricht.
 */
const aufgedeckt = new Set();

/** Traegt diese Nachricht die Kennzeichnung "verdeckt"? */
const istVerdeckt = (entry) => entry?.payload?.hidden === true && !entry.deleted;

/** Und ist sie es gerade auch auf dem Bildschirm? */
const zeigtDecke = (entry) => istVerdeckt(entry) && !aufgedeckt.has(entry.id);

/**
 * Welche Aufdeckungen schon gemeldet sind.
 *
 * Der Server nimmt eine zweite Meldung nicht an, aber sie zu schicken waere
 * Laerm: wer eine Nachricht dreimal auf- und zudeckt, meldet einmal.
 */
const gemeldet = new Set();

/** Auf- und wieder zudecken. */
function toggleReveal(entry) {
  if (!istVerdeckt(entry)) return;
  if (aufgedeckt.has(entry.id)) aufgedeckt.delete(entry.id);
  else {
    aufgedeckt.add(entry.id);
    meldeAufgedeckt(entry);
  }
  redrawAll();
}

/**
 * Sagt dem Absender, dass seine verdeckte Nachricht angesehen wurde.
 *
 * Nur beim ersten Mal, nur bei fremden Nachrichten und nur bei solchen, die
 * der Server schon kennt - eine eigene, noch nicht abgeschickte hat nur eine
 * vorlaeufige Kennung.
 */
function meldeAufgedeckt(entry) {
  if (isMine(entry) || entry.pending || String(entry.id).startsWith('local:')) return;
  if (gemeldet.has(entry.id)) return;
  gemeldet.add(entry.id);
  app.conn?.send({ t: 'reveal', id: entry.id });
}

/**
 * Die Decke: eine Flaeche, hinter der nichts liegt.
 *
 * Sie sagt nicht, was sie verdeckt - weder "Bild" noch die ersten Worte.
 * Sonst waere die Haelfte schon verraten, und der Absender hat sich anders
 * entschieden.
 */
function buildHiddenNode(entry) {
  const knopf = make('button', 'spoiler');
  knopf.type = 'button';
  knopf.appendChild(icon('i-eye-off'));
  knopf.appendChild(make('span', 'spoiler__label', t('spoilerCovered')));
  knopf.setAttribute('aria-label', t('spoilerReveal'));
  knopf.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleReveal(entry);
  });
  return knopf;
}

/** Der kleine Knopf, der eine aufgedeckte Nachricht wieder zudeckt. */
function buildCoverAgain(entry) {
  const knopf = make('button', 'spoiler-again griff');
  knopf.type = 'button';
  knopf.appendChild(icon('i-eye'));
  knopf.setAttribute('aria-label', t('spoilerCoverAgain'));
  knopf.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleReveal(entry);
  });
  return knopf;
}

function buildMessageNode(entry, sameSender) {
  const mine = isMine(entry);
  const wrapper = make('div', `msg ${mine ? 'msg--out' : 'msg--in'}${sameSender ? ' msg--same' : ''}`);
  wrapper.dataset.id = entry.id;
  if (!schonGezeigt.has(entry.id)) {
    wrapper.classList.add('is-new');
    schonGezeigt.add(entry.id);
  }

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
  } else if (zeigtDecke(entry)) {
    // Auch das Zitat bleibt drunter: es gehoert zur Nachricht, und wer die
    // Antwort verdeckt, hat nicht die Frage freigegeben.
    bubble.classList.add('is-spoiler');
    bubble.appendChild(buildHiddenNode(entry));
  } else {
    if (istVerdeckt(entry)) {
      bubble.classList.add('is-spoiler', 'is-revealed');
      // Ein Klick auf die Blase deckt wieder zu - aber nicht, wenn er einem
      // Link, einem Bild oder einem Knopf galt, und nicht, waehrend jemand
      // Text markiert. Sonst verschwaende das Zudecken jede Auswahl.
      bubble.addEventListener('click', (event) => {
        if (event.target.closest('a, button, img, audio, video, .image-wrap, .voice')) return;
        if (!(window.getSelection()?.isCollapsed ?? true)) return;
        toggleReveal(entry);
      });
    }
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
  // Ein Knopf, kein DIV: das Zitat fuehrt zur zitierten Nachricht, und das
  // ging nur mit der Maus. Ein <div> mit Klick-Handler bekommt keinen Fokus,
  // steht in keiner Tabulator-Reihenfolge und antwortet nicht auf die
  // Eingabetaste.
  const quote = make('button', 'quote');
  quote.type = 'button';
  // Wer zitiert wird, steht mit Namen da - in einer Gruppe ist "das
  // Gegenüber" schlicht falsch, es gibt mehrere.
  const wer = reply.from === app.me?.id ? t('you') : (isGroup() ? nameOf(reply.from) : peerName());
  quote.setAttribute('aria-label', t('jumpToQuoted', { name: wer }));
  quote.appendChild(make('strong', null, wer));
  quote.appendChild(document.createTextNode(reply.text ?? ''));
  quote.addEventListener('click', () => jumpTo(reply.id));
  return quote;
}

/**
 * Wer eine verdeckte Nachricht aufgedeckt hat - ohne die, die nicht mehr da
 * sind, und ohne einen selbst.
 */
function aufdecker(entry) {
  return (entry.revealedBy ?? [])
    .filter((id) => id !== app.me?.id)
    .map((id) => app.members.get(id))
    .filter((member) => member && member.left !== true);
}

/**
 * Die Marke an der eigenen verdeckten Nachricht: schon angesehen oder nicht.
 *
 * Bewusst Text und kein zweites Auge. In einer Gruppe steht neben der
 * Lesebestaetigung schon eines, und zwei fast gleiche Augen nebeneinander
 * sagen weniger als ein Wort.
 */
function buildRevealMark(entry) {
  const wer = aufdecker(entry);
  const offen = others().filter((member) => !wer.includes(member));
  const auf = wer.length > 0;
  const text = auf && isGroup() ? `${t('spoilerOpened')} · ${wer.length}` : (auf ? t('spoilerOpened') : t('spoilerStillCovered'));

  // In einer Gruppe ist die Zahl nur der Anfang der Frage - wer denn?
  const knoten = isGroup() ? make('button', 'reveal-mark', text) : make('span', 'reveal-mark', text);
  knoten.classList.toggle('is-open', auf);
  if (isGroup()) {
    knoten.type = 'button';
    knoten.addEventListener('click', (event) => {
      event.stopPropagation();
      openSheet(t('spoilerWhoTitle'), [
        make('p', 'sheet-note sheet-note--strong', `${t('spoilerOpenedBy')} (${wer.length})`),
        namensListe(wer, 'is-read'),
        ...(offen.length > 0 ? [
          make('p', 'sheet-note sheet-note--strong', `${t('spoilerNotYet')} (${offen.length})`),
          make('p', 'sheet-note', t('spoilerWhoHint')),
          namensListe(offen, 'is-pending'),
        ] : []),
      ], { autofocus: false });
    });
  } else {
    knoten.setAttribute('title', auf ? t('spoilerOpened') : t('spoilerStillCovered'));
  }
  return knoten;
}

function buildMeta(entry, mine) {
  const meta = make('div', 'bubble__meta');
  // Bei einer aufgedeckten Nachricht steht hier der Weg zurueck. Er muss
  // sein: bei einem Bild ist die ganze Blase das Bild, ein Klick darauf
  // gehoert der Lupe, und ohne diesen Knopf bekaeme man sie nie wieder zu.
  if (istVerdeckt(entry) && aufgedeckt.has(entry.id)) meta.appendChild(buildCoverAgain(entry));
  // Und beim Absender: ob drueben schon jemand hingesehen hat.
  if (mine && istVerdeckt(entry) && entry.status === 'sent') meta.appendChild(buildRevealMark(entry));
  // Nicht am Grabstein: die Nachricht ist geloescht, "bearbeitet" sagt darueber
  // nichts mehr aus und stand dort trotzdem weiter.
  if (entry.editedAt && !entry.deleted) meta.appendChild(make('span', null, t('edited')));
  meta.appendChild(make('span', null, formatClock(entry.ts)));
  if (!mine) return meta;

  /**
   * Der Zustand einer eigenen Nachricht - und zwar nicht nur als Farbe.
   *
   * "Zugestellt" und "gelesen" sind derselbe Doppelhaken; ueber der Blase
   * lassen sich die beiden Toene nur um 1.21:1 in der Helligkeit
   * auseinanderziehen, weil beide 3:1 zur Blase halten muessen. Wer Blau
   * und Weiss nicht unterscheiden kann, saehe zweimal dasselbe. Also traegt
   * jeder Zustand seinen Namen mit - vorgelesen und beim Darueberfahren.
   */
  const zeichen = (name, text, gelesen = false) => {
    const marke = icon(name);
    if (gelesen) marke.classList.add('is-read');
    marke.setAttribute('role', 'img');
    marke.setAttribute('aria-label', text);
    const titel = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    titel.textContent = text;
    marke.appendChild(titel);
    return marke;
  };

  if (entry.status === 'sending') meta.appendChild(zeichen('i-clock', t('stateSending')));
  else if (entry.status === 'failed') {
    const retry = make('button', 'btn btn--ghost', '↻');
    retry.type = 'button';
    retry.setAttribute('aria-label', t('stateFailed'));
    retry.addEventListener('click', () => resend(entry));
    meta.appendChild(retry);
  } else if (isGroup()) {
    // In einer Gruppe sagt ein Haken zu wenig: bei acht Leuten ist "alle
    // haben gelesen" selten und "jemand hat gelesen" nichtssagend. Also die
    // Zahl - und wer dahintersteckt, auf Wunsch.
    meta.appendChild(buildSeen(entry));
  } else if (allRead(entry.seq)) {
    // In einer Gruppe erst, wenn WIRKLICH alle gelesen haben. Alles andere
    // wäre eine Bestätigung, die man nicht bekommen hat.
    meta.appendChild(zeichen('i-check-double', t('stateRead'), true));
  } else if (anyOnline()) {
    meta.appendChild(zeichen('i-check-double', t('stateDelivered')));
  } else {
    meta.appendChild(zeichen('i-check', t('stateSent')));
  }
  return meta;
}

/**
 * Das Auge unter der eigenen Nachricht: wie viele haben sie gelesen.
 *
 * Antippen oeffnet die Liste; wer eine Maus hat, sieht sie schon beim
 * Darueberfahren in einer Blase, die aus dem Auge herauswaechst.
 */
function buildSeen(entry) {
  const { gelesen, offen } = seenSplit(entry.seq);
  const knopf = make('button', 'seen griff');
  knopf.type = 'button';
  if (gelesen.length > 0) knopf.classList.add('is-read');
  knopf.setAttribute('aria-label', t('seenCount', { n: gelesen.length, total: gelesen.length + offen.length }));

  knopf.appendChild(icon('i-eye'));
  knopf.appendChild(make('span', 'seen__count', String(gelesen.length)));
  // Die Blase gehoert nicht in die Nachricht - sie steht oben im Dokument,
  // eine einzige fuer den ganzen Chat, und wird hier nur gerufen.
  const zeigen = () => zeigeSeenBlase(knopf, gelesen, offen);
  knopf.addEventListener('mouseenter', zeigen);
  knopf.addEventListener('focus', zeigen);
  knopf.addEventListener('mouseleave', versteckeSeenBlase);
  knopf.addEventListener('blur', versteckeSeenBlase);

  knopf.addEventListener('click', (event) => {
    // Nicht das Nachrichtenmenue mitoeffnen.
    event.stopPropagation();
    openSeenSheet(entry);
  });
  return knopf;
}

/** Wie weit die Blase vom Auge und vom Fensterrand wegbleibt. */
const BLASE_LUFT = 9;
const BLASE_RAND = 8;

/** Gibt es hier ueberhaupt einen Mauszeiger? */
const hatZeiger = () => window.matchMedia?.('(hover: hover) and (pointer: fine)').matches === true;

/**
 * Zeigt die Blase ueber dem Auge - und darunter, wenn oben kein Platz ist.
 *
 * Gerechnet wird in Fensterkoordinaten, denn die Blase haengt am Fenster.
 * Nur so kommt sie aus dem Rollbereich des Verlaufs heraus, der sonst alles
 * abschneidet, was ueber seinen Rand hinausragt - und aus dem Stapel der
 * Fusszeile, die auf opacity < 1 steht und darum keinen z-index durchlaesst.
 */
function zeigeSeenBlase(knopf, gelesen, offen) {
  const blase = el('seen-pop');
  if (!blase || !hatZeiger()) return;
  blase.replaceChildren(...seenLines(gelesen, offen));
  blase.hidden = false;
  blase.classList.remove('is-unten');
  blase.style.left = '0px';
  blase.style.top = '0px';

  const auge = knopf.getBoundingClientRect();
  const mass = blase.getBoundingClientRect();
  const platzOben = auge.top - BLASE_LUFT - BLASE_RAND;
  const unten = mass.height > platzOben;
  blase.classList.toggle('is-unten', unten);
  const top = unten ? auge.bottom + BLASE_LUFT : auge.top - BLASE_LUFT - mass.height;

  // Die Spitze sitzt rechts - also die rechte Kante am Auge ausrichten und
  // erst dann ins Fenster schieben, falls sie sonst herausragte.
  const rechts = Math.min(window.innerWidth - BLASE_RAND, auge.right + 4);
  const left = Math.max(BLASE_RAND, rechts - mass.width);
  blase.style.left = `${Math.round(left)}px`;
  blase.style.top = `${Math.round(top)}px`;
  // Erst jetzt einblenden: sonst saehe man sie fuer einen Bildaufbau oben
  // links in der Ecke stehen.
  requestAnimationFrame(() => blase.classList.add('is-offen'));
}

function versteckeSeenBlase() {
  const blase = el('seen-pop');
  if (!blase) return;
  blase.classList.remove('is-offen');
  blase.hidden = true;
}

/** Namen, aber nicht endlos: ab einer Handvoll wird gezaehlt. */
function seenNames(liste, hoechstens = 5) {
  const namen = liste.slice(0, hoechstens).map((member) => memberName(member));
  if (liste.length > hoechstens) namen.push(t('seenMore', { n: liste.length - hoechstens }));
  return namen.join(', ');
}

/** Der Inhalt der Blase am Rechner - dieselbe Auskunft, nur ohne Antippen. */
function seenLines(gelesen, offen) {
  const zeile = (klasse, titel, liste) => {
    const teil = make('span', `seen__line ${klasse}`);
    teil.appendChild(make('strong', null, `${titel}: `));
    teil.appendChild(document.createTextNode(liste.length > 0 ? seenNames(liste) : t('seenNobody')));
    return teil;
  };
  const zeilen = [zeile('is-read', t('seenRead'), gelesen)];
  if (offen.length > 0) zeilen.push(zeile('is-pending', t('seenPending'), offen));
  return zeilen;
}

/** Die ausfuehrliche Liste - am Handy der Weg dorthin. */
/** Eine Liste mit Bild und Namen - fuer die Lesebestaetigung wie fuers Aufdecken. */
function namensListe(mitglieder, klasse) {
  const block = make('div', `seen-list ${klasse}`);
  for (const member of mitglieder) {
    const zeile = make('div', 'seen-row');
    zeile.appendChild(avatarNode(member.id, memberName(member), 'avatar--sm'));
    zeile.appendChild(make('span', 'seen-row__name', memberName(member)));
    block.appendChild(zeile);
  }
  if (mitglieder.length === 0) block.appendChild(make('p', 'sheet-note', t('seenNobody')));
  return block;
}

function openSeenSheet(entry) {
  const { gelesen, offen } = seenSplit(entry.seq);
  const liste = namensListe;

  openSheet(t('seenTitle'), [
    make('p', 'sheet-note sheet-note--strong', `${t('seenRead')} (${gelesen.length})`),
    liste(gelesen, 'is-read'),
    ...(offen.length > 0 ? [
      make('p', 'sheet-note sheet-note--strong', `${t('seenPending')} (${offen.length})`),
      make('p', 'sheet-note', t('seenPendingHint')),
      liste(offen, 'is-pending'),
    ] : []),
  ], { autofocus: false });
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

/**
 * Wohin die App zuletzt von selbst gesprungen ist.
 *
 * Scroll-Ereignisse kommen nicht sofort, sondern erst zum naechsten
 * Bildaufbau - und bis dahin kann die Liste hoeher geworden sein. Wer dann
 * bloss den Abstand zum Ende ausrechnet, haelt einen fuer jemanden, der nach
 * oben gewischt hat, und laesst einen nicht mehr automatisch mitlaufen.
 * Deshalb wird der eigene Sprung gemerkt: steht die Liste noch genau dort,
 * hat sich niemand geruehrt.
 */
let gesetzterStand = -1;

function scrollToBottom(instant = false) {
  const list = el('messages');
  if (!list) return;
  // "instant" heisst wirklich sofort. "auto" waere das Gegenteil: es
  // uebernimmt die CSS-Regel scroll-behavior, und die steht hier auf
  // smooth - der Sprung ans Ende wurde damit zu einer Reise durch den
  // ganzen Verlauf, die unterwegs stehen blieb, sobald ein Bild die Hoehe
  // aenderte. Genau so landete man mitten im Chat statt bei der neuesten
  // Nachricht.
  const behavior = instant ? 'instant' : 'smooth';
  list.scrollTo({ top: list.scrollHeight, behavior });
  if (instant) gesetzterStand = list.scrollTop;
  app.atBottom = true;
  app.unread = 0;
  updateJumpButton();
}

/**
 * Haelt die Ansicht unten, solange sie unten sein soll.
 *
 * Ein einmaliger Sprung ans Ende reicht nicht: Bilder, Vorschauen und
 * Sprachnachrichten bekommen ihre endgueltige Hoehe erst, wenn sie geladen
 * sind, und ein spaet entschluesselter Anhang kann das noch Minuten spaeter
 * tun. Bis dahin ist das "Ende" gar nicht dort, wo es hinterher liegt - und
 * man steht mitten im Verlauf statt bei der neuesten Nachricht.
 *
 * Deshalb wird nachgezogen, solange der Chat offen ist: einmal je Bild
 * nachsehen, ob die Liste hoeher geworden ist, und nur dann etwas tun. Wer
 * selbst nach oben wischt, setzt app.atBottom auf false und wird sofort in
 * Ruhe gelassen.
 */
let bodenWache = null;
function keepAtBottom() {
  const list = el('messages');
  if (!list) return;
  cancelAnimationFrame(bodenWache);
  let letzte = -1;
  const nachziehen = () => {
    if (currentScreen() !== 'chat') {
      bodenWache = null;
      return;
    }
    const hoehe = list.scrollHeight;
    if (hoehe !== letzte) {
      letzte = hoehe;
      // Ausdruecklich ohne Weichzeichnen: die CSS-Regel scroll-behavior
      // wuerde jeden dieser Spruenge animieren, und der naechste faenge
      // mitten in der Animation des vorigen an.
      if (app.atBottom) {
        list.scrollTo({ top: hoehe, behavior: 'instant' });
        gesetzterStand = list.scrollTop;
      }
    }
    bodenWache = requestAnimationFrame(nachziehen);
  };
  bodenWache = requestAnimationFrame(nachziehen);
}

function stopKeepAtBottom() {
  cancelAnimationFrame(bodenWache);
  bodenWache = null;
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
  fillAvatar(el('peer-avatar'), chatAvatarOwner(), peerName());

  const status = el('peer-status');
  status.classList.remove('is-online', 'is-typing');
  if (app.connectionStatus === 'connecting' || app.connectionStatus === 'reconnecting') {
    // Dasselbe sagen wie das Banner darunter. Vorher stand dort "Keine
    // Verbindung. Nachrichten warten hier." und eine Zeile hoeher
    // "Verbindung wird hergestellt …" - zwei Saetze uebereinander, die sich
    // widersprachen. Ohne Netz wird eben nichts hergestellt.
    setStatusText(navigator.onLine === false ? t('noNetwork')
      : t(app.connectionStatus === 'reconnecting' ? 'reconnecting' : 'connecting'));
    return;
  }
  const tippen = typingNow();
  if (tippen.length > 0) {
    setStatusText(isGroup() ? t('typingSome', { names: nameList(tippen) }) : t('typing'));
    status.classList.add('is-typing');
    return;
  }
  if (isGroup()) {
    // In einer Gruppe hilft "zuletzt gesehen" niemandem - gefragt ist, wie
    // viele gerade da sind. Man selbst zählt mit: sonst stünde "0 von 5",
    // während man selbst im Chat sitzt.
    const da = onlineCount() + 1;
    const alle = app.session?.capacity || app.members.size + 1;
    setStatusText(t('groupPresence', { online: da, total: alle }));
    if (da > 1) status.classList.add('is-online');
    return;
  }
  const gegenueber = peerOf();
  if (!gegenueber) {
    setStatusText(t('neverSeen'));
    return;
  }
  if (gegenueber.online) {
    setStatusText(t('online'));
    status.classList.add('is-online');
    return;
  }
  setStatusText(gegenueber.lastSeen ? t('lastSeen', { time: relativeTime(gegenueber.lastSeen) }) : t('offline'));
}

// ------------------------------------------------------- Laufende Statuszeile

/** Bildpunkte je Sekunde - langsam genug zum Mitlesen. */
const LAUF_TEMPO = 26;
/**
 * Anteil der Laufzeit, in dem der Text tatsaechlich unterwegs ist. Der Rest
 * sind die beiden Ruhepausen aus den Keyframes (16 % am Anfang, 16 % am
 * fernen Ende). Aus diesem Anteil wird die Dauer so berechnet, dass die
 * Geschwindigkeit gleich bleibt, egal wie weit der Weg ist.
 */
const LAUF_ANTEIL = 0.64;
const LAUF_MIN = 6;
const LAUF_MAX = 40;

/**
 * Schreibt die Statuszeile - und laesst sie laufen, wenn sie nicht passt.
 *
 * "zuletzt gesehen vor 3 Std." ist auf einem schmalen Telefon laenger als
 * die Zeile. Abgeschnitten steht da "zuletzt gesehen vor 3 …" - also genau
 * das nicht, was man wissen wollte.
 */
function setStatusText(text) {
  const feld = el('peer-status-text');
  if (!feld) return;
  // Nur bei echter Aenderung anfassen. updatePeerStatus() laeuft bei jedem
  // Lebenszeichen, jeder Lesebestaetigung, jedem Tastenanschlag des
  // Gegenuebers - wuerde jedes Mal neu gemessen, finge die Laufschrift
  // jedes Mal wieder von vorne an und kaeme nie bis zum Ende.
  if (feld.textContent === text) return;
  feld.textContent = text;
  measureStatus();
}

/**
 * Misst nach, ob der Text passt, und stellt Weg und Dauer ein.
 *
 * Die Klasse wird zum Messen abgenommen: mit ihr steht der Text womoeglich
 * gerade verschoben, und dann misst man den Versatz mit.
 */
function measureStatus() {
  const rahmen = el('peer-status');
  const feld = el('peer-status-text');
  if (!rahmen || !feld) return;
  rahmen.classList.remove('is-lauf');
  const platz = rahmen.clientWidth;
  const breite = feld.scrollWidth;
  const zuviel = breite - platz;
  // Kein Platz gemessen (Bildschirm nicht sichtbar) oder es passt: nichts tun.
  if (platz <= 0 || zuviel <= 2) return;
  const weg = zuviel + 4;
  const dauer = Math.min(LAUF_MAX, Math.max(LAUF_MIN, (2 * weg) / LAUF_TEMPO / LAUF_ANTEIL));
  rahmen.style.setProperty('--lauf-weg', `${-weg}px`);
  rahmen.style.setProperty('--lauf-dauer', `${dauer.toFixed(2)}s`);
  rahmen.classList.add('is-lauf');
}

/**
 * Dreht sich das Geraet oder wird das Fenster schmaler, passt der Text auf
 * einmal nicht mehr - oder wieder doch. Also nachmessen, wenn sich die
 * Breite der Zeile aendert.
 */
function watchStatusWidth() {
  const rahmen = el('peer-status');
  if (!rahmen || typeof ResizeObserver !== 'function') return;
  let zuletzt = 0;
  new ResizeObserver(() => {
    const breit = rahmen.clientWidth;
    if (breit === zuletzt) return;
    zuletzt = breit;
    measureStatus();
  }).observe(rahmen);
}

/**
 * Wird der Verlauf niedriger, bleibt sein Ende sichtbar.
 *
 * Der Chat ist ein Raster: Kopfzeile, Banner, Verlauf, Textzeile. Alles, was
 * ueber oder unter dem Verlauf waechst, nimmt ihm Hoehe weg - das Banner
 * "Verbindung weg", die Antwort-Vorschau, die Verdeckt-Leiste, eine Reihe
 * Anhaenge, die aufgehende Aufnahme. Der Rollstand blieb dabei stehen, wo er
 * war, und die neueste Nachricht rutschte unter den Rand: gemessen 31
 * Bildpunkte beim Banner, mehr bei Vorschau plus Anhaengen.
 *
 * Nachgefuehrt wird nur, wer vorher unten stand. Wer im Verlauf nach oben
 * gewischt hat, will dort bleiben.
 */
function watchViewportHeight() {
  const liste = el('messages');
  if (!liste || typeof ResizeObserver !== 'function') return;
  let zuletzt = liste.clientHeight;
  new ResizeObserver(() => {
    const jetzt = liste.clientHeight;
    if (jetzt === zuletzt) return;
    const geschrumpft = jetzt < zuletzt;
    zuletzt = jetzt;
    if (geschrumpft && app.atBottom) scrollToBottom(true);
  }).observe(liste);
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

  // Den Schalter jetzt ablesen und gleich zuruecksetzen: das Hochladen der
  // Anhaenge dauert, und wer inzwischen weiterschreibt, soll nicht
  // versehentlich noch eine verdeckte Nachricht abschicken.
  const verdeckt = app.sendHidden;
  app.sendHidden = false;
  renderSpoilerBar();

  if (attachments.length === 0) {
    await deliver({ v: 1, kind: 'text', text, reply, ...(verdeckt ? { hidden: true } : {}) }, []);
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
        // Jeder Anhang einzeln: sonst laege der zweite offen da, waehrend
        // der erste noch zugedeckt ist.
        ...(verdeckt ? { hidden: true } : {}),
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
    merkeSession(app.session.roomId, { lastActivity: Date.now() });
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
  // Eine verdeckte Nachricht bleibt auch in der Vorschau verdeckt. Sonst
  // stuende sie im Zitat einer Antwort, in der Meldung des Betriebssystems
  // und in der Ansage fuer den Screenreader - dreimal offen, und niemand
  // haette getippt.
  if (payload.hidden === true) return t('spoilerCovered');
  if (payload.text) return payload.text;
  if (payload.kind === 'image') return `🖼 ${t('image')}`;
  if (payload.kind === 'audio') return `🎤 ${t('voiceMessage')}`;
  if (payload.kind === 'file') return `📎 ${payload.media?.name ?? t('file')}`;
  return '';
};

/**
 * Name und Kurzbeschreibung an den Raum melden.
 *
 * Beides steckt im selben verschluesselten Paeckchen - der Server sieht so
 * oder so nur Zeichensalat, und ein Feld weniger heisst eine Sonderregel
 * weniger auf beiden Servern. Aeltere Fassungen lesen nur `n` und
 * uebersehen `b`, ohne dass etwas kaputtgeht.
 */
function sendNick(nick, bio = app.prefs?.bio ?? '') {
  if (!app.conn) return;
  const name = (nick ?? '').trim();
  const ueberMich = (bio ?? '').trim();
  if (!name && !ueberMich) {
    app.conn.send({ t: 'nick', ct: null });
    return;
  }
  encryptJson(app.key, { n: name, b: ueberMich })
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

  // Ein hereinkommender Anruf uebernimmt den Bildschirm - und liegt unter den
  // Blaettern, damit die Pruefzeichen mitten im Gespraech aufrufbar sind. Also
  // schliesst er offene Blaetter, sonst staende er selbst dahinter.
  //
  // Nur beim Auftauchen: renderCall() laeuft bei jeder Zustandsmeldung, und
  // unbedingt geschlossen fiele einem das Blatt mit den Pruefzeichen bei der
  // naechsten gleich wieder zu.
  const kamGerade = overlay.hidden;
  if (kamGerade && sheetOpen()) closeSheet();
  overlay.hidden = false;
  document.body.classList.add('is-calling');
  // Der Anruf ist als aria-modal ausgezeichnet - dann muss er den Fokus auch
  // halten. Gemessen war "Annehmen" der elfte Tab-Halt, davor lagen neun in
  // dem Chat, den der Anruf gerade zudeckt.
  if (kamGerade) fangeFokus(overlay);
  overlay.dataset.state = state.state;
  overlay.dataset.kind = state.kind;

  el('call-name').textContent = peerName();
  fillAvatar(el('call-avatar'), chatAvatarOwner(), peerName());
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
/** Die Marke der laufenden Anrufmeldung - kein Griff auf das Objekt. */
let callNotification = null;

function notifyCall(state) {
  closeCallNotification();
  if (state.state !== 'ringing') return;
  announce(`${peerName()}: ${callStateLabel(state)}`);
  if (!darfMelden() || document.visibilityState === 'visible') return;
  callNotification = `anruf:${app.session?.roomId ?? ''}`;
  void zeigeMeldung(peerName(), {
    body: callStateLabel(state),
    icon: appUrl('img/icon-192.png'),
    badge: appUrl('img/badge.png'),
    tag: callNotification,
    requireInteraction: true,
    data: { basis: basePath },
  });
}

/**
 * Die Meldung zum Anruf wieder wegnehmen.
 *
 * Gemerkt wird nur ihre Marke, kein Griff auf das Objekt: eine Meldung des
 * Service Workers ueberlebt die Seite, und ein Griff aus dem Fenster wuerde
 * sie nach einem Neuladen nicht mehr finden.
 */
function closeCallNotification() {
  if (!callNotification) return;
  void schliesseMeldungen(callNotification);
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
    const warOffen = !overlay.hidden;
    overlay.hidden = true;
    delete overlay.dataset.state;
    if (warOffen) gibFokusZurueck(overlay);
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
  app.session = merkeSession(app.session.roomId, patch) ?? { ...app.session, ...patch };
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
  // Was nicht mehr hineinpasst, faellt weg - aber nicht stillschweigend.
  // Wer sechs Bilder auswaehlt und vier bekommt, soll es erfahren; vorher
  // stand hier obendrein "Die Datei ist zu groß", was gar nicht stimmte.
  const weggelassen = files.length - list.length;
  if (weggelassen > 0) toast(t('tooManyFiles', { max: `${MAX_ATTACHMENTS}`, n: `${weggelassen}` }));
  if (!list.length) return;
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
    const remove = make('button', 'attachment__remove griff');
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
    {
      icon: app.sendHidden ? 'i-eye-off' : 'i-eye',
      label: t('sendHidden'),
      hint: t('sendHiddenHint'),
      value: app.sendHidden ? t('switchOn') : t('switchOff'),
      onClick: toggleSendHidden,
    },
  ]);
}

/**
 * Die naechste Nachricht verdeckt schicken - oder eben doch nicht.
 *
 * Der Schalter gilt fuer eine Nachricht und faellt danach von selbst zurueck.
 * Andersherum waere es die gefaehrlichere Voreinstellung: wer einmal
 * umgelegt hat und es vergisst, schickt tagelang Flaechen statt Saetzen.
 */
function toggleSendHidden() {
  app.sendHidden = !app.sendHidden;
  renderSpoilerBar();
}

/** Die Leiste ueber der Textzeile zeigt, was gleich hinausgeht. */
function renderSpoilerBar() {
  const leiste = el('spoiler-bar');
  if (leiste) leiste.hidden = !app.sendHidden;
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

  // Kopieren erst, wenn aufgedeckt ist: sonst nimmt man aus der Zwischenablage
  // mit, was man nicht angesehen hat - und der Absender hatte sich anders
  // entschieden.
  if (entry.payload?.text && !zeigtDecke(entry)) {
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
  const notificationLabel = meldungsBeschriftung();

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
    { icon: 'i-user', label: t('myProfile'), hint: t('myProfileHint'), onClick: openMyProfile },
    // Nur zeigen, wenn es etwas zu verbergen gibt - oder schon etwas
    // verborgen ist. Ein Schalter fuer ein Bild, das man gar nicht hat,
    // waere Ratespiel statt Einstellung.
    ...(app.prefs?.avatar || meinBildVerborgen() ? [{
      icon: meinBildVerborgen() ? 'i-eye-off' : 'i-eye',
      label: t('hideMyAvatar'),
      hint: isGroup() ? t('hideMyAvatarGroupHint') : t('hideMyAvatarHint'),
      value: meinBildVerborgen() ? t('switchOn') : t('switchOff'),
      onClick: () => void toggleMyAvatarHere(),
    }] : []),
    // Das Gegenueber - oder in einer Gruppe die Gruppe selbst, mit dem Weg
    // zu jedem einzelnen Mitglied.
    {
      icon: isGroup() ? 'i-users' : 'i-user',
      label: isGroup() ? t('groupProfile') : t('profile'),
      value: peerName(),
      onClick: openChatProfile,
    },
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
  app.session = merkeSession(app.session.roomId, { nick: next }) ?? app.session;
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
    // Ueber die Leitung, nicht ueber den Kanal: die Anfrage sagt, ob es
    // geklappt hat, und funktioniert bei beiden Auslieferungen gleich. Der
    // Kanal bleibt der Rueckweg, falls sie gar nicht erst durchkommt.
    //
    // Vorher liefen beide: der Kanal loeschte den Raum, und die Anfrage
    // danach fand nichts mehr vor - eine 404 bei jedem einzelnen Loeschen.
    const weg = await burnRoom(session.roomId, session.token).then(() => true, () => false);
    if (!weg) app.conn?.send({ t: 'burn' });
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
  // Ein versteckter Chat steht nicht in der Liste - fuer ihn muss der Block
  // weg, sonst haette "verlassen" gar nichts getan.
  const versteckt = app.session?.roomId === roomId && app.session.versteckId
    ? app.session.versteckId
    : app.entdeckt.find((eintrag) => eintrag.roomId === roomId)?.versteckId;
  if (versteckt) {
    removeHidden(versteckt);
    versteckSchluessel.delete(versteckt);
    app.entdeckt = app.entdeckt.filter((eintrag) => eintrag.roomId !== roomId);
  }
  if (app.session?.roomId === roomId) {
    teardownChat();
    showStart();
  } else {
    renderChatList();
  }
}

// ===========================================================================
// Was sich geaendert hat
// ===========================================================================

/**
 * Die Liste der Aenderungen, neueste zuerst.
 *
 * @param {{seit?: string|null}} [wie] `seit` markiert alles, was danach kam,
 *   als neu - und stellt einen Satz voran. Ohne Angabe ist es die schlichte
 *   Chronik, wie sie ueber den Knopf in der Fusszeile aufgeht.
 */
function showChangelog({ seit = null } = {}) {
  const datum = new Intl.DateTimeFormat(getLanguage(), { dateStyle: 'medium', timeStyle: 'short' });
  const liste = make('div', 'changelog');

  for (const eintrag of CHANGELOG) {
    const zeile = make('div', 'changelog__item');
    if (seit && eintrag.ts > seit) zeile.classList.add('is-new');
    const kopf = make('div', 'changelog__when');
    kopf.appendChild(make('time', null, datum.format(new Date(eintrag.ts))));
    // Die Zeit steht als maschinenlesbares Attribut daneben - sonst liest ein
    // Vorleseprogramm "11:21" als Zahlenfolge statt als Uhrzeit.
    kopf.querySelector('time').dateTime = eintrag.ts;
    if (seit && eintrag.ts > seit) kopf.appendChild(make('span', 'changelog__neu', t('changelogNew')));
    zeile.appendChild(kopf);
    zeile.appendChild(make('p', 'changelog__text', getLanguage() === 'en' ? eintrag.en : eintrag.de));
    liste.appendChild(zeile);
  }

  openSheet(t('changelogTitle'), [
    make('p', 'sheet-note', seit ? t('changelogSinceVisit') : t('changelogHint')),
    liste,
  ], { autofocus: false });
  merkeChangelog();
}

/** Ab jetzt gilt alles als gesehen. */
function merkeChangelog() {
  app.prefs = setPrefs({ seenVersion: APP_VERSION, seenChangelog: NEUESTE_AENDERUNG });
}

/**
 * Beim Start: hat sich seit dem letzten Besuch die Fassung geaendert?
 *
 * Dann geht die Liste von selbst auf - genau einmal, denn sie merkt sich
 * dabei sofort, dass sie gesehen wurde. Beim allerersten Besuch passiert
 * nichts: wer die App gerade erst gefunden hat, will keine Chronik lesen,
 * sondern schreiben.
 */
function changelogNachUpdate() {
  const vorher = app.prefs?.seenVersion ?? null;
  if (!vorher) {
    // Erster Besuch: still merken, nichts zeigen - aber nur, wenn hier
    // ohnehin schon etwas liegt. Direkt nach "alle Daten loeschen" ist der
    // Speicher leer, und ein Lesezeichen waere der erste Rueckstand.
    if (etwasGespeichert()) merkeChangelog();
    return;
  }
  if (vorher === APP_VERSION) return;
  showChangelog({ seit: app.prefs?.seenChangelog ?? null });
}

function showAbout() {
  openSheet(t('about'), [
    make('p', 'sheet-note', t('aboutText')),
    make('p', 'sheet-note', t('aboutRetention')),
    // Ganz unten und als Gefahr gekennzeichnet: hier landet niemand aus
    // Versehen, und wer es sucht, findet es an der Stelle, an der man
    // so etwas sucht.
    { icon: 'i-trash', label: t('wipeAll'), hint: t('wipeAllHint'), danger: true, onClick: () => void wipeFlow() },
  ]);
}

// ===========================================================================
// Profilbild waehlen und zuschneiden
// ===========================================================================

/**
 * Wie weit sich hinein- und herauszoomen laesst.
 *
 * Bezugsgroesse ist nicht das Bild, sondern das Fenster: bei "deckend"
 * fuellt das Bild das Quadrat gerade aus, bei "hineinpassend" ist es
 * vollstaendig zu sehen. Herauszoomen geht bewusst noch deutlich darueber
 * hinaus - wer sein Bild klein und mittig haben will, soll das koennen. Was
 * dann rundherum frei bleibt, wird schwarz.
 */
const CROP_MIN_FAKTOR = 0.4;
const CROP_MAX_FAKTOR = 4;
/** Feinheit des Reglers. */
const CROP_STUFEN = 1000;

/** Laesst eine Bilddatei auswaehlen. */
function pickImageFile() {
  return new Promise((resolve) => {
    const feld = el('file-avatar');
    if (!feld) return resolve(null);
    let fertig = false;
    const antwort = (datei) => {
      if (fertig) return;
      fertig = true;
      feld.value = '';
      resolve(datei);
    };
    feld.onchange = () => antwort(feld.files?.[0] ?? null);
    // Bricht jemand den Dateidialog ab, kommt gar kein Ereignis. Damit das
    // Versprechen nicht ewig offen bleibt, macht der naechste Blick auf die
    // Seite Schluss.
    window.addEventListener('focus', () => setTimeout(() => antwort(feld.files?.[0] ?? null), 800), { once: true });
    feld.click();
  });
}

/**
 * Zeigt das Bild in einem quadratischen Fenster: schieben, zoomen, fertig.
 *
 * Das Fenster ist genau der Ausschnitt, der spaeter das Profilbild wird -
 * einschliesslich der Stellen, an denen kein Bild mehr ist. Der Kreis
 * darueber zeigt, was davon rund angezeigt wird; er ist dem Quadrat
 * einbeschrieben, denn genau so schneidet die runde Anzeige spaeter zu.
 *
 * @returns {Promise<{bytes: Uint8Array, mime: string}|null>}
 */
function cropSheet(vorlage) {
  return new Promise((fertig) => {
    let entschieden = false;
    const antwort = (wert) => {
      if (entschieden) return;
      entschieden = true;
      fertig(wert);
    };

    const fenster = make('div', 'crop');
    const bild = make('img', 'crop__img');
    bild.alt = '';
    bild.draggable = false;
    fenster.appendChild(bild);
    fenster.appendChild(make('div', 'crop__mask'));

    const regler = make('input', 'crop__zoom');
    regler.type = 'range';
    regler.min = '0';
    regler.max = String(CROP_STUFEN);
    regler.value = String(CROP_STUFEN);
    regler.setAttribute('aria-label', t('cropZoom'));

    /** Seitenlaenge des Fensters in Bildschirmpunkten. */
    let kante = 0;
    /** Massstab, bei dem das Bild das Fenster gerade ausfuellt. */
    let deckung = 1;
    /** Massstab, bei dem das Bild vollstaendig hineinpasst. */
    let passend = 1;
    let massstab = 1;
    let tx = 0;
    let ty = 0;

    const kleinster = () => passend * CROP_MIN_FAKTOR;
    const groesster = () => deckung * CROP_MAX_FAKTOR;

    /** Reglerstellung -> Massstab, logarithmisch: so fuehlt sich Zoom richtig an. */
    const ausRegler = (wert) => {
      const klein = kleinster();
      const gross = groesster();
      return klein * ((gross / klein) ** (wert / CROP_STUFEN));
    };
    const zuRegler = (wert) => {
      const klein = kleinster();
      const gross = groesster();
      return Math.round((Math.log(wert / klein) / Math.log(gross / klein)) * CROP_STUFEN);
    };

    const zeichnen = () => {
      const breite = vorlage.width * massstab;
      const hoehe = vorlage.height * massstab;
      // Ist das Bild groesser als das Fenster, darf keine Luecke entstehen.
      // Ist es kleiner, bleibt es innerhalb des Fensters - rundherum
      // schwarz, aber nie ganz weggeschoben.
      const grenze = (versatz, mass) => (mass >= kante
        ? Math.min(0, Math.max(kante - mass, versatz))
        : Math.max(0, Math.min(kante - mass, versatz)));
      tx = grenze(tx, breite);
      ty = grenze(ty, hoehe);
      bild.style.width = `${breite}px`;
      bild.style.height = `${hoehe}px`;
      bild.style.transform = `translate(${tx}px, ${ty}px)`;
    };

    const vermessen = () => {
      // Die KLEINERE der beiden Seiten, nicht die Breite.
      //
      // Hier stand `fenster.clientWidth`, und die ganze Rechnung setzt ein
      // Quadrat voraus. Auf niedrigen Fenstern war es keins mehr: gemessen
      // 280x78 bei 320x480. Der Ausschnitt wurde trotzdem mit 280 gerechnet,
      // und im gespeicherten Bild stand danach Material, das nie auf dem
      // Bildschirm zu sehen war - bei 320x480 waren nur 28 % des Ergebnisses
      // je sichtbar. Wer ein Quadrat voraussetzt, misst es besser nach.
      const neuKante = Math.min(fenster.clientWidth || 240, fenster.clientHeight || 240);
      if (neuKante === kante) return;
      kante = neuKante;
      deckung = kante / Math.min(vorlage.width, vorlage.height);
      passend = kante / Math.max(vorlage.width, vorlage.height);
      massstab = deckung;
      regler.value = String(zuRegler(massstab));
      // Mittig anfangen - das ist bei einem Portraet fast immer richtig.
      tx = (kante - vorlage.width * massstab) / 2;
      ty = (kante - vorlage.height * massstab) / 2;
      zeichnen();
    };

    regler.addEventListener('input', () => {
      const vorher = massstab;
      const mitteX = (kante / 2 - tx) / vorher;
      const mitteY = (kante / 2 - ty) / vorher;
      massstab = ausRegler(Number(regler.value));
      // Beim Zoomen bleibt die Mitte die Mitte - sonst springt das Bild weg.
      tx = kante / 2 - mitteX * massstab;
      ty = kante / 2 - mitteY * massstab;
      zeichnen();
    });

    let zieht = null;
    fenster.addEventListener('pointerdown', (event) => {
      zieht = { id: event.pointerId, x: event.clientX - tx, y: event.clientY - ty };
      fenster.setPointerCapture(event.pointerId);
    });
    fenster.addEventListener('pointermove', (event) => {
      if (!zieht || zieht.id !== event.pointerId) return;
      tx = event.clientX - zieht.x;
      ty = event.clientY - zieht.y;
      zeichnen();
    });
    const loslassen = (event) => {
      if (zieht?.id !== event.pointerId) return;
      zieht = null;
    };
    fenster.addEventListener('pointerup', loslassen);
    fenster.addEventListener('pointercancel', loslassen);

    const uebernehmen = make('button', 'btn btn--primary btn--lg');
    uebernehmen.type = 'button';
    uebernehmen.id = 'crop-apply';
    uebernehmen.textContent = t('cropApply');
    uebernehmen.addEventListener('click', () => {
      antwort({
        tx,
        ty,
        breite: vorlage.width * massstab,
        hoehe: vorlage.height * massstab,
        kante,
      });
      closeSheet();
    });

    const zeile = make('div', 'sheet-field');
    zeile.appendChild(uebernehmen);

    openSheet(t('cropTitle'), [
      make('p', 'sheet-note', t('cropHint')),
      fenster,
      regler,
      zeile,
      { icon: 'i-close', label: t('cancel'), keepOpen: true, onClick: () => { antwort(null); closeSheet(); } },
    ], { onClose: () => antwort(null), autofocus: false });

    // Das Bild erst anhaengen, wenn das Blatt steht - vorher hat das Fenster
    // noch keine Breite, und dann waere die Deckung falsch gerechnet.
    bild.src = vorlage.url;
    requestAnimationFrame(() => {
      vermessen();
      requestAnimationFrame(vermessen);
    });
  }).then(async (lage) => {
    if (!lage) return null;
    return finishAvatar(vorlage.handle, lage);
  });
}

/** Datei waehlen, zuschneiden, fertiges Bild zurueck. */
async function askForAvatar() {
  const datei = await pickImageFile();
  if (!datei) return null;
  let handle = null;
  let url = null;
  try {
    handle = await openForCrop(datei);
    url = URL.createObjectURL(datei);
    return await cropSheet({ handle, url, width: handle.width, height: handle.height });
  } catch {
    // Eine Datei, die kein Bild ist (oder eines, das dieser Browser nicht
    // kennt): das ist ein Missgriff, kein Fehler der App. Ein Hinweis am
    // Rand reicht - die Vollbild-Fehlerseite waere hier voellig verkehrt,
    // sie spraeche noch dazu vom Server, mit dem gar nicht geredet wurde.
    toast(t('avatarUnreadable'));
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
    if (handle) closeSource(handle);
  }
}

/**
 * Das eigene Bild.
 *
 * Es wohnt in den Einstellungen und gilt fuer alle Chats. In jeden Raum geht
 * es trotzdem einzeln - verschluesselt mit dem Schluessel genau dieses
 * Raums, damit es niemand ausserhalb aufmachen kann.
 */
async function chooseMyAvatar() {
  const bild = await askForAvatar();
  if (!bild) return;
  const daten = `data:${bild.mime};base64,${toBase64(bild.bytes)}`;
  app.prefs = setPrefs({ avatar: daten, avatarSig: randomId(6) });
  if (app.session?.token && app.key) {
    busy(true, t('avatarSaving'));
    await publishMyAvatar({ force: true });
    busy(false);
  }
  toast(meinBildVerborgen() ? t('avatarHiddenHereStill') : t('avatarSaved'));
  refreshAvatarChip();
}

/**
 * Das eigene Bild wieder wegnehmen - und zwar ueberall.
 *
 * Es hier zu vergessen und in zwanzig Raeumen liegen zu lassen waere das
 * Gegenteil von dem, was man beim Antippen erwartet.
 */
async function removeMyAvatar() {
  app.prefs = setPrefs({ avatar: null, avatarSig: null });
  refreshAvatarChip();
  const raeume = listSessions().filter((session) => session.token && session.memberId);
  if (raeume.length > 0) {
    busy(true, t('avatarSaving'));
    await Promise.all(raeume.map(async (session) => {
      try {
        await deleteAvatar(session.roomId, session.token, session.memberId);
      } catch {
        // Ein Raum, der gerade nicht erreichbar ist, bekommt es beim
        // naechsten Betreten mit: dort steht dann kein Bild mehr an.
      }
      merkeSession(session.roomId, { avatarSig: null });
    }));
    busy(false);
  }
  toast(t('avatarRemoved'));
}

/**
 * Das eigene Bild in diesem Chat verbergen - oder wieder zeigen.
 *
 * Verbergen heisst hier nicht "bitte nicht anzeigen", sondern: das Bild
 * liegt in diesem Raum nicht. Es wird weggenommen, und in allen anderen
 * Chats gilt es unveraendert weiter.
 *
 * In einer Gruppe geht das nur fuer alle auf einmal. Es gibt dort einen
 * Schluessel fuer den ganzen Raum und kein Geheimnis zwischen zwei einzelnen
 * Mitgliedern - ein Bild, das die eine sieht und die andere nicht, liesse
 * sich gar nicht ablegen. Die Beschriftung sagt das auch so.
 */
async function toggleMyAvatarHere() {
  if (!app.session) return;
  const verbergen = !meinBildVerborgen();
  // Genau dieser Chat, kein anderer: das Bild wohnt in den Einstellungen und
  // geht in jeden Raum einzeln - eine Sperre, die ueber alle Chats laeuft,
  // naehme es ueberall weg.
  const patch = { hideMyAvatar: verbergen };
  app.session = merkeSession(app.session.roomId, patch) ?? { ...app.session, ...patch };
  busy(true, t('avatarSaving'));
  let geschafft = true;
  try {
    const ziel = jetzigerRaum();
    if (verbergen) geschafft = await nacheinander(() => bildWegnehmen(ziel));
    else geschafft = await publishMyAvatar({ force: true });
  } finally {
    busy(false);
  }
  // Ohne Verbindung ist die Sperre umgelegt, das Bild aber noch nicht weg -
  // oder eben noch nicht wieder da. Das muss man erfahren: bei einer Zusage
  // ueber Sichtbarkeit ist die stille Erfolgsmeldung der eine Fehler, der
  // nicht passieren darf. Nachgeholt wird es beim naechsten Betreten, dafuer
  // sorgt bildHochladen().
  if (!app.prefs?.avatar) toast(t('saved'));
  else if (verbergen) toast(geschafft ? t('avatarHiddenMineOn') : t('avatarHideLater'));
  else toast(geschafft ? t('avatarHiddenMineOff') : t('avatarShowLater'));
}

/**
 * Das Bild von jemand anderem ausblenden - oder wieder zeigen.
 *
 * Bleibt auf diesem Geraet. Die andere Person erfaehrt nichts davon, und ihr
 * Bild liegt weiter im Raum: das hier ist eine Entscheidung darueber, was
 * man selbst sehen will.
 */
function toggleHiddenAvatar(owner) {
  if (!app.session || !owner) return;
  const bisher = app.session.hiddenAvatars ?? [];
  const verbergen = !bisher.includes(owner);
  const liste = verbergen ? [...bisher, owner] : bisher.filter((eintrag) => eintrag !== owner);
  const patch = { hiddenAvatars: liste };
  app.session = merkeSession(app.session.roomId, patch) ?? { ...app.session, ...patch };
  if (verbergen) {
    // Nicht nur nicht zeigen: die entschluesselte Kopie kommt weg. Sie wieder
    // zu holen kostet eine Anfrage, und die faellt nur an, wenn man es
    // wirklich wieder sehen will.
    vergissBild(owner);
    nachAusblenden();
  } else {
    const ver = owner === 'group' ? app.groupAvatarVer : memberOf(owner).avatarVer;
    const raum = app.session.roomId;
    void ensureAvatar(owner, ver).then(() => {
      if (app.session?.roomId === raum) nachAusblenden();
    });
  }
  toast(verbergen ? t('avatarHiddenTheirsOn') : t('avatarHiddenTheirsOff'));
}

/** Nach dem Aus- oder Einblenden: ueberall nachziehen, wo ein Bild steht. */
function nachAusblenden() {
  // Das Bildchen auf der Startseite haengt am selben Zustand - es geht mit
  // weg und kommt mit wieder.
  rememberChatAvatar();
  updatePeerStatus();
  redrawAll();
  renderChatList();
  // Das grosse Gesicht im Anruf wird sonst nur beim Aufbau gesetzt und
  // bliebe mitten im Gespraech stehen.
  if (app.call) fillAvatar(el('call-avatar'), chatAvatarOwner(), peerName());
}

/** Der Knopf in der Fusszeile zeigt, ob schon ein Bild hinterlegt ist. */
function refreshAvatarChip() {
  const knopf = el('btn-avatar');
  if (!knopf) return;
  const feld = knopf.querySelector('.avatar');
  if (!feld) return;
  feld.replaceChildren();
  if (app.prefs?.avatar) {
    const bild = make('img', 'avatar__img');
    bild.src = app.prefs.avatar;
    bild.alt = '';
    feld.appendChild(bild);
    feld.classList.add('has-image');
  } else {
    feld.classList.remove('has-image');
    feld.textContent = initial(app.prefs?.nick || '');
  }
}

// ===========================================================================
// Profile
// ===========================================================================

/** So lang darf die Kurzbeschreibung werden. */
const BIO_MAX = 160;

/**
 * Der Kopf eines Profils: Bild in gross, Name, Kurzbeschreibung.
 *
 * Das Bild laesst sich antippen und geht dann ganz auf - wer wissen will,
 * wen er vor sich hat, soll nicht auf einen Daumennagel angewiesen sein.
 */
function profileHead({ owner, name, bio, url }) {
  const block = make('div', 'profile');
  const bildUrl = url ?? (owner ? avatarUrl(owner) : null);

  if (bildUrl) {
    const knopf = make('button', 'profile__avatar');
    knopf.type = 'button';
    knopf.setAttribute('aria-label', t('profilePicture'));
    const bild = make('img', 'avatar__img');
    bild.src = bildUrl;
    bild.alt = '';
    knopf.appendChild(bild);
    knopf.addEventListener('click', () => openLightbox(bildUrl, name, 'profil.jpg'));
    block.appendChild(knopf);
  } else {
    const platzhalter = make('div', 'profile__avatar is-empty', initial(name));
    block.appendChild(platzhalter);
  }

  block.appendChild(make('strong', 'profile__name', name));
  const text = (bio ?? '').trim();
  block.appendChild(make('p', text ? 'profile__bio' : 'profile__bio is-empty', text || t('bioEmpty')));
  return block;
}

/**
 * Das eigene Profil.
 *
 * Alles, was andere von einem sehen, an einer Stelle - und daneben die
 * Knoepfe, um genau das zu aendern.
 */
function openMyProfile() {
  const name = app.prefs?.nick || app.session?.nick || '';
  openSheet(t('myProfile'), [
    profileHead({
      owner: null,
      url: app.prefs?.avatar ?? null,
      name: name || t('you'),
      bio: app.prefs?.bio ?? '',
    }),
    make('p', 'sheet-note', t('myProfileHint')),
    // Sonst wirkt der Schalter kaputt: hier steht das eigene Bild ja weiter
    // gross da. Und der naechste Griff waere "Bild entfernen" - was es in
    // ALLEN Chats wegnaehme.
    ...(meinBildVerborgen() && app.prefs?.avatar
      ? [
        make('p', 'sheet-note sheet-note--warn', t('avatarHiddenHere')),
        { icon: 'i-eye', label: t('avatarShowHereAgain'), onClick: () => void toggleMyAvatarHere() },
      ]
      : []),
    {
      icon: 'i-image',
      label: app.prefs?.avatar ? t('avatarChange') : t('avatarChoose'),
      onClick: () => void chooseMyAvatar(),
    },
    ...(app.prefs?.avatar
      ? [{ icon: 'i-trash', label: t('avatarRemove'), danger: true, onClick: () => void removeMyAvatar() }]
      : []),
    { icon: 'i-user', label: t('yourName'), value: name || '–', onClick: () => void changeNick() },
    { icon: 'i-edit', label: t('bio'), hint: t('bioHint'), onClick: () => void changeBio() },
  ]);
}

/** Das Profil von jemand anderem. */
function openMemberProfile(member) {
  if (!member) return;
  const darfVergeben = isGroup() && app.myRole === 'admin' && member.left !== true;
  const istAdmin = member.role === 'admin';
  openSheet(t('profile'), [
    profileHead({ owner: member.id, name: memberName(member), bio: member.bio }),
    ...(isGroup()
      ? [make('p', 'sheet-note', istAdmin ? t('roleAdminNote') : t('roleMemberNote'))]
      : []),
    ...bildAusblendenEintrag(member.id, Boolean(member.avatarVer)),
    ...(darfVergeben ? [{
      icon: 'i-shield',
      label: istAdmin ? t('roleTake') : t('roleGive'),
      hint: istAdmin ? t('roleTakeHint') : t('roleGiveHint'),
      onClick: () => setMemberRole(member.id, istAdmin ? 'member' : 'admin'),
    }] : []),
  ]);
}

/**
 * Das Profil des Chats, den man gerade offen hat.
 *
 * Im Zweiergespraech ist das die andere Person, in einer Gruppe die Gruppe
 * selbst - mit dem Weg zu jedem einzelnen Mitglied.
 */
function openChatProfile() {
  if (!app.session) return;
  if (!isGroup()) {
    const gegenueber = peerOf();
    if (!gegenueber) {
      toast(t('neverSeen'));
      return;
    }
    openMemberProfile(gegenueber);
    return;
  }
  const darf = app.myRole === 'admin';
  openSheet(t('groupProfile'), [
    profileHead({
      owner: 'group',
      name: peerName(),
      bio: t('membersHint', { n: app.session?.capacity ?? others().length + 1 }),
    }),
    ...bildAusblendenEintrag('group', Boolean(app.groupAvatarVer)),
    ...(darf ? [
      { icon: 'i-image', label: t('groupPicture'), hint: t('groupPictureHint'), onClick: () => void chooseGroupAvatar() },
      { icon: 'i-plus', label: t('inviteMore'), onClick: () => void inviteMore() },
    ] : []),
    { icon: 'i-users', label: t('members'), value: String(others().length + 1), onClick: showMembers },
  ]);
}

/**
 * Der Eintrag "Bild ausblenden" - oder keiner.
 *
 * Ohne Bild gibt es nichts auszublenden, und ein Schalter fuer nichts
 * verwirrt mehr, als er nuetzt. Steht die Sperre dagegen schon, muss der
 * Eintrag bleiben: sonst kaeme man nie wieder heran.
 */
function bildAusblendenEintrag(owner, hatBild) {
  const versteckt = bildVersteckt(owner);
  if (!hatBild && !versteckt) return [];
  return [{
    icon: versteckt ? 'i-eye' : 'i-eye-off',
    label: versteckt ? t('avatarShowTheirs') : t('avatarHideTheirs'),
    hint: owner === 'group' ? t('avatarHideGroupHint') : t('avatarHideTheirsHint'),
    onClick: () => toggleHiddenAvatar(owner),
  }];
}

/** Ein paar Zeilen ueber sich - gehen in jeden Chat mit. */
async function changeBio() {
  const next = await promptSheet(t('bio'), {
    value: app.prefs?.bio ?? '',
    placeholder: t('bioPlaceholder'),
    note: t('bioHint'),
    maxLength: BIO_MAX,
  });
  if (next == null) return;
  app.prefs = setPrefs({ bio: next });
  // In den offenen Chat sofort, in alle anderen beim naechsten Betreten.
  sendNick(app.session?.nick ?? app.prefs.nick ?? '', next);
  toast(t('saved'));
}

/** Das Bild der Gruppe - nur Verwalter duerfen es aendern. */
async function chooseGroupAvatar() {
  if (!isGroup() || app.myRole !== 'admin') return;
  // Wer das Gruppenbild setzt, will es sehen. Sonst hiesse es "Bild
  // gespeichert" und auf dem Bildschirm aendert sich nichts.
  if (bildVersteckt('group')) toggleHiddenAvatar('group');
  const bild = await askForAvatar();
  if (!bild) return;
  busy(true, t('avatarSaving'));
  try {
    const sealed = await encryptBytes(app.key, bild.bytes);
    await putAvatar(app.session.roomId, app.session.token, 'group', sealed);
    toast(t('avatarSaved'));
  } catch (error) {
    reportError(error);
  } finally {
    busy(false);
  }
}

// ===========================================================================
// Mitglieder und Rechte
// ===========================================================================

/**
 * Wer ist in dieser Gruppe - und wer darf was?
 *
 * Verwalter koennen Rechte weitergeben und wieder einsammeln. Wer keine hat,
 * sieht dieselbe Liste, nur ohne Knoepfe: dass man nichts darf, gehoert zu
 * den Dingen, die man wissen sollte, bevor man es vergeblich versucht.
 */
function showMembers() {
  const ich = {
    icon: 'i-user',
    label: `${app.session?.nick || t('yourName')} (${t('memberYou')})`,
    value: app.myRole === 'admin' ? t('roleAdmin') : t('roleMember'),
    onClick: openMyProfile,
  };
  const andere = others().map((member) => {
    const istAdmin = member.role === 'admin';
    return {
      icon: istAdmin ? 'i-shield' : 'i-user',
      label: memberName(member),
      hint: t('openProfileHint'),
      value: istAdmin ? t('roleAdmin') : t('roleMember'),
      // Antippen fuehrt zum Profil - dort steht auch, was man mit dieser
      // Person tun darf. Rechte aus Versehen zu vergeben, weil man nur
      // nachsehen wollte, waere ein schlechter Tausch.
      onClick: () => openMemberProfile(member),
    };
  });
  openSheet(t('members'), [
    make('p', 'sheet-note', t('membersHint', { n: (app.session?.capacity ?? others().length + 1) })),
    ich,
    ...andere,
  ]);
}

function setMemberRole(id, role) {
  if (!app.conn) return;
  app.conn.send({ t: 'role', to: id, role });
  // Die Antwort kommt als Frame zurueck und traegt die Liste nach.
  memberOf(id).role = role;
  toast(role === 'admin' ? t('roleGiven') : t('roleTaken'));
}

/**
 * Nachtraeglich weitere Leute einladen.
 *
 * Dieselbe Rechnung wie beim Anlegen: je Person ein Code, daraus ein Platz,
 * und darauf der Gruppenschluessel - verpackt fuer genau diesen einen Code.
 * Der Server bekommt nur die Pakete.
 */
async function inviteMore() {
  if (!isGroup() || app.myRole !== 'admin') return;
  const frei = Math.max(0, (app.features.maxGroup ?? 8) - (app.session?.capacity ?? 0));
  if (frei <= 0) {
    toast(t('inviteMoreFull'));
    return;
  }
  const antwort = await promptSheet(t('inviteMore'), {
    value: '1',
    note: t('inviteMoreHint', { n: frei }),
    maxLength: 2,
    confirmLabel: t('create'),
  });
  if (!antwort) return;
  const wieViele = Math.max(1, Math.min(frei, Number.parseInt(String(antwort), 10) || 0));

  busy(true, t('joining'));
  try {
    const key = fromBase64(app.session.key);
    const codes = [];
    const slots = [];
    for (let i = 0; i < wieViele; i += 1) {
      const code = generateCode();
      const { slotId, wrapKeyRaw } = await deriveSlot(code);
      slots.push({
        id: slotId,
        wrapped: await wrapGroupKey(wrapKeyRaw, {
          key, roomId: app.session.roomId, name: app.session.label ?? '',
        }),
      });
      codes.push(formatCode(code));
    }
    const antwortServer = await addSlots(app.session.roomId, app.session.token, slots);
    const alle = [...(app.session.codes ?? []), ...codes];
    const patch = { codes: alle, capacity: antwortServer?.capacity ?? app.session.capacity };
    app.session = merkeSession(app.session.roomId, patch) ?? { ...app.session, ...patch };
    busy(false);
    showGroupCodes(app.session);
    toast(t('inviteMoreDone', { n: wieViele }));
  } catch (error) {
    busy(false);
    reportError(error);
  } finally {
    busy(false);
  }
}

// ===========================================================================
// Alles löschen
// ===========================================================================

/** So lange muss der letzte Knopf unberührbar bleiben. */
const WIPE_DELAY_MS = 15_000;

/**
 * Alles löschen - in drei Schritten, weil es drei verschiedene Dinge sind,
 * die man verstanden haben sollte.
 *
 * Der erste Schritt sagt, was von diesem Gerät verschwindet. Der zweite, was
 * es für die anderen bedeutet - das ist der Teil, den man leicht übersieht:
 * die Unterhaltungen werden auch bei ihnen vernichtet, ohne dass sie gefragt
 * werden. Der dritte sagt, dass es kein Zurück gibt, nennt die Zahlen und
 * lässt den Knopf erst nach einer Weile zu.
 *
 * Dreimal dasselbe zu sagen waere Theater. Dreimal etwas anderes zu sagen
 * ist eine Aufklärung.
 */
async function wipeFlow() {
  const sessions = listSessions();
  // Immer dieselben drei Schritte, auch wenn gerade kein Chat da ist. Ein
  // kuerzerer Weg fuer den einen Fall waere ein zweiter Weg - und der wird
  // seltener benutzt und damit seltener bemerkt, wenn er kaputt ist.
  if (!await wipeStep(t('wipeStep1Title'), t('wipeStep1Text'), t('continue'))) return;

  // Der zweite Schritt handelt von den anderen. Und der faellt fuer Gruppen
  // anders aus als fuer Zweiergespraeche: ein Zweiergespraech wird
  // vernichtet, eine Gruppe nur verlassen. Wer beides hat, soll beides
  // lesen - sonst erfaehrt er die Haelfte nicht.
  const gruppenZahl = sessions.filter((session) => session.kind === 'group').length;
  const einzelZahl = sessions.length - gruppenZahl;
  let zweiter = t('wipeNothingRemote');
  if (einzelZahl > 0 && gruppenZahl > 0) zweiter = `${t('wipeStep2Text')}\n\n${t('wipeStep2Group')}`;
  else if (einzelZahl > 0) zweiter = t('wipeStep2Text');
  else if (gruppenZahl > 0) zweiter = t('wipeStep2Group');
  if (!await wipeStep(t('wipeStep2Title'), zweiter, t('continue'))) return;

  const gruppen = gruppenZahl;
  let zahlen = t('wipeScopeNone');
  if (gruppen > 0) zahlen = t('wipeScopeGroups', { chats: sessions.length, groups: gruppen });
  else if (sessions.length === 1) zahlen = t('wipeScopeOne');
  else if (sessions.length > 1) zahlen = t('wipeScope', { chats: sessions.length });
  if (!await wipeConfirmDelayed(zahlen)) return;

  await runWipe(sessions);
}

/**
 * Führt es aus.
 *
 * Reihenfolge ist hier keine Geschmacksfrage: erst auf dem Server vernichten,
 * dann hier löschen. Andersherum wären die Token weg, mit denen man die Räume
 * überhaupt vernichten kann - die Unterhaltungen blieben dann bei allen
 * anderen stehen, und man käme selbst nie wieder an sie heran, um das
 * nachzuholen.
 *
 * Deshalb wird auch nicht lokal gelöscht, solange ein Raum nicht wegging.
 * Stattdessen wird gefragt: nochmal versuchen, oder wirklich nur hier löschen
 * und die Chats bei den anderen stehen lassen.
 */
async function runWipe(sessions) {
  busy(true, t('wipeWorking'));
  // Erst die eigene Leitung kappen. Der Server meldet das Vernichten an alle,
  // die im Raum sind - und das sind wir selbst auch. Ohne diesen Schritt
  // fiele uns mitten im Löschen unsere eigene Meldung "Chat gelöscht" in den
  // Ablauf, samt Sprung auf die Startseite.
  stopOverview();
  teardownChat();

  const offen = [];
  await Promise.all(sessions.map(async (session) => {
    if (!session.token) {
      // Nie betreten, also gibt es dort auch nichts zu vernichten - der Raum
      // verfällt von allein.
      return;
    }
    try {
      // Eine Gruppe gehoert nicht einem allein: sie wird verlassen, nicht
      // vernichtet. Die eigenen Nachrichten verschwinden trotzdem - an ihrer
      // Stelle steht bei den anderen, dass hier jemand gegangen ist. Ein
      // Zweiergespraech dagegen ist mit dem Gegenueber zu Ende.
      if (session.kind === 'group') await leaveRoom(session.roomId, session.token);
      else await burnRoom(session.roomId, session.token);
    } catch (error) {
      // Schon weg ist auch weg. Und wer schon draussen ist, kommt nicht
      // noch einmal heraus: nach dem Verlassen oeffnet das Token nichts
      // mehr, der Server antwortet 401.
      const erledigt = error instanceof ApiError
        && (error.status === 404 || error.status === 410 || error.status === 401);
      if (!erledigt) {
        offen.push(session);
        return;
      }
    }
    // Erledigt heisst erledigt: sofort aus der Liste. Bricht jemand gleich
    // danach am Fehlerblatt ab, bleibt sonst eine Gruppe stehen, die er
    // laengst verlassen hat - beim naechsten Antippen gaebe es dafuer eine
    // ratlose Fehlermeldung.
    removeSession(session.roomId);
  }));
  busy(false);
  renderChatList();

  if (offen.length > 0) {
    const weiter = await wipeAfterFailure(offen.length);
    if (weiter === 'retry') return runWipe(offen);
    if (weiter !== 'local') return;
  }

  await wipeLocally();
}

/** Was tun, wenn ein Raum nicht wegging? Ehrlich fragen statt still weitermachen. */
function wipeAfterFailure(anzahl) {
  return new Promise((fertig) => {
    let entschieden = false;
    const antwort = (wert) => {
      if (entschieden) return;
      entschieden = true;
      fertig(wert);
    };
    openSheet(t('wipeFailedTitle'), [
      make('p', 'sheet-note', t('wipeFailedText', { n: anzahl })),
      { icon: 'i-flip', label: t('wipeRetry'), keepOpen: true, onClick: () => { antwort('retry'); closeSheet(); } },
      { icon: 'i-trash', label: t('wipeLocalOnly'), danger: true, keepOpen: true, onClick: () => { antwort('local'); closeSheet(); } },
      { icon: 'i-close', label: t('cancel'), keepOpen: true, onClick: () => { antwort('abort'); closeSheet(); } },
    ], { onClose: () => antwort('abort') });
  });
}

/**
 * Und jetzt dieses Gerät: Chats, Einstellungen, Zwischenspeicher, der Service
 * Worker. Danach wird frisch vom Server geladen - was noch im Arbeitsspeicher
 * stünde, ist damit auch weg.
 */
async function wipeLocally() {
  busy(true, t('wipeWorking'));
  wipeStorage();
  await dropCachesAndWorkers();
  reloadFromServer();
}

/**
 * So lange nimmt ein frisch aufgeschlagener Hinweis kein "Weiter" an.
 *
 * Die drei Blätter sind gleich aufgebaut, der Weiter-Knopf sitzt also jedes
 * Mal an derselben Stelle. Ohne diese Sperre reicht ein Doppeltipp, um einen
 * ganzen Hinweis zu überspringen - und drei Hinweise, die man mit zwei
 * Tippern durchklickt, sind keine drei Hinweise.
 */
const WIPE_SETTLE_MS = 600;

/** Ein Hinweis mit Weiter und Abbrechen. Gibt zurueck, ob weitergegangen wird. */
function wipeStep(titel, text, weiter) {
  return new Promise((fertig) => {
    let entschieden = false;
    const offenSeit = Date.now();
    const antwort = (wert) => {
      if (entschieden) return;
      entschieden = true;
      fertig(wert);
    };
    const weiterGehen = () => {
      // Zu schnell: das war noch der Tipp vom vorigen Blatt.
      if (Date.now() - offenSeit < WIPE_SETTLE_MS) return;
      antwort(true);
      closeSheet();
    };
    openSheet(titel, [
      make('p', 'sheet-note', text),
      { icon: 'i-warning', label: weiter, danger: true, keepOpen: true, onClick: weiterGehen },
      { icon: 'i-close', label: t('cancel'), keepOpen: true, onClick: () => { antwort(false); closeSheet(); } },
    ], { onClose: () => antwort(false), autofocus: false });
  });
}

/**
 * Der letzte Schritt. Der Knopf zaehlt herunter, bevor er sich druecken
 * laesst - fuenfzehn Sekunden sind lang genug, um den Text darueber wirklich
 * gelesen zu haben, und kurz genug, um niemanden zu aergern, der es ernst
 * meint.
 */
function wipeConfirmDelayed(zahlen) {
  return new Promise((fertig) => {
    let entschieden = false;
    let ticker = null;
    const antwort = (wert) => {
      if (entschieden) return;
      entschieden = true;
      clearInterval(ticker);
      fertig(wert);
    };

    const knopf = make('button', 'btn btn--danger btn--lg');
    knopf.type = 'button';
    knopf.disabled = true;
    let rest = Math.round(WIPE_DELAY_MS / 1000);
    knopf.textContent = t('wipeCountdown', { n: rest });
    knopf.addEventListener('click', () => {
      if (knopf.disabled) return;
      antwort(true);
      closeSheet();
    });
    ticker = setInterval(() => {
      rest -= 1;
      if (rest > 0) {
        knopf.textContent = t('wipeCountdown', { n: rest });
        return;
      }
      clearInterval(ticker);
      ticker = null;
      knopf.disabled = false;
      knopf.textContent = t('wipeFinal');
    }, 1000);

    const zeile = make('div', 'sheet-field');
    zeile.appendChild(knopf);

    openSheet(t('wipeStep3Title'), [
      make('p', 'sheet-note', t('wipeStep3Text')),
      make('p', 'sheet-note sheet-note--strong', zahlen),
      zeile,
      { icon: 'i-close', label: t('cancel'), keepOpen: true, onClick: () => { antwort(false); closeSheet(); } },
    ], { onClose: () => antwort(false), autofocus: false });
  });
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
  const farbe = effectiveDark ? '#20221d' : '#f4f7f2';
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

/**
 * Was auf diesem Geraet ueberhaupt geht.
 *
 * Frueher stand hinter jedem Fehlschlag derselbe Satz: "Im Browser
 * blockiert". Auf dem Telefon ist das fast nie die Wahrheit und nie ein
 * Hinweis, der weiterhilft - deshalb vier Zustaende statt einem:
 *
 *   'geht'         Die Erlaubnis liegt vor.
 *   'fragen'       Man darf fragen.
 *   'verweigert'   Abgelehnt. Da kommt nur der Nutzer wieder raus.
 *   'homebildschirm'  iPhone im Safari-Reiter: die Schnittstelle gibt es
 *                  dort gar nicht, erst in der App vom Home-Bildschirm.
 *   'unmoeglich'   Dieser Browser kann es nicht.
 */
function meldungsLage() {
  if (typeof Notification === 'undefined') {
    return aufApfelGeraet() && !alsAppInstalliert() ? 'homebildschirm' : 'unmoeglich';
  }
  if (Notification.permission === 'granted') return 'geht';
  if (Notification.permission === 'denied') return 'verweigert';
  return 'fragen';
}

/**
 * Beim Start: die Voreinstellung mit der echten Erlaubnis abgleichen.
 *
 * Wer sie im Browser wieder entzieht, sagt es der App nicht. Ohne diesen
 * Abgleich stuende im Menue weiter "An", waehrend nie wieder etwas kommt -
 * und der erste Tipp darauf haette ausgeschaltet, was ohnehin aus war.
 *
 * Geschrieben wird nur, wenn wirklich etwas nicht stimmt: auf einem frisch
 * geleerten Geraet darf beim Start kein Eintrag entstehen.
 */
function meldungenAbgleichen() {
  if (app.prefs?.notifications !== true) return;
  if (meldungsLage() === 'geht') return;
  app.prefs = setPrefs({ notifications: false });
}

/** Der Wert, der im Menue neben "Benachrichtigungen" steht. */
function meldungsBeschriftung() {
  switch (meldungsLage()) {
    case 'homebildschirm': return t('notificationsNeedsApp');
    case 'unmoeglich': return t('notificationsUnsupported');
    case 'verweigert': return t('notificationsBlocked');
    default: return app.prefs.notifications ? t('switchOn') : t('switchOff');
  }
}

/**
 * Der Weg fuer das iPhone: ein Blatt statt einer Pille.
 *
 * In einen Toast passt der Weg nicht hinein - und er braucht eine Warnung.
 * Eine App vom Home-Bildschirm hat auf iOS ihren eigenen Speicher; die Chats
 * aus dem Safari-Reiter sind dort nicht. Deshalb steht der Knopf zum
 * Verknuepfen gleich daneben.
 */
function zeigeHomeBildschirmBlatt() {
  openSheet(t('notifications'), [
    make('p', 'sheet-note', t('notificationsIosHint')),
    make('p', 'sheet-note', t('notificationsIosChats')),
    { icon: 'i-link', label: t('linkDevice'), onClick: () => void shareDeviceLink() },
  ], { autofocus: false });
}

async function toggleNotifications() {
  const lage = meldungsLage();
  if (lage === 'homebildschirm') {
    zeigeHomeBildschirmBlatt();
    return;
  }
  if (lage === 'unmoeglich') {
    toast(t('notificationsUnsupported'));
    return;
  }
  if (app.prefs.notifications) {
    app.prefs = setPrefs({ notifications: false });
    toast(t('notificationsOff'));
    return;
  }
  if (lage === 'verweigert') {
    // Aus 'denied' kommt kein Code heraus - nur der Nutzer, in den
    // Einstellungen seines Browsers. Also sagen, wo.
    toast(t('notificationsBlockedHint'));
    return;
  }
  // Kein `await` vor dieser Zeile: die Erlaubnis darf nur unmittelbar aus
  // der Tippgeste erfragt werden, sonst lehnt der Browser von sich aus ab.
  // Sehr alte Safari-Fassungen kennen nur die Rueckruf-Form und liefern
  // hier `undefined` - das ist kein "verweigert", sondern "nicht gefragt".
  const antwort = await Notification.requestPermission();
  if (antwort === 'denied') {
    toast(t('notificationsBlockedHint'));
    return;
  }
  if (antwort !== 'granted') {
    toast(t('notificationsDismissed'));
    return;
  }
  app.prefs = setPrefs({ notifications: true });
  toast(t('notificationsOn'));
}

/**
 * Wohin die Meldung geht.
 *
 * Auf Android ist `new Notification(...)` verboten - Chrome wirft dort
 * "Illegal constructor" und verlangt den Weg ueber den Service Worker.
 * Genau deshalb kam auf dem Telefon nie eine Meldung an, obwohl die
 * Erlaubnis erteilt war: der Fehler landete im Fang und blieb still.
 *
 * Der Worker ist also der erste Weg. Den Konstruktor gibt es nur noch als
 * Rueckfall - fuer den Fall, dass gar kein Worker laeuft (kein HTTPS,
 * abgeschaltet, alter Browser).
 */
async function meldungsKanal() {
  if (typeof app.swRegistration?.showNotification === 'function') return app.swRegistration;
  // Kurz nach dem Start steht die Registrierung noch nicht in app - der
  // Browser kennt sie aber schon. Eine Nachricht, die genau in dieses
  // Fenster faellt, soll deshalb nicht am alten Weg scheitern.
  try {
    const registrierung = await navigator.serviceWorker?.getRegistration?.();
    if (typeof registrierung?.showNotification === 'function') return registrierung;
  } catch { /* kein Worker */ }
  return null;
}

/** Kann ueberhaupt eine Meldung herausgehen? Synchron, denn daran haengt der Ton. */
function darfMelden() {
  // Ein versteckter Chat meldet sich nie - auch dann nicht, wenn er gerade
  // aufgeschlossen ist. Wer ihn offen hat, sieht ohnehin hin.
  if (app.session?.versteckId) return false;
  return app.prefs.notifications === true && meldungsLage() === 'geht';
}

/**
 * Zeigt eine Meldung. Liefert, ob sie wirklich herausging.
 *
 * @param {string} titel
 * @param {NotificationOptions} optionen
 */
async function zeigeMeldung(titel, optionen) {
  const kanal = await meldungsKanal();
  try {
    if (kanal) {
      await kanal.showNotification(titel, optionen);
      return true;
    }
    const meldung = new Notification(titel, optionen);
    meldung.onclick = () => { window.focus(); meldung.close(); };
    return true;
  } catch {
    // Benachrichtigungen sind Beiwerk - dann eben nur der eigene Ton.
    return false;
  }
}

/** Schliesst alle Meldungen mit dieser Marke - egal, wer sie gezeigt hat. */
async function schliesseMeldungen(marke) {
  const kanal = await meldungsKanal();
  if (!kanal) return;
  try {
    for (const meldung of await kanal.getNotifications({ tag: marke })) meldung.close();
  } catch { /* schon zu */ }
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
  if (!darfMelden()) return false;
  // Sie geht ueber den Service Worker heraus, also asynchron. Ob das klappt,
  // steht erst hinterher fest - der Aufrufer entscheidet aber jetzt, ob er
  // zusaetzlich einen Ton spielt. Deshalb hier die Zusage, und wenn sie
  // doch nicht eingehalten werden kann, kommt der Ton eben nachtraeglich.
  void zeigeMeldung(senderLabel(entry), {
    body: previewOf(entry).slice(0, 140),
    icon: appUrl('img/icon-192.png'),
    badge: appUrl('img/badge.png'),
    tag: app.session.roomId,
    data: { basis: basePath },
  }).then((ging) => { if (!ging) playSound('notify'); });
  return true;
}

// ===========================================================================
// Startseite: Liste der eigenen Chats
// ===========================================================================

// ===========================================================================
// Suchen und Verstecken
// ===========================================================================

/**
 * Passt ein Chat zum Suchtext?
 *
 * Gesucht wird in dem, was auf dem Geraet steht: eigener Name fuer den Chat,
 * der Name des Gegenuebers, und der Code. Alles ohne Ruecksicht auf Gross-
 * und Kleinschreibung.
 */
function passtZurSuche(session, suchtext) {
  if (!suchtext) return true;
  const nadel = suchtext.toLowerCase();
  const heuhaufen = [chatTitle(session), session.peerNick, session.label, session.code];
  return heuhaufen.some((teil) => (teil || '').toLowerCase().includes(nadel));
}

/**
 * Versteckt einen Chat hinter einer selbst gewaehlten Zeichenfolge.
 *
 * Der ganze Eintrag wandert verschluesselt in einen eigenen Block und
 * verschwindet aus der Liste. Ab da weiss die App selbst nicht mehr, was
 * dahintersteckt: kein Name, kein Code, keine Raum-ID. Sie kann den Raum
 * deshalb auch nicht mehr abfragen - und genau daran haengt, dass von dort
 * keine Benachrichtigung mehr kommt und keine ungelesene Zahl auftaucht.
 */
async function versteckeChat(session) {
  const zeichenfolge = await promptSheet(t('hideChat'), {
    value: '',
    placeholder: t('hideChatPlaceholder'),
    note: t('hideChatNote'),
    maxLength: 64,
  });
  if (zeichenfolge == null) return;
  const wort = zeichenfolge.trim();
  if (wort.length < 3) {
    toast(t('hideChatTooShort'));
    return;
  }
  // Eine Zeichenfolge, die auch auf einen sichtbaren Chat passt, waere eine
  // Falle: dann ginge das Versteck bei jeder harmlosen Suche nach diesem
  // Namen mit auf - vor den Augen dessen, der einem ueber die Schulter sieht.
  if (listSessions().some((eintrag) => eintrag.roomId !== session.roomId && passtZurSuche(eintrag, wort))) {
    toast(t('hideChatClashes'));
    return;
  }
  if (!await confirmSheet(t('hideChat'), t('hideChatConfirm', { wort }), t('hideChatDo'), { danger: false })) return;

  busy(true, t('hideChatWorking'));
  try {
    const stand = getSession(session.roomId) ?? session;
    const salz = randomSalt();
    const schluessel = await deriveHideKey(wort, salz);
    const block = { id: randomId(9), salt: toBase64(salz), ct: await encryptJson(schluessel, stand) };
    // Erst wegschliessen, dann aus der Liste nehmen - nie andersherum. Und
    // erst nachsehen, ob das Wegschliessen wirklich geklappt hat: ist der
    // Speicher voll oder gesperrt, schluckt er den Fehler still. Wer sich
    // darauf verliesse, haette den Chat vernichtet und dazu "Versteckt"
    // gemeldet. Deshalb wird der Block danach gelesen und aufgeschlossen -
    // erst wenn das gelingt, verschwindet der Eintrag aus der Liste.
    if (!addHidden(block) || !await blockLesbar(block, wort)) {
      toast(t('hideChatFailed'));
      removeHidden(block.id);
      return;
    }
    removeSession(stand.roomId);
    if (app.session?.roomId === stand.roomId) {
      teardownChat();
      showStart();
    }
    sucheZuruecksetzen();
    renderChatList();
    toast(t('hideChatDone'));
  } catch (fehler) {
    reportError(fehler);
  } finally {
    busy(false);
  }
}

/** Laesst sich der Block, der gerade geschrieben wurde, wirklich wieder oeffnen? */
async function blockLesbar(block, wort) {
  try {
    const gespeichert = listHidden().find((eintrag) => eintrag.id === block.id);
    if (!gespeichert) return false;
    const schluessel = await deriveHideKey(wort, fromBase64(gespeichert.salt));
    const wieder = await decryptJson(schluessel, gespeichert.ct);
    return typeof wieder?.roomId === 'string';
  } catch {
    return false;
  }
}

/**
 * Probiert die eingetippte Zeichenfolge an allen Verstecken.
 *
 * Jeder Block hat sein eigenes Salz, es gibt also keine Abkuerzung: jeder
 * muss einzeln gerechnet werden. Bei einer Handvoll Verstecke ist das eine
 * Sache von Sekundenbruchteilen, und es ist der Preis dafuer, dass nirgends
 * ein Merkmal steht, an dem sich zwei Verstecke vergleichen liessen.
 *
 * @returns {Promise<Array<object>>} die aufgeschlossenen Chats
 */
async function schliesseAuf(wort) {
  const bloecke = listHidden();
  if (!wort || bloecke.length === 0) return [];
  const treffer = [];
  for (const block of bloecke) {
    try {
      const schluessel = await deriveHideKey(wort, fromBase64(block.salt));
      const session = await decryptJson(schluessel, block.ct);
      if (session && typeof session.roomId === 'string') {
        versteckSchluessel.set(block.id, schluessel);
        treffer.push({ ...session, versteckId: block.id });
      }
    } catch {
      // Falsche Zeichenfolge fuer diesen Block - das ist der Normalfall.
    }
  }
  return treffer;
}

/** Holt einen aufgeschlossenen Chat zurueck in die normale Liste. */
async function zeigeChatWieder(session) {
  if (!session.versteckId) return;
  if (!await confirmSheet(t('unhideChat'), t('unhideChatConfirm'), t('unhideChatDo'), { danger: false })) return;
  // Nicht den Schnappschuss aus der Liste nehmen: seit dem Aufschliessen kann
  // sich etwas geaendert haben - allen voran das Token, das der Server bei
  // jedem Verbinden erneuert. Gilt der frische Stand.
  const frisch = (app.session?.roomId === session.roomId && app.session.versteckId
    ? app.session
    : app.entdeckt.find((eintrag) => eintrag.roomId === session.roomId)) ?? session;
  const { versteckId, ...rein } = frisch;
  saveSession(rein);
  removeHidden(versteckId);
  versteckSchluessel.delete(versteckId);
  sucheZuruecksetzen();
  renderChatList();
  toast(t('unhideChatDone'));
}

/**
 * Raeumt die Suche ab, sobald man die Liste aus den Augen laesst.
 *
 * Ohne das bliebe nach einem Ausflug in den Chat die Zeichenfolge im Klartext
 * in der Leiste stehen und der aufgeschlossene Chat samt Namen ganz oben in
 * der Liste - eine PWA wird beim Zurueckholen aus dem App-Umschalter nicht
 * neu geladen, das ueberlebt also Bildschirmsperre und Stundenpausen. Wer
 * das Geraet danach in die Hand bekaeme, saehe beides: WELCHER Chat, und
 * mit WELCHER Zeichenfolge er aufgeht.
 *
 * Steht ein Versteck offen, wird es dabei auch zugemacht. Das ist unbequem,
 * wenn man nur kurz die Zwischenablage holt - aber ein offener versteckter
 * Chat auf einem Sperrbildschirm waere genau das, was die Funktion
 * verhindern soll.
 */
function versteckeSchliessen() {
  const warOffen = Boolean(app.session?.versteckId);
  // Erst den Chat abbauen, dann die Schluessel wegwerfen: beim Abbauen wird
  // noch einmal geschrieben, und ohne Schluessel liefe das ins Leere.
  if (warOffen) {
    teardownChat();
    showStart();
  }
  sucheZuruecksetzen({ auchOffene: true });
  renderChatList();
}

/** Leert die Suchleiste und vergisst, was sie aufgeschlossen hatte. */
function sucheZuruecksetzen({ auchOffene = false } = {}) {
  const feld = el('chat-search');
  if (feld) feld.value = '';
  app.suche = '';
  // Die Schluessel gehen mit: was zu ist, soll auch zu bleiben. Nur der
  // Schluessel des gerade offenen Verstecks bleibt - sonst liefe
  // versteckSchreiben() still ins Leere und das Token ginge verloren.
  if (auchOffene || !app.session?.versteckId) versteckSchluessel.clear();
  app.entdeckt = [];
  const leeren = el('chat-search-clear');
  if (leeren) leeren.hidden = true;
}

/**
 * Die Schluessel der gerade aufgeschlossenen Verstecke - nur im Arbeitsspeicher.
 *
 * Gebraucht, um einen versteckten Chat nach einer Aenderung wieder
 * wegzuschliessen. Das Salz bleibt dabei dasselbe; neu ist nur der
 * Initialisierungsvektor, den encryptJson ohnehin je Aufruf frisch wuerfelt.
 */
const versteckSchluessel = new Map();

/** Schreibt einen aufgeschlossenen Chat zurueck in seinen Block. */
async function versteckSchreiben(session) {
  const schluessel = versteckSchluessel.get(session.versteckId);
  const block = listHidden().find((eintrag) => eintrag.id === session.versteckId);
  if (!schluessel || !block) return;
  const { versteckId, ...rein } = session;
  try {
    replaceHidden(versteckId, { ...block, ct: await encryptJson(schluessel, rein) });
  } catch { /* Dann bleibt der alte Stand stehen - besser als gar keiner. */ }
}

/**
 * Wie patchSession - aber ein versteckter Chat wird wieder weggeschlossen,
 * statt still ins Leere zu laufen.
 *
 * Ohne das waere jede Aenderung an einem aufgeschlossenen Chat verloren,
 * sobald man ihn wieder zumacht: ein neuer Name, ein neues Bild - und vor
 * allem das Token, das der Server bei jedem Verbinden erneuert. Mit einem
 * veralteten Token kaeme man nach laengerem Verstecken nicht mehr hinein.
 */
function merkeSession(roomId, patch) {
  const versteckt = app.session?.roomId === roomId && app.session.versteckId
    ? app.session
    : app.entdeckt.find((eintrag) => eintrag.roomId === roomId);
  if (!versteckt) return patchSession(roomId, patch);
  Object.assign(versteckt, patch);
  void versteckSchreiben(versteckt);
  return versteckt;
}

/** Der Zeitgeber, der das Aufschliessen erst nach dem Tippen versucht. */
let sucheTimer = null;

function beiSuche(wert) {
  app.suche = wert.trim();
  const leeren = el('chat-search-clear');
  if (leeren) leeren.hidden = app.suche === '';
  // Was schon aufgeschlossen war, gilt nur fuer genau diese Zeichenfolge.
  if (app.entdeckt.length > 0) app.entdeckt = [];
  renderChatList();

  clearTimeout(sucheTimer);
  if (app.suche.length < 3) return;
  // Erst wenn das Tippen steht: jede Runde kostet eine teure Ableitung je
  // Versteck, und bei jedem Buchstaben zu rechnen waere Verschwendung.
  const gefragt = app.suche;
  sucheTimer = setTimeout(async () => {
    const treffer = await schliesseAuf(gefragt);
    // Inzwischen weitergetippt? Dann gilt das Ergebnis nicht mehr.
    if (gefragt !== app.suche || treffer.length === 0) return;
    app.entdeckt = treffer;
    renderChatList();
  }, 350);
}

function renderChatList() {
  const list = el('chat-list');
  const section = el('chats-section');
  if (!list || !section) return;
  const sichtbar = listSessions().filter((session) => passtZurSuche(session, app.suche));
  // Aufgeschlossene Verstecke stehen oben: wer die Zeichenfolge eingetippt
  // hat, sucht genau sie und nicht die zwanzig Chats darunter.
  const sessions = [...app.entdeckt, ...sichtbar];
  section.hidden = sessions.length === 0 && app.suche === '';
  list.replaceChildren();
  if (sessions.length === 0) {
    list.appendChild(make('li', 'chat-list__leer', t('searchNothing')));
    return;
  }

  for (const session of sessions) {
    const item = make('li');
    const button = make('button', 'chat-list__item');
    button.type = 'button';
    if (session.roomId === app.session?.roomId) {
      button.classList.add('is-active');
      button.setAttribute('aria-current', 'true');
    }
    const name = chatTitle(session);
    const avatar = make('div', 'avatar avatar--sm');
    if (session.listAvatar) {
      const bild = make('img', 'avatar__img');
      bild.src = session.listAvatar;
      bild.alt = '';
      avatar.appendChild(bild);
      avatar.classList.add('has-image');
    } else {
      avatar.textContent = initial(name);
    }
    // Der Kreis ist Schmuck: sein Buchstabe steht schon im Namen daneben und
    // wurde sonst mit vorgelesen ("A Anton").
    avatar.setAttribute('aria-hidden', 'true');
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
    if (session.versteckId) {
      // Nur zu sehen, wenn die Zeichenfolge schon eingetippt wurde - also
      // kein Verraeter, sondern die Antwort auf "ist der jetzt versteckt?".
      const zeichen = icon('i-eye-off');
      zeichen.classList.add('chat-list__versteckt');
      // icon() setzt aria-hidden - hier soll das Zeichen aber gerade GELESEN
      // werden: es ist die einzige Auskunft darueber, dass dieser Chat
      // versteckt ist, und wer nicht hinsieht, bekaeme sie sonst nie.
      zeichen.removeAttribute('aria-hidden');
      zeichen.setAttribute('role', 'img');
      zeichen.setAttribute('aria-label', t('hiddenChat'));
      button.appendChild(zeichen);
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
  const wann = session.lastMessageAt ? relativeTime(session.lastMessageAt, { kurz: true }) : '';
  // Hinweis und Zeit in ZWEI Kaesten, nicht in einen Text.
  //
  // Zusammengefuegt und dann per Auslassungspunkten gekuerzt fiel immer das
  // Hintere weg - also ausgerechnet die Zeit, nach der die Liste sortiert
  // ist und die als Einzige sagt, ob dort vor fuenf Minuten oder vor drei
  // Wochen etwas kam. Gemessen war sie bei einem langen Namen auf 320 und
  // 360 Bildpunkten vollstaendig verschwunden. Jetzt kuerzt die Ellipse nur
  // noch den Hinweis; die Zeit steht fest rechts.
  const zeile = make('span', 'chat-list__meta');
  if (hinweis) zeile.appendChild(make('span', 'chat-list__hinweis', hinweis));
  if (wann) zeile.appendChild(make('span', 'chat-list__zeit', wann));
  return zeile;
}

/** Einen Chat aus der Liste oeffnen - Gruppen haben keinen Code. */
function openFromList(session) {
  // Ein aufgeschlossenes Versteck geht denselben Weg wie eine Gruppe: direkt.
  //
  // Ueber enterChat zu gehen waere fatal - dort steht ein unbedingtes
  // saveSession(), das den Chat unterwegs wieder im Klartext in die normale
  // Liste schriebe. Ein einziger Fingertipp haette das Verstecken damit
  // aufgehoben, ohne Nachfrage und ohne dass es jemand bemerkt.
  const offen = app.entdeckt.find((eintrag) => eintrag.roomId === session.roomId);
  if (offen ?? session.versteckId) {
    const wer = offen ?? session;
    // Die Leiste wird dabei geleert: die Zeichenfolge soll nicht im Klartext
    // stehen bleiben, waehrend man im Chat ist. Der Schluessel des gerade
    // geoeffneten Verstecks bleibt - daran haengt das Zurueckschreiben.
    const feld = el('chat-search');
    if (feld) feld.value = '';
    app.suche = '';
    app.entdeckt = [];
    const leeren = el('chat-search-clear');
    if (leeren) leeren.hidden = true;
    return openSession({ ...wer, unread: 0 }, { screen: 'chat' }).catch(reportError);
  }
  // Die Liste haelt einen Schnappschuss von ihrem letzten Aufbau in der Hand.
  // Was seither gespeichert wurde - eine Bildsperre etwa -, steht nur im
  // Speicher des Geraets. Also von dort lesen, nicht aus dem Klick.
  const stand = getSession(session.roomId) ?? session;
  // Gruppen gehen direkt auf - ohne Code, den man erst ableiten muesste.
  // Aber mit derselben Fehlerbehandlung wie enterChat(): scheitert das
  // Verbinden, sah man vorher gar nichts. Der Klick verpuffte, und in der
  // Konsole stand eine unbehandelte Zusage.
  if (stand.kind === 'group') {
    return openSession({ ...stand, unread: 0 }, { screen: 'chat' }).catch(reportError);
  }
  return enterChat(stand.code, { known: stand });
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
    // Keine Verbindung, kein Drama - beim naechsten Mal wieder. Nur die
    // Tippanzeige darf nicht stehen bleiben: sie ist eine Momentaufnahme,
    // und ohne Auskunft vom Server ist der Moment vorbei. Sonst schrieb dort
    // jemand fuer immer weiter - auch ueber ein Neuladen hinweg, weil der
    // Zustand mit der Sitzung gespeichert wird.
    if (tippenLoeschen()) renderChatList();
  } finally {
    overviewLaeuft = false;
  }
}

/**
 * Nimmt aus allen gespeicherten Chats die Tippanzeige weg.
 * @returns {boolean} ob sich etwas geaendert hat
 */
function tippenLoeschen() {
  const patches = new Map();
  for (const eintrag of listSessions()) {
    if (eintrag.typing === true) patches.set(eintrag.roomId, { typing: false });
  }
  if (patches.size === 0) return false;
  patchSessions(patches);
  return true;
}

function openSessionMenu(session) {
  const verstecken = session.versteckId
    ? { icon: 'i-eye', label: t('unhideChat'), hint: t('unhideChatHint'), onClick: () => void zeigeChatWieder(session) }
    : { icon: 'i-eye-off', label: t('hideChat'), hint: t('hideChatHint'), onClick: () => void versteckeChat(session) };
  openSheet(chatTitle(session), [
    { icon: 'i-edit', label: t('renameChat'), hint: t('renameChatHint'), onClick: () => void renameChat(session.roomId) },
    { icon: 'i-copy', label: t('copyCode'), value: session.code, onClick: async () => {
      toast(await copyText(session.code) ? t('copied') : t('copyFailed'));
    } },
    verstecken,
    { icon: 'i-close', label: t('leaveChat'), danger: true, onClick: () => void leaveSession(session.roomId) },
  ]);
}

/**
 * Gibt einem Chat einen eigenen Namen. Bleibt auf diesem Gerät: der Server
 * bekommt ihn nie zu sehen, und das Gegenüber auch nicht.
 */
async function renameChat(roomId) {
  const session = getSession(roomId)
    ?? (app.session?.roomId === roomId ? app.session : null)
    ?? app.entdeckt.find((eintrag) => eintrag.roomId === roomId)
    ?? null;
  if (!session) return;
  const next = await promptSheet(t('renameChat'), {
    value: session.label ?? '',
    placeholder: session.peerNick || t('renameChatPlaceholder'),
    note: t('renameChatHint'),
    maxLength: 40,
  });
  if (next == null) return;
  const gespeichert = merkeSession(roomId, { label: next.trim() });
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
  el('chat-search').addEventListener('input', (ereignis) => beiSuche(ereignis.target.value));
  el('chat-search-clear').addEventListener('click', () => {
    sucheZuruecksetzen();
    renderChatList();
    el('chat-search').focus();
  });
  el('update-now').addEventListener('click', () => void applyUpdate());
  el('btn-lang').addEventListener('click', cycleLanguage);
  el('btn-theme').addEventListener('click', cycleTheme);
  el('btn-about').addEventListener('click', showAbout);
  el('btn-changelog').addEventListener('click', () => showChangelog());
  // Bild und Name in der Kopfzeile fuehren zum Profil - dort, wo man
  // danach greift.
  el('peer-open')?.addEventListener('click', openChatProfile);
  el('btn-avatar')?.addEventListener('click', openMyProfile);
  refreshAvatarChip();

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
  el('spoiler-cancel').addEventListener('click', () => {
    app.sendHidden = false;
    renderSpoilerBar();
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
    // Steht die Liste noch genau dort, wo die App sie zuletzt selbst
    // hingesetzt hat, dann hat sich niemand geruehrt - egal, was der
    // Abstand zum Ende inzwischen sagt.
    if (messages.scrollTop === gesetzterStand) return;
    gesetzterStand = -1;
    const distance = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
    const wasAtBottom = app.atBottom;
    app.atBottom = distance < 80;
    if (app.atBottom) {
      app.unread = 0;
      if (!wasAtBottom) markRead();
    }
    updateJumpButton();
    // Aeltere nachladen, wenn jemand nach oben wischt - nicht schon beim
    // Oeffnen. In einem kurzen Chat liegt das Ende selbst innerhalb der
    // ersten 60 Bildpunkte; ohne diese Bedingung zoege sich die App beim
    // Betreten den ganzen Verlauf herein, den niemand sehen wollte.
    if (messages.scrollTop < 60 && app.hasMore && !app.atBottom) loadMore();
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
  // Wegklicken soll man es nicht - dann darf man es auch nicht mit der
  // Tastatur umgehen. Zwei Tabs und die Eingabetaste legten darunter einen
  // neuen Chat an, waehrend das Fenster stehen blieb.
  fangeFokus(screen);
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
  await dropCachesAndWorkers();
  reloadFromServer();
}

/**
 * Zwischenspeicher leeren und den Service Worker abmelden.
 *
 * Gebraucht an zwei Stellen: beim erzwungenen Aktualisieren und beim
 * Löschen aller Daten. Beide Male gilt dasselbe - erst die Speicher leeren,
 * dann abmelden. Andersherum legt ein noch laufender Worker sie beim
 * Abmelden gleich wieder an.
 */
async function dropCachesAndWorkers() {
  try {
    const registrations = await navigator.serviceWorker?.getRegistrations?.() ?? [];
    for (const registration of registrations) {
      registration.waiting?.postMessage({ type: 'skipWaiting' });
    }
    if (typeof caches !== 'undefined') {
      const namen = await caches.keys();
      await Promise.all(namen.map((name) => caches.delete(name)));
    }
    await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
  } catch {
    // Auch wenn das Aufräumen scheitert: neu laden ist besser als bleiben.
  }
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
