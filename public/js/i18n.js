/** Zweisprachige Oberflaeche. Deutsch ist die Standardsprache. */

const STRINGS = {
  de: {
    appName: 'Flüsterchat',
    tagline: 'Chatten ohne Anmeldung. Ein Code, zwei Leute, Schluss.',
    startChat: 'Neuen Chat starten',
    joinChat: 'Code eingeben',
    startHint: 'Kein Konto, keine Telefonnummer, keine E-Mail.',
    yourChats: 'Deine Chats',
    featureE2e: 'Ende-zu-Ende verschlüsselt',
    featureE2eText: 'Der Schlüssel steckt im Code und verlässt dein Gerät nie.',
    featureNoAccount: 'Ohne Anmeldung',
    featureNoAccountText: 'Code erzeugen, teilen, losschreiben.',
    featurePhotos: 'Fotos & Sprache',
    featurePhotosText: 'Bilder aus der Galerie, Kamera und Sprachnachrichten.',

    yourCode: 'Dein Einmal-Code',
    codeHint: 'Gib diesen Code an genau eine Person weiter. Danach ist er verbraucht.',
    waitingForPeer: 'Warte auf dein Gegenüber …',
    peerArrived: 'Dein Gegenüber ist da!',
    shareLink: 'Link teilen',
    copyLink: 'Link kopieren',
    copyCode: 'Code kopieren',
    copied: 'Kopiert!',
    copyFailed: 'Kopieren hat nicht geklappt',
    scanHint: 'Oder scannen lassen:',
    toChat: 'Zum Chat',
    cancel: 'Abbrechen',
    back: 'Zurück',

    enterCode: 'Code eingeben',
    enterCodeHint: 'Die zwölf Zeichen von deinem Gegenüber.',
    codePlaceholder: 'ABCD-EFGH-JKMN',
    join: 'Beitreten',
    paste: 'Einfügen',
    joining: 'Verbinde …',

    messagePlaceholder: 'Nachricht',
    send: 'Senden',
    attach: 'Anhängen',
    fromGallery: 'Foto aus der Galerie',
    fromCamera: 'Foto aufnehmen',
    anyFile: 'Datei senden',
    recordVoice: 'Sprachnachricht',
    recording: 'Nimmt auf …',
    stopAndSend: 'Stoppen und senden',
    discard: 'Verwerfen',
    removeAttachment: 'Anhang entfernen',

    online: 'online',
    offline: 'offline',
    typing: 'tippt …',
    lastSeen: 'zuletzt gesehen {time}',
    neverSeen: 'noch nicht da',
    connecting: 'Verbindung wird hergestellt …',
    reconnecting: 'Verbindung unterbrochen – neuer Versuch …',
    offlineBanner: 'Keine Verbindung. Nachrichten warten hier.',

    you: 'Du',
    partner: 'Gegenüber',
    today: 'Heute',
    yesterday: 'Gestern',
    justNow: 'gerade eben',
    minutesAgo: 'vor {n} Min.',
    hoursAgo: 'vor {n} Std.',

    reply: 'Antworten',
    copy: 'Kopieren',
    edit: 'Bearbeiten',
    deleteMessage: 'Löschen',
    save: 'Speichern',
    saveImage: 'Bild sichern',
    messageDeleted: 'Nachricht gelöscht',
    edited: 'bearbeitet',
    replyingTo: 'Antwort auf',
    image: 'Bild',
    voiceMessage: 'Sprachnachricht',
    file: 'Datei',
    undecryptable: 'Diese Nachricht lässt sich nicht entschlüsseln.',

    menu: 'Menü',
    yourName: 'Dein Name',
    namePlaceholder: 'Wie sollen wir dich nennen?',
    showCode: 'Code anzeigen',
    linkDevice: 'Weiteres eigenes Gerät verbinden',
    linkDeviceHint: 'Dieser Link öffnet denselben Chat mit deiner Identität. Nur für dich selbst!',
    notifications: 'Benachrichtigungen',
    notificationsOn: 'Benachrichtigungen an',
    notificationsOff: 'Benachrichtigungen aus',
    notificationsBlocked: 'Im Browser blockiert',
    sound: 'Ton',
    soundOn: 'Ton an',
    soundOff: 'Ton aus',
    theme: 'Design',
    themeAuto: 'Automatisch',
    themeLight: 'Hell',
    themeDark: 'Dunkel',
    language: 'Sprache',
    burnChat: 'Chat unwiderruflich löschen',
    burnConfirm: 'Wirklich alles löschen? Nachrichten und Bilder verschwinden für beide Seiten – sofort und endgültig.',
    burnDone: 'Der Chat wurde gelöscht.',
    leaveChat: 'Chat verlassen',
    leaveConfirm: 'Diesen Chat auf diesem Gerät schließen? Ohne den Code kommst du nicht zurück.',
    about: 'Über',
    close: 'Schließen',
    confirm: 'Ja, löschen',

    errorTitle: 'Das hat nicht geklappt',
    errorRoomUnknown: 'Diesen Chat gibt es nicht (mehr). Vielleicht ist der Code abgelaufen oder vertippt.',
    errorRoomFull: 'Dieser Chat ist schon voll. Ein Code verbindet genau zwei Geräte.',
    errorRoomExists: 'Dieser Code ist gerade vergeben. Bitte erzeuge einen neuen.',
    errorNetwork: 'Der Server ist nicht erreichbar. Bitte später noch einmal versuchen.',
    errorCrypto: 'Dieser Browser kann keine Ende-zu-Ende-Verschlüsselung. Bitte nutze eine aktuelle Version – und rufe die Seite über HTTPS auf.',
    errorRateLimited: 'Zu viele Versuche. Bitte kurz warten.',
    errorTooLarge: 'Die Datei ist zu groß (höchstens {max}).',
    errorUpload: 'Der Anhang konnte nicht gesendet werden.',
    errorMic: 'Kein Zugriff auf das Mikrofon.',
    errorImage: 'Dieses Bild konnte nicht gelesen werden.',
    tryAgain: 'Noch einmal versuchen',
    startOver: 'Von vorn anfangen',

    aboutText: 'Flüsterchat verbindet genau zwei Geräte über einen Einmal-Code. Alles, was du schreibst oder schickst, wird auf deinem Gerät verschlüsselt – der Server sieht nur unlesbare Daten und weiß weder, wer du bist, noch was du sagst.',
    aboutRetention: 'Ungenutzte Codes verfallen nach einem Tag, stille Chats nach einer Woche. Mit „Chat löschen“ ist sofort alles weg.',
    privacyNote: 'Ende-zu-Ende verschlüsselt · keine Konten · keine Tracker',
  },

  en: {
    appName: 'Flüsterchat',
    tagline: 'Chat without signing up. One code, two people, done.',
    startChat: 'Start a new chat',
    joinChat: 'Enter a code',
    startHint: 'No account, no phone number, no email.',
    yourChats: 'Your chats',
    featureE2e: 'End-to-end encrypted',
    featureE2eText: 'The key lives in the code and never leaves your device.',
    featureNoAccount: 'No sign-up',
    featureNoAccountText: 'Create a code, share it, start typing.',
    featurePhotos: 'Photos & voice',
    featurePhotosText: 'Gallery pictures, camera shots and voice notes.',

    yourCode: 'Your one-time code',
    codeHint: 'Give this code to exactly one person. After that it is used up.',
    waitingForPeer: 'Waiting for the other person …',
    peerArrived: 'They made it!',
    shareLink: 'Share link',
    copyLink: 'Copy link',
    copyCode: 'Copy code',
    copied: 'Copied!',
    copyFailed: 'Copying did not work',
    scanHint: 'Or let them scan:',
    toChat: 'Go to chat',
    cancel: 'Cancel',
    back: 'Back',

    enterCode: 'Enter code',
    enterCodeHint: 'The twelve characters from the other person.',
    codePlaceholder: 'ABCD-EFGH-JKMN',
    join: 'Join',
    paste: 'Paste',
    joining: 'Connecting …',

    messagePlaceholder: 'Message',
    send: 'Send',
    attach: 'Attach',
    fromGallery: 'Photo from gallery',
    fromCamera: 'Take a photo',
    anyFile: 'Send a file',
    recordVoice: 'Voice message',
    recording: 'Recording …',
    stopAndSend: 'Stop and send',
    discard: 'Discard',
    removeAttachment: 'Remove attachment',

    online: 'online',
    offline: 'offline',
    typing: 'typing …',
    lastSeen: 'last seen {time}',
    neverSeen: 'not here yet',
    connecting: 'Connecting …',
    reconnecting: 'Connection lost – retrying …',
    offlineBanner: 'No connection. Messages will wait here.',

    you: 'You',
    partner: 'Them',
    today: 'Today',
    yesterday: 'Yesterday',
    justNow: 'just now',
    minutesAgo: '{n} min ago',
    hoursAgo: '{n} h ago',

    reply: 'Reply',
    copy: 'Copy',
    edit: 'Edit',
    deleteMessage: 'Delete',
    save: 'Save',
    saveImage: 'Save image',
    messageDeleted: 'Message deleted',
    edited: 'edited',
    replyingTo: 'Replying to',
    image: 'Image',
    voiceMessage: 'Voice message',
    file: 'File',
    undecryptable: 'This message cannot be decrypted.',

    menu: 'Menu',
    yourName: 'Your name',
    namePlaceholder: 'What should we call you?',
    showCode: 'Show code',
    linkDevice: 'Link another device of yours',
    linkDeviceHint: 'This link opens the same chat as you. Only for yourself!',
    notifications: 'Notifications',
    notificationsOn: 'Notifications on',
    notificationsOff: 'Notifications off',
    notificationsBlocked: 'Blocked by the browser',
    sound: 'Sound',
    soundOn: 'Sound on',
    soundOff: 'Sound off',
    theme: 'Theme',
    themeAuto: 'Automatic',
    themeLight: 'Light',
    themeDark: 'Dark',
    language: 'Language',
    burnChat: 'Delete this chat for good',
    burnConfirm: 'Really delete everything? Messages and pictures disappear for both sides – instantly and for good.',
    burnDone: 'The chat has been deleted.',
    leaveChat: 'Leave chat',
    leaveConfirm: 'Close this chat on this device? Without the code you cannot come back.',
    about: 'About',
    close: 'Close',
    confirm: 'Yes, delete',

    errorTitle: 'That did not work',
    errorRoomUnknown: 'This chat does not exist (any more). Maybe the code expired or has a typo.',
    errorRoomFull: 'This chat is already full. One code connects exactly two devices.',
    errorRoomExists: 'That code is currently taken. Please create a new one.',
    errorNetwork: 'The server cannot be reached. Please try again later.',
    errorCrypto: 'This browser cannot do end-to-end encryption. Please use a recent version – and open the page over HTTPS.',
    errorRateLimited: 'Too many attempts. Please wait a moment.',
    errorTooLarge: 'That file is too big (at most {max}).',
    errorUpload: 'The attachment could not be sent.',
    errorMic: 'No access to the microphone.',
    errorImage: 'This picture could not be read.',
    tryAgain: 'Try again',
    startOver: 'Start over',

    aboutText: 'Flüsterchat connects exactly two devices through a one-time code. Everything you write or send is encrypted on your device – the server only ever sees unreadable data and knows neither who you are nor what you say.',
    aboutRetention: 'Unused codes expire after a day, quiet chats after a week. "Delete chat" wipes everything immediately.',
    privacyNote: 'End-to-end encrypted · no accounts · no trackers',
  },
};

const listeners = new Set();
let current = 'de';

export const availableLanguages = Object.keys(STRINGS);

export function detectLanguage(stored) {
  if (stored && STRINGS[stored]) return stored;
  const candidates = navigator.languages?.length ? navigator.languages : [navigator.language || 'de'];
  for (const tag of candidates) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (STRINGS[base]) return base;
  }
  return 'de';
}

export function setLanguage(lang) {
  current = STRINGS[lang] ? lang : 'de';
  document.documentElement.lang = current;
  for (const listener of listeners) listener(current);
  return current;
}

export const getLanguage = () => current;

export function onLanguageChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Uebersetzt einen Schluessel und ersetzt {platzhalter}. */
export function t(key, vars) {
  const template = STRINGS[current]?.[key] ?? STRINGS.de[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

/** Setzt alle Elemente mit data-i18n / data-i18n-attr neu. */
export function applyTranslations(root = document) {
  for (const element of root.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of element.dataset.i18nAttr.split(',')) {
      const [attr, key] = pair.split(':').map((part) => part.trim());
      if (attr && key) element.setAttribute(attr, t(key));
    }
  }
}
