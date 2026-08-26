/**
 * Flüsterchat – Ablaufsteuerung.
 *
 * Grundregel: Alles, was Inhalt ist, wird hier im Browser verschlüsselt.
 * Der Server bekommt nur die Raum-ID (ein Hash des Codes), ein Zugangstoken
 * und unlesbare Bytes zu sehen.
 */

import {
  cryptoAvailable, generateCode, formatCode, normalizeCode, isCompleteCode, codeLength,
  deriveRoomId, deriveKey, importKey, encryptJson, decryptJson, encryptBytes, decryptBytes,
  toBase64, fromBase64, randomId,
} from './crypto.js';
import { qrSvg } from './qr.js';
import { t, applyTranslations, setLanguage, getLanguage, detectLanguage, availableLanguages, onLanguageChange } from './i18n.js';
import { listSessions, getSession, saveSession, patchSession, removeSession, getPrefs, setPrefs, storageAvailable } from './session.js';
import { createRoom, roomStatus, uploadBlob, downloadBlob, burnRoom, Connection, ApiError } from './net.js';
import { prepareImage, readFileBytes, formatBytes, formatDuration, canRecordAudio, startRecording, playPing } from './media.js';
import {
  el, make, icon, showScreen, currentScreen, toast, busy, openSheet, closeSheet, sheetOpen,
  confirmSheet, promptSheet, openLightbox, closeLightbox, lightboxOpen,
  formatClock, formatDay, sameDay, relativeTime, linkify, initial, onLongPress, copyText,
} from './ui.js';

const MAX_ATTACHMENTS = 4;
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const TYPING_INTERVAL = 2500;
const TYPING_TIMEOUT = 4000;

