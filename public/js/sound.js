/**
 * Die Klänge der App.
 *
 * Leitgedanke: Die Anwendung heisst Flüsterchat, und auf der Bildmarke steht
 * "psst...". So soll sie auch klingen - gedämpft, weich, nie schrill. Ein
 * Klang darf einen Hinweis geben; er darf niemanden erschrecken und er darf
 * das Gespräch nicht übertönen.
 *
 * Daraus folgen ein paar Festlegungen, die für ALLE Klänge gelten und sie zu
 * einer Familie machen:
 *
 *   - Sinustöne, dazu ein sehr leiser Ton eine Oktave darüber. Das gibt Glanz,
 *     ohne dass es nach Rechteck oder Sägezahn klingelt.
 *   - Ein Tiefpass bei 2,6 kHz nimmt jede Schärfe heraus. Was übrig bleibt,
 *     klingt wie ein Ton hinter einer Wand.
 *   - Der Einschwung dauert 12 ms. Kürzer knackt es; länger wirkt es träge.
 *   - Der Ausschwung ist exponentiell und endet nie bei genau null - bei null
 *     macht die Rechnung einen Sprung, und ein Sprung ist ein Knacken.
 *   - Alle Töne kommen aus einer Fünftonleiter über D. Was auch immer
 *     gleichzeitig oder hintereinander erklingt, passt zusammen.
 *   - Jeder Klang hat eine Ruhezeit. Ein Schwung Nachrichten soll einmal
 *     klingen, nicht zwölfmal übereinander.
 *
 * Alles wird gerechnet, nichts geladen: keine Tondateien, kein zusätzlicher
 * Download, und offline klingt es genauso.
 */

/** Fünftonleiter über D - jede Kombination daraus ist verträglich. */
const TON = {
  d5: 587.33,
  e5: 659.25,
  fis5: 739.99,
  a5: 880.00,
  h5: 987.77,
  d6: 1174.66,
  // Nur für den Hinweis "das hat nicht geklappt": ein Ganzton nach unten aus
  // der Leiter heraus. Er soll nicht falsch klingen, aber auch nicht hübsch.
  c5: 523.25,
};

/**
 * Die Klangpalette.
 *
 * Jeder Eintrag ist reine Beschreibung - Frequenz, Einsatz, Dauer, Lautstärke,
 * Ruhezeit. Das lässt sich prüfen, ohne einen Ton zu hören, und wer etwas
 * ändern will, ändert Zahlen und keine Signalverarbeitung.
 *
 * `ruhe` ist der Mindestabstand in Sekunden zum vorigen Ton DESSELBEN Klangs.
 * Die Werte sind sehr verschieden, weil die Anlässe es sind: eine eigene
 * Nachricht schickt man bewusst ab und darf jedes Mal eine Quittung hören.
 * Ankommendes kommt in Schwüngen - und wer ohnehin auf den Bildschirm sieht,
 * braucht nicht für jede einzelne Zeile einen Ton.
 */
export const PALETTE = {
  /** Eigene Nachricht ist raus. Kaum mehr als ein Antippen. */
  send: { gain: 0.030, ruhe: 0.35, notes: [{ freq: TON.a5, at: 0, dur: 0.10 }] },

  /**
   * Nachricht gekommen, während man hinsieht. Zwei Töne aufwärts.
   *
   * Lange Ruhezeit: Bei einem lebhaften Hin und Her sieht man die Blase
   * ohnehin erscheinen. Ein Ton je Nachricht wäre alle paar Sekunden einer -
   * das ist der Punkt, an dem man den Ton abschaltet und danach auch das
   * Klingeln nicht mehr hört. Ein Schwung klingt einmal, dann ist Ruhe.
   */
  receive: {
    gain: 0.055,
    ruhe: 6,
    notes: [
      { freq: TON.fis5, at: 0, dur: 0.16 },
      { freq: TON.a5, at: 0.055, dur: 0.22 },
    ],
  },

  /**
   * Nachricht gekommen, während man woanders ist - der eigentliche
   * Benachrichtigungston. Drei Töne aufwärts, etwas präsenter als "receive",
   * aber immer noch weit entfernt von einem Alarm.
   */
  notify: {
    gain: 0.075,
    ruhe: 2,
    notes: [
      { freq: TON.d5, at: 0, dur: 0.16 },
      { freq: TON.a5, at: 0.07, dur: 0.20 },
      { freq: TON.d6, at: 0.14, dur: 0.34 },
    ],
  },

  /**
   * Es klingelt. Zwei weiche Doppelklänge - so, wie ein Telefon klingt, das
   * niemanden aufschrecken will. Wird von aussen im Takt wiederholt.
   */
  ring: {
    gain: 0.070,
    ruhe: 1,
    notes: [
      { freq: TON.a5, at: 0, dur: 0.34 },
      { freq: TON.e5, at: 0, dur: 0.34, gain: 0.5 },
      { freq: TON.h5, at: 0.30, dur: 0.40 },
      { freq: TON.fis5, at: 0.30, dur: 0.40, gain: 0.5 },
    ],
  },

  /** Der Anruf steht: eine reine Quinte aufwärts. */
  callStart: {
    gain: 0.060,
    ruhe: 0.3,
    notes: [
      { freq: TON.d5, at: 0, dur: 0.18 },
      { freq: TON.a5, at: 0.08, dur: 0.30 },
    ],
  },

  /** Der Anruf ist zu Ende: dieselbe Quinte abwärts. */
  callEnd: {
    gain: 0.055,
    ruhe: 0.3,
    notes: [
      { freq: TON.a5, at: 0, dur: 0.18 },
      { freq: TON.d5, at: 0.08, dur: 0.34 },
    ],
  },

  /** Jemand ist dazugekommen. */
  join: {
    gain: 0.048,
    ruhe: 1.5,
    notes: [
      { freq: TON.e5, at: 0, dur: 0.14 },
      { freq: TON.h5, at: 0.06, dur: 0.26 },
    ],
  },

  /** Jemand ist gegangen. Dasselbe rückwärts, damit es zusammengehört. */
  leave: {
    gain: 0.042,
    ruhe: 1.5,
    notes: [
      { freq: TON.h5, at: 0, dur: 0.14 },
      { freq: TON.e5, at: 0.06, dur: 0.26 },
    ],
  },

  /**
   * Etwas hat nicht geklappt. Ein Ganzton abwärts, dumpfer als alles andere -
   * erkennbar "nicht gut", ohne jemanden anzuschnauzen.
   */
  error: {
    gain: 0.055,
    ruhe: 0.5,
    dull: true,
    notes: [
      { freq: TON.d5, at: 0, dur: 0.14 },
      { freq: TON.c5, at: 0.10, dur: 0.26 },
    ],
  },
};

/** Weiter oben schneidet der Tiefpass ab - dort sitzt die Schärfe. */
const CUTOFF = 2600;
const CUTOFF_DULL = 1100;
/** Kürzer knackt es, länger wirkt es träge. */
const ATTACK = 0.012;
/** Der Ausschwung endet hier statt bei null: null wäre ein Sprung, also ein Knacken. */
const FLOOR = 0.0001;
/** Die Oktave darüber gibt Glanz - kaum hörbar, aber deutlich zu vermissen. */
const SHIMMER = 0.16;
/** Wer einen laufenden Klang abbricht, blendet ihn aus - abschneiden knackt. */
const FADE = 0.03;
/** Falls ein Klang einmal keine eigene Ruhezeit nennt. */
const RUHE = 0.15;

let context = null;
/**
 * Der eine Summenpunkt, in den alle Klänge laufen - mit einer Bremse dahinter.
 *
 * Ohne ihn hängt jeder Klang direkt am Ausgang, und gleichzeitige Klänge
 * addieren sich ungebremst. Gleichzeitig kommen sie durchaus: beim Abholen
 * per HTTP liefert eine einzige Antwort alles, was sich seit dem letzten Mal
 * angesammelt hat. Aus dem "psst" würde dann ausgerechnet in dem Moment ein
 * verzerrter Schlag, in dem das Gerät ans Ohr geht.
 */