/** Alles, was die laufende Sitzung ausmacht. */
const app = {
  prefs: null,
  session: null,
  key: null,
  conn: null,
  limits: { maxBlobBytes: 12 * 1024 * 1024 },
  me: null,
  peer: null,
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
  peerTypingTimer: null,
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
  app.prefs = getPrefs();
  setLanguage(detectLanguage(app.prefs.lang));
  applyTheme(app.prefs.theme);
  applyTranslations();
  wireStaticHandlers();
  onLanguageChange(() => {
    applyTranslations();
    refreshDynamicLabels();
  });

  if (!cryptoAvailable) {
    showError(t('errorCrypto'), { retry: false });
    return;
  }

  registerServiceWorker();
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
  const raw = decodeURIComponent(location.hash.replace(/^#/, '')).trim();
  if (!raw) return null;
  const [codePart, tokenPart] = raw.split('.');
  const code = normalizeCode(codePart);
  if (!isCompleteCode(code)) return null;
  return { code: formatCode(code), token: tokenPart || null };
}

function clearHash() {
  history.replaceState(null, '', location.pathname + location.search);
}

async function route() {
  const invite = parseHash();
  if (invite) {
    clearHash();
    await enterChat(invite.code, { deviceToken: invite.token });
    return;
  }
  if (currentScreen() === 'chat') return;
  showStart();
}

function showStart() {
  teardownChat();
  renderChatList();
  showScreen('start');
}

// ===========================================================================
// Chat anlegen und betreten
// ===========================================================================

async function startNewChat() {
  busy(true, t('joining'));
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateCode();
      const roomId = await deriveRoomId(code);
      try {
        await createRoom(roomId);
      } catch (error) {
        // Ein bereits vergebener Code ist extrem unwahrscheinlich - aber nicht unmöglich.
        if (error instanceof ApiError && error.code === 'room_exists') continue;
        throw error;
      }
      const keyRaw = await deriveKey(code);
      const session = saveSession({
        roomId,
        code,
        key: toBase64(keyRaw),
        token: null,
        memberId: null,
        nick: app.prefs.nick ?? '',
        peerNick: '',
        createdAt: Date.now(),
        lastActivity: Date.now(),
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

/** Beitreten oder zurueckkehren - je nachdem, was dieses Geraet schon kennt. */
async function enterChat(code, { deviceToken = null } = {}) {
  busy(true, t('joining'));
  try {
    const roomId = await deriveRoomId(code);
    const known = getSession(roomId);
    const token = deviceToken ?? known?.token ?? null;

    let status;
    try {
      status = await roomStatus(roomId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        showError(t('errorRoomUnknown'));
        return;
      }
      throw error;
    }
    if (status.full && !token) {
      showError(t('errorRoomFull'), { retry: false });
      return;
    }

    const keyRaw = known?.key ? fromBase64(known.key) : await deriveKey(code);
    const session = saveSession({
      roomId,
      code: formatCode(code),
      key: toBase64(keyRaw),
      token,
      memberId: known?.memberId ?? null,
      nick: known?.nick ?? app.prefs.nick ?? '',
      peerNick: known?.peerNick ?? '',
      createdAt: known?.createdAt ?? Date.now(),
      lastActivity: Date.now(),
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
  else showChatScreen();

  connect();
}

function connect() {
  app.conn = new Connection({
    roomId: app.session.roomId,
    token: app.session.token,
    onFrame: handleFrame,
    onStatus: handleConnectionStatus,
    onFatal: handleFatalClose,
  });
  app.conn.connect(true);
}

function teardownChat() {
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
  clearTimeout(app.peerTypingTimer);
  app.recorder?.cancel();
  app.recorder = null;
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
  app.peer = null;
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
  setInviteWaiting(fromChat || Boolean(app.peer));
  showScreen('invite');
}

const inviteLink = (code) => `${location.origin}${location.pathname}#${encodeURIComponent(formatCode(code))}`;
const deviceLink = (code, token) => `${location.origin}${location.pathname}#${encodeURIComponent(formatCode(code))}.${encodeURIComponent(token)}`;

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
  else if (code === 4010) {
    if (app.session) removeSession(app.session.roomId);
    showError(t('burnDone'), { retry: false });
  } else showError(t('errorRoomUnknown'), { retry: false });
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
  app.session = patchSession(app.session.roomId, {
    token: frame.you.token,
    memberId: frame.you.id,
    lastActivity: Date.now(),
  }) ?? app.session;
  if (app.conn) app.conn.token = frame.you.token;

  const peerRaw = frame.members.find((member) => member.id !== frame.you.id) ?? null;
  app.peer = peerRaw ? { ...peerRaw, typing: false } : null;
  if (app.peer?.nickCt) app.peer.nick = await safeDecrypt(app.peer.nickCt).then((value) => value?.n ?? '');

  if (app.session.nick) sendNick(app.session.nick);

  app.hasMore = frame.hasMore === true;
  await renderHistory(frame.messages, { replace: true });

  if (currentScreen() !== 'invite') {
    showChatScreen();
  } else if (app.peer && !app.inviteFromChat) {
    // Das Gegenüber war schon da - dann direkt in den Chat.
    showChatScreen();
  } else {
    setInviteWaiting(Boolean(app.peer));
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
  }
  const entries = await Promise.all(messages.map(toEntry));
  for (const entry of entries) insertEntry(entry);
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
  if (app.peer) app.peer.readSeq = Math.max(app.peer.readSeq ?? 0, frame.seq);
  redrawAll();
}

function onTyping(frame) {
  if (!app.peer || frame.from !== app.peer.id) return;
  app.peer.typing = frame.on === true;
  clearTimeout(app.peerTypingTimer);
  if (app.peer.typing) {
    app.peerTypingTimer = setTimeout(() => {
      if (app.peer) app.peer.typing = false;
      updatePeerStatus();
    }, TYPING_TIMEOUT);
  }
  updatePeerStatus();
  syncTypingBubble();
}

async function onNick(frame) {
  if (frame.from === app.me?.id) return;
  const value = await safeDecrypt(frame.ct);
  const nick = value?.n ?? '';
  if (!app.peer) app.peer = { id: frame.from, online: true };
  app.peer.nick = nick;
  patchSession(app.session.roomId, { peerNick: nick });
  updatePeerStatus();
}

function onPresence(frame) {
  if (frame.from === app.me?.id) return;
  if (!app.peer) app.peer = { id: frame.from, readSeq: 0 };
  app.peer.online = frame.online;
  app.peer.lastSeen = frame.lastSeen;
  if (!frame.online) app.peer.typing = false;
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

// ===========================================================================
// Nachrichten: Darstellung
// ===========================================================================

function showChatScreen() {
  showScreen('chat');
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
    const more = make('button', 'btn btn--ghost', '⋯');
    more.type = 'button';
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
  const shouldShow = app.peer?.typing === true && currentScreen() === 'chat';
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
      chip.addEventListener('click', () => toggleReaction(entry, emoji));
      row.appendChild(chip);
    }
    wrapper.appendChild(row);
  }

  if (!entry.deleted) {
    onLongPress(bubble, () => openMessageMenu(entry));
  }
  entry.node = wrapper;
  return wrapper;
}

function buildQuote(reply) {
  const quote = make('div', 'quote');
  quote.appendChild(make('strong', null, reply.from === app.me?.id ? t('you') : peerName()));
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
  } else if ((app.peer?.readSeq ?? 0) >= entry.seq) {
    const mark = icon('i-check-double');
    mark.classList.add('is-read');
    meta.appendChild(mark);
  } else if (app.peer?.online) {
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

function peerName() {
  return app.peer?.nick || app.session?.peerNick || t('partner');
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
  if (!app.peer) {
    status.textContent = t('neverSeen');
    return;
  }
  if (app.peer.typing) {
    status.textContent = t('typing');
    status.classList.add('is-typing');
    return;
  }
  if (app.peer.online) {
    status.textContent = t('online');
    status.classList.add('is-online');
    return;
  }
  status.textContent = app.peer.lastSeen ? t('lastSeen', { time: relativeTime(app.peer.lastSeen) }) : t('offline');
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
        kind: item.kind,
        text: i === 0 ? text : '',
        reply: i === 0 ? reply : null,
        media: item.media,
      }, [item.blobId]);
    }
    app.attachments = app.attachments.filter((item) => !item.blobId);
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
    seq: Number.MAX_SAFE_INTEGER - app.pending.size,
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

function markRead() {
  if (!app.conn || !app.order.length) return;
  let highest = 0;
  for (const id of app.order) {
    const entry = app.messages.get(id);
    if (entry && !isMine(entry) && !entry.pending) highest = Math.max(highest, entry.seq);
  }
  if (highest > 0) app.conn.send({ t: 'read', seq: highest });
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
        name: item.file.name || 'bild.jpg',
        mime: prepared.mime,
        size: bytes.length,
        width: prepared.width,
        height: prepared.height,
        thumb: prepared.thumb,
      };
      item.previewUrl = prepared.thumb || null;
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
    { icon: 'i-image', label: t('fromGallery'), onClick: () => el('file-gallery').click() },
    { icon: 'i-camera', label: t('fromCamera'), onClick: () => el('file-camera').click() },
    { icon: 'i-file', label: t('anyFile'), onClick: () => el('file-any').click() },
  ]);
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

function buildReactionRow(entry) {
  const row = make('div', 'emoji-row');
  for (const emoji of REACTIONS) {
    const button = make('button', null, emoji);
    button.type = 'button';
    button.setAttribute('aria-label', emoji);
    button.addEventListener('click', () => {
      closeSheet();
      toggleReaction(entry, emoji);
    });
    row.appendChild(button);
  }
  return row;
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
  const notificationLabel = Notification?.permission === 'denied'
    ? t('notificationsBlocked')
    : (app.prefs.notifications ? t('notificationsOn') : t('notificationsOff'));

  openSheet(t('menu'), [
    { icon: 'i-users', label: t('yourName'), value: app.session?.nick || '–', onClick: changeNick },
      { icon: 'i-qr', label: t('showCode'), onClick: () => showInvite(app.session, { fromChat: true }) },
    {
      icon: 'i-link',
      label: t('linkDevice'),
      hint: t('linkDeviceHint'),
      onClick: shareDeviceLink,
    },
    { icon: 'i-bell', label: t('notifications'), value: notificationLabel, onClick: toggleNotifications },
    { icon: 'i-bell', label: t('sound'), value: app.prefs.sound ? t('soundOn') : t('soundOff'), onClick: toggleSound },
    { icon: 'i-sun', label: t('theme'), value: themeLabel(), onClick: cycleTheme },
    { icon: 'i-globe', label: t('language'), value: getLanguage().toUpperCase(), onClick: cycleLanguage },
    { icon: 'i-info', label: t('about'), onClick: showAbout },
    { icon: 'i-close', label: t('leaveChat'), onClick: leaveChat },
    { icon: 'i-trash', label: t('burnChat'), danger: true, onClick: burnCurrentChat },
  ]);
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
  const ok = await confirmSheet(t('burnChat'), t('burnConfirm'), t('confirm'));
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

async function leaveChat() {
  const ok = await confirmSheet(t('leaveChat'), t('leaveConfirm'), t('confirm'), { danger: false });
  if (!ok) return;
  removeSession(app.session.roomId);
  teardownChat();
  showStart();
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
  const meta = document.querySelector('meta[name="theme-color"]');
  const effectiveDark = theme === 'dark' || (theme === 'auto' && dark);
  if (meta) meta.setAttribute('content', effectiveDark ? '#0f1319' : '#f6f7f9');
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
    updatePeerStatus();
    redrawAll();
  }
  if (currentScreen() === 'start') renderChatList();
  if (currentScreen() === 'invite') setInviteWaiting(Boolean(app.peer));
}

function toggleSound() {
  app.prefs = setPrefs({ sound: !app.prefs.sound });
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

function notifyIncoming(entry) {
  if (app.prefs.sound && document.visibilityState !== 'visible') playPing();
  if (!app.prefs.notifications || typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
  try {
    const notification = new Notification(peerName(), {
      body: previewOf(entry).slice(0, 140),
      icon: '/icons/icon-192.png',
      badge: '/icons/badge.png',
      tag: app.session.roomId,
      renotify: false,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch { /* Benachrichtigungen sind Beiwerk */ }
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
    const name = session.peerNick || t('partner');
    const avatar = make('div', 'avatar avatar--sm', initial(name));
    const text = make('div', 'chat-list__text');
    text.appendChild(make('span', 'chat-list__name', name));
    text.appendChild(make('span', 'chat-list__meta', `${session.code} · ${relativeTime(session.lastActivity)}`));
    button.append(avatar, text);
    if (session.unread > 0) button.appendChild(make('span', 'pill', String(session.unread)));
    button.appendChild(icon('i-chevron-down'));
    button.addEventListener('click', () => void enterChat(session.code));
    onLongPress(button, () => openSessionMenu(session));
    item.appendChild(button);
    list.appendChild(item);
  }
}

function openSessionMenu(session) {
  openSheet(session.code, [
    { icon: 'i-copy', label: t('copyCode'), onClick: async () => {
      toast(await copyText(session.code) ? t('copied') : t('copyFailed'));
    } },
    { icon: 'i-close', label: t('leaveChat'), danger: true, onClick: () => {
      removeSession(session.roomId);
      renderChatList();
    } },
  ]);
}

// ===========================================================================
// Fehleranzeige
// ===========================================================================

function showError(message, { retry = true } = {}) {
  busy(false);
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
  el('btn-join').addEventListener('click', () => {
    el('code-input').value = '';
    el('btn-do-join').disabled = true;
    showScreen('join');
    setTimeout(() => el('code-input').focus(), 60);
  });
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
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

boot();