let bus = null;
/** Wann welcher Klang zuletzt begonnen hat - auf der Uhr des Tonkanals. */
const zuletzt = new Map();
let enabled = true;
let makeContext = () => {
  const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return Ctor ? new Ctor() : null;
};

/**
 * @param {{enabled?: boolean, contextFactory?: () => (AudioContext|null)}} options
 */
export function configureSound(options = {}) {
  if (typeof options.enabled === 'boolean') enabled = options.enabled;
  if (typeof options.contextFactory === 'function') {
    makeContext = options.contextFactory;
    forgetSound();
  }
}

export const soundEnabled = () => enabled;

/**
 * Holt den einen Tonkanal - und legt ihn erst an, wenn er gebraucht wird.
 *
 * Genau einen: Browser erlauben nur eine Handvoll gleichzeitig, und ein
 * Kanal je Ton wäre nach ein paar Nachrichten aufgebraucht.
 */
function audio() {
  if (context) return context;
  try {
    context = makeContext();
  } catch {
    context = null;
  }
  bus = context ? buildBus(context) : null;
  return context;
}

/** Summenpunkt und Bremse. Ohne Bremse geht es auch - nur lauter. */
function buildBus(ctx) {
  try {
    const summe = ctx.createGain();
    summe.gain.value = 1;
    const bremse = ctx.createDynamicsCompressor?.();
    if (!bremse) {
      summe.connect(ctx.destination);
      return summe;
    }
    // Ein einzelner Klang liegt weit unter der Schwelle, da passiert nichts.
    // Erst wenn sich mehrere übereinanderlegen, greift sie ein - und sanft.
    bremse.threshold.value = -24;
    bremse.knee.value = 18;
    bremse.ratio.value = 6;
    bremse.attack.value = 0.003;
    bremse.release.value = 0.12;
    summe.connect(bremse).connect(ctx.destination);
    return summe;
  } catch {
    return null;
  }
}

/**
 * Weckt den Tonkanal an einer echten Eingabe.
 *
 * Browser lassen Ton erst zu, wenn jemand etwas getan hat. Ohne diesen
 * Anstoss bliebe der Kanal angehalten - und die erste Nachricht, die
 * hereinkommt, während man noch nichts angetippt hat, bliebe stumm.
 *
 * Bewusst auf "läuft nicht" geprüft und nicht auf "angehalten": Safari kennt
 * dafür auch den Zustand "interrupted" - nach einem Telefonanruf oder Siri.
 * Wer nur auf "suspended" schaut, bleibt danach für den Rest der Sitzung
 * stumm, ohne dass irgendetwas darauf hindeutet.
 */
export function primeSound() {
  const ctx = audio();
  if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') {
    void ctx.resume?.().catch(() => {});
  }
  return ctx;
}

/**
 * Spielt einen Klang aus der Palette.
 *
 * Gibt `false` zurück, wenn nichts erklingt: stummgeschaltet, unbekannter
 * Klang, kein Tonkanal - oder noch in der Ruhezeit. Sonst einen Griff, mit
 * dem sich der Klang vorzeitig ausblenden lässt; den braucht der Klingelton,
 * der beim Annehmen aufhören soll, statt noch eine halbe Sekunde unter dem
 * Ton für den stehenden Anruf weiterzulaufen.
 *
 * Ton ist Beiwerk: er darf nie im Weg stehen und niemals einen Fehler
 * auslösen.
 *
 * @returns {false | {stop: () => void}}
 */
export function playSound(name) {
  if (!enabled) return false;
  const klang = PALETTE[name];
  if (!klang) return false;
  const ctx = audio();
  if (!ctx || ctx.state === 'closed' || !bus) return false;
  if (ctx.state !== 'running') void ctx.resume?.().catch(() => {});

  const jetzt = ctx.currentTime;
  const vorhin = zuletzt.get(name);
  // Die Ruhezeit hilft nebenbei ein zweites Mal: steht der Kanal still, steht
  // auch diese Uhr. Dann wird nur ein einziger Klang eingeplant statt eines
  // ganzen Stapels, der beim Aufwachen auf einmal losbräche.
  if (vorhin !== undefined && jetzt - vorhin < (klang.ruhe ?? RUHE)) return false;
  zuletzt.set(name, jetzt);

  try {
    const summe = ctx.createGain();
    summe.gain.value = klang.gain ?? 0.05;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = klang.dull ? CUTOFF_DULL : CUTOFF;
    // Eine Spur Resonanz gibt Körper, ohne zu pfeifen.
    filter.Q.value = 0.7;

    summe.connect(filter).connect(bus);

    // Aufgeräumt wird, wenn der letzte Ton wirklich verklungen ist - also auf
    // der Uhr des Tonkanals. Eine Zeitschaltung auf der Wanduhr wäre falsch:
    // steht der Kanal still (Hintergrund, iOS-Unterbrechung), läuft die
    // Wanduhr weiter und schnitte den Klang im lautesten Moment ab. Genau das
    // Knacken, das der Rest dieser Datei so sorgfältig vermeidet.
    let offen = klang.notes.length * 2;
    const fertig = () => {
      offen -= 1;
      if (offen > 0) return;
      try { summe.disconnect(); filter.disconnect(); } catch { /* schon getrennt */ }
    };

    const oszillatoren = [];
    for (const note of klang.notes) {
      const beginn = jetzt + (note.at ?? 0);
      const dauer = note.dur ?? 0.2;
      oszillatoren.push(ton(ctx, summe, note.freq, beginn, dauer, note.gain ?? 1, fertig));
      // Der leise Ton eine Oktave darüber - der Glanz.
      oszillatoren.push(ton(ctx, summe, note.freq * 2, beginn, dauer * 0.7, (note.gain ?? 1) * SHIMMER, fertig));
    }

    return {
      /** Ausblenden statt abschneiden - ein harter Schnitt knackt. */
      stop() {
        try {
          const ab = ctx.currentTime;
          summe.gain.cancelScheduledValues(ab);
          summe.gain.setValueAtTime(Math.max(summe.gain.value, FLOOR), ab);
          summe.gain.exponentialRampToValueAtTime(FLOOR, ab + FADE);
          for (const oszillator of oszillatoren) oszillator.stop(ab + FADE);
        } catch { /* war schon vorbei */ }
      },
    };
  } catch {
    // Ein stummer Klang ist besser als eine Ausnahme mitten im Chat.
    return false;
  }
}

/** Ein einzelner Ton mit weichem Ein- und Ausschwung. */
function ton(ctx, ziel, freq, beginn, dauer, lautstaerke, fertig) {
  const oszillator = ctx.createOscillator();
  oszillator.type = 'sine';
  oszillator.frequency.setValueAtTime(freq, beginn);

  const huelle = ctx.createGain();
  huelle.gain.setValueAtTime(FLOOR, beginn);
  huelle.gain.exponentialRampToValueAtTime(Math.max(lautstaerke, FLOOR), beginn + ATTACK);
  huelle.gain.exponentialRampToValueAtTime(FLOOR, beginn + dauer);

  oszillator.connect(huelle).connect(ziel);
  oszillator.start(beginn);
  oszillator.stop(beginn + dauer + 0.02);
  oszillator.onended = () => {
    try { oszillator.disconnect(); huelle.disconnect(); } catch { /* schon getrennt */ }
    fertig();
  };
  return oszillator;
}

/** Nur für Tests: den gemerkten Kanal vergessen. */
export function forgetSound() {
  context = null;
  bus = null;
  zuletzt.clear();
}
