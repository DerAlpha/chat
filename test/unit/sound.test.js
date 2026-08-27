/**
 * Die Klänge der App.
 *
 * Hören kann ein Test nichts. Prüfen lässt sich trotzdem das meiste, und
 * zwar genau das, was im Betrieb schiefgeht: dass ein abgeschalteter Ton
 * wirklich stumm bleibt, dass nicht bei jedem Ton ein neuer Tonkanal
 * aufgemacht wird (davon erlauben Browser nur eine Handvoll), dass ein
 * Schwung Nachrichten einmal klingt statt zwölfmal übereinander, dass am Ende
 * niemand Knoten liegen lässt - und dass die Palette zusammenpasst: eine
 * Familie, nicht neun Einzelstücke.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PALETTE, configureSound, forgetSound, playSound, primeSound, soundEnabled,
} from '../../public/js/sound.js';

/**
 * Ein Tonkanal auf dem Papier: schreibt mit, statt zu klingen.
 *
 * `currentTime` bleibt stehen, bis ein Test sie weiterdreht - dadurch lässt
 * sich die Ruhezeit zwischen zwei Klängen genau nachstellen.
 */
function fakeContext({ state = 'running' } = {}) {
  const param = (start = 0) => ({
    value: start,
    abgebrochen: 0,
    gesetzt: [],
    rampen: [],
    setValueAtTime(wert, zeit) { this.gesetzt.push({ wert, zeit }); },
    exponentialRampToValueAtTime(wert, zeit) { this.rampen.push({ wert, zeit }); },
    cancelScheduledValues() { this.abgebrochen += 1; },
  });
  const ctx = {
    state,
    currentTime: 0,
    resumed: 0,
    oszillatoren: [],
    knoten: [],
    resume() { ctx.resumed += 1; ctx.state = 'running'; return Promise.resolve(); },
    createGain() {
      const knoten = {
        art: 'gain',
        verbunden: [],
        getrennt: 0,
        gain: param(0),
        connect(ziel) { knoten.verbunden.push(ziel); return ziel; },
        disconnect() { knoten.getrennt += 1; },
      };
      ctx.knoten.push(knoten);
      return knoten;
    },
    createBiquadFilter() {
      const knoten = {
        art: 'filter',
        type: '',
        frequency: { value: 0 },
        Q: { value: 0 },
        verbunden: [],
        getrennt: 0,
        connect(ziel) { knoten.verbunden.push(ziel); return ziel; },
        disconnect() { knoten.getrennt += 1; },
      };
      ctx.knoten.push(knoten);
      return knoten;
    },
    createDynamicsCompressor() {
      const knoten = {
        art: 'bremse',
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 0 },
        attack: { value: 0 },
        release: { value: 0 },
        verbunden: [],
        connect(ziel) { knoten.verbunden.push(ziel); return ziel; },
        disconnect() {},
      };
      ctx.knoten.push(knoten);
      return knoten;
    },
    createOscillator() {
      const knoten = {
        art: 'osc',
        type: '',
        frequenz: null,
        gestartet: null,
        gestoppt: null,
        beendet: false,
        frequency: { setValueAtTime(wert) { knoten.frequenz = wert; } },
        verbunden: [],
        connect(ziel) { knoten.verbunden.push(ziel); return ziel; },
        disconnect() {},
        start(zeit) { knoten.gestartet = zeit; },
        stop(zeit) { knoten.gestoppt = zeit; },
        /** Was der Browser tut, wenn der Ton wirklich verklungen ist. */
        verklingen() { knoten.beendet = true; knoten.onended?.(); },
      };
      ctx.oszillatoren.push(knoten);
      ctx.knoten.push(knoten);
      return knoten;
    },
    destination: { art: 'ziel' },
  };
  return ctx;
}

/**
 * Verfolgt den Signalweg von einem Knoten aus nach vorn. Ohne das prüft ein
 * Test nur, WER am Ausgang hängt - nicht, ob der Ton dort ankommt. Kappt man
 * eine einzige Verbindung, ist die App vollständig stumm, und ohne diese
 * Nachverfolgung bleibt trotzdem alles grün.
 */
function erreicht(von, ziel, gesehen = new Set()) {
  if (von === ziel) return true;
  if (gesehen.has(von)) return false;
  gesehen.add(von);
  return (von.verbunden ?? []).some((naechster) => erreicht(naechster, ziel, gesehen));
}

/** Die Hüllkurve eines Tons: der Gain-Knoten, an dem er hängt. */
const huelleVon = (oszillator) => oszillator.verbunden[0];

function mitKanal(fn, options) {
  const ctx = fakeContext(options);
  let angelegt = 0;
  configureSound({ enabled: true, contextFactory: () => { angelegt += 1; return ctx; } });
  try {
    return fn(ctx, () => angelegt);
  } finally {
    configureSound({ enabled: true, contextFactory: () => fakeContext() });
  }
}

// ------------------------------------------------------------- Die Palette

test('Jeder Klang ist vollstaendig beschrieben', () => {
  for (const [name, klang] of Object.entries(PALETTE)) {
    assert.ok(klang.notes?.length > 0, `${name} hat keine Toene`);
    assert.ok(klang.gain > 0 && klang.gain <= 0.12, `${name}: Lautstaerke ${klang.gain} ist unpassend`);
    assert.ok(klang.ruhe > 0, `${name} hat keine Ruhezeit`);
    for (const note of klang.notes) {
      assert.ok(note.freq >= 200 && note.freq <= 2000, `${name}: ${note.freq} Hz liegt ausserhalb`);
      assert.ok((note.at ?? 0) >= 0, `${name}: negativer Einsatz`);
      assert.ok(note.dur > 0.02 && note.dur <= 0.6, `${name}: Dauer ${note.dur} ist unpassend`);
    }
  }
});

test('Die Palette deckt alles ab, was die App melden muss', () => {
  for (const pflicht of ['send', 'receive', 'notify', 'ring', 'callStart', 'callEnd', 'join', 'leave', 'error']) {
    assert.ok(PALETTE[pflicht], `${pflicht} fehlt in der Palette`);
  }
});

/**
 * Der Kern der Gestaltung: alles kommt aus einer Fuenftonleiter. Was auch
 * immer gleichzeitig oder hintereinander erklingt, passt dann zusammen.
 */
test('Alle Toene stammen aus derselben Leiter', () => {
  const leiter = [523.25, 587.33, 659.25, 739.99, 880.00, 987.77, 1174.66];
  for (const [name, klang] of Object.entries(PALETTE)) {
    for (const note of klang.notes) {
      const treffer = leiter.some((ton) => Math.abs(ton - note.freq) < 0.5);
      assert.ok(treffer, `${name}: ${note.freq} Hz gehoert nicht zur Leiter`);
    }
  }
});

test('Kein Klang dauert laenger, als ein Hinweis dauern darf', () => {
  for (const [name, klang] of Object.entries(PALETTE)) {
    const ende = Math.max(...klang.notes.map((note) => (note.at ?? 0) + note.dur));
    assert.ok(ende <= 0.75, `${name} dauert ${ende.toFixed(2)} s - das ist kein Hinweis mehr`);
  }
});

test('Der Benachrichtigungston ist praesenter als die blosse Bestaetigung', () => {
  // Wer hinsieht, braucht kein Signal. Wer woanders ist, schon.
  assert.ok(PALETTE.notify.gain > PALETTE.receive.gain);
  assert.ok(PALETTE.receive.gain > PALETTE.send.gain);
});

test('Kommen und Gehen sind dieselbe Geste, nur umgekehrt', () => {
  const hoch = PALETTE.join.notes.map((n) => n.freq);
  const runter = PALETTE.leave.notes.map((n) => n.freq);
  assert.deepEqual(runter, [...hoch].reverse());

  const anfang = PALETTE.callStart.notes.map((n) => n.freq);
  const schluss = PALETTE.callEnd.notes.map((n) => n.freq);
  assert.deepEqual(schluss, [...anfang].reverse());
});

/**
 * Eine eigene Nachricht schickt man bewusst ab - da darf jedes Mal eine
 * Quittung kommen. Ankommende Nachrichten kommen in Schwuengen.
 */
test('Ankommendes hat eine laengere Ruhezeit als Abgeschicktes', () => {
  assert.ok(PALETTE.receive.ruhe > PALETTE.notify.ruhe);
  assert.ok(PALETTE.notify.ruhe > PALETTE.send.ruhe);
});

// --------------------------------------------------------------- Der Kanal

test('Ein abgeschalteter Ton bleibt wirklich stumm', () => {
  mitKanal((ctx) => {
    configureSound({ enabled: false });
    assert.equal(soundEnabled(), false);
    assert.equal(playSound('notify'), false);
    assert.equal(ctx.oszillatoren.length, 0, 'es wurde trotzdem ein Ton erzeugt');
  });
});

test('Ein unbekannter Klang tut gar nichts', () => {
  mitKanal((ctx) => {
    assert.equal(playSound('gibtsnicht'), false);
    assert.equal(ctx.oszillatoren.length, 0);
  });
});

/** Browser erlauben nur eine Handvoll Tonkanaele - einer muss reichen. */
test('Es wird genau ein Tonkanal angelegt, egal wie oft es klingt', () => {
  mitKanal((ctx, angelegt) => {
    for (let i = 0; i < 20; i += 1) {
      // Die Uhr weiterdrehen, damit die Ruhezeit nicht dazwischenfunkt -
      // hier geht es um den Kanal, nicht um den Abstand.
      ctx.currentTime += 10;
      playSound('receive');
    }
    assert.equal(angelegt(), 1);
    assert.ok(ctx.oszillatoren.length > 20);
  });
});

/**
 * Der Fall, um den es wirklich geht: das Telefon lag in der Tasche, das
 * Gegenueber hat zwoelf Zeilen geschickt, und beim Entsperren kommen alle in
 * einer einzigen Antwort. Zwoelf Klaenge im selben Augenblick addieren sich -
 * aus dem "psst" wuerde ein Schlag.
 */
test('Ein Schwung Nachrichten klingt einmal, nicht zwoelfmal', () => {
  mitKanal((ctx) => {
    const erster = playSound('notify');
    assert.ok(erster, 'der erste Ton kam gar nicht');
    const danach = ctx.oszillatoren.length;

    // Die Uhr muss dabei WEITERLAUFEN. Stünde sie still, bliebe unbemerkt,
    // wenn ein abgewiesener Versuch die Sperre selbst weiterschiebt - dann
    // wäre die App nach dichter Folge für immer stumm, und genau dieser Test
    // hätte es nicht gesehen.
    for (let i = 0; i < 11; i += 1) {
      ctx.currentTime += 0.15;
      assert.equal(playSound('notify'), false);
    }
    assert.equal(ctx.oszillatoren.length, danach, 'es wurden trotzdem weitere Toene erzeugt');

    // Die Ruhezeit zählt ab dem letzten Ton, der wirklich erklungen ist -
    // nicht ab dem letzten Versuch.
    ctx.currentTime = PALETTE.notify.ruhe + 0.01;
    assert.ok(playSound('notify'), 'nach der Ruhezeit blieb es stumm');
  });
});

test('Verschiedene Klaenge blockieren einander nicht', () => {
  mitKanal((ctx) => {
    assert.ok(playSound('send'));
    assert.ok(playSound('receive'), 'der zweite Klang wurde faelschlich verschluckt');
    assert.ok(playSound('join'));
    assert.ok(ctx.oszillatoren.length > 0);
  });
});

/**
 * Alle Klaenge laufen in einen gemeinsamen Punkt mit Bremse dahinter. Ohne
 * ihn haengt jeder Klang direkt am Ausgang und die Amplituden addieren sich.
 */
test('Nichts haengt direkt am Ausgang - alles laeuft durch die Bremse', () => {
  mitKanal((ctx) => {
    playSound('notify');
    const bremse = ctx.knoten.find((k) => k.art === 'bremse');
    assert.ok(bremse, 'es gibt gar keine Bremse');
    assert.ok(bremse.verbunden.includes(ctx.destination), 'die Bremse haengt nicht am Ausgang');
    assert.ok(bremse.ratio.value > 1, 'die Bremse bremst nichts');

    const direkt = ctx.knoten.filter((k) => k.verbunden?.includes(ctx.destination));
    assert.equal(direkt.length, 1, 'es haengt mehr als die Bremse direkt am Ausgang');
  });
});

test('Ohne Bremse klingt es trotzdem', () => {
  const ctx = fakeContext();
  delete ctx.createDynamicsCompressor;
  configureSound({ enabled: true, contextFactory: () => ctx });
  try {
    assert.ok(playSound('send'), 'ohne Bremse bleibt alles stumm');
    assert.ok(ctx.oszillatoren.length > 0);
  } finally {
    configureSound({ enabled: true, contextFactory: () => fakeContext() });
  }
});

/**
 * Der teuerste Fehler in dieser Datei: eine gekappte Verbindung. Die App ist
 * dann vollständig stumm, und zwar ohne jede Fehlermeldung - playSound
 * meldet weiter Erfolg, die Töne werden geplant, nur hört sie niemand.
 */
test('Jeder einzelne Ton kommt bis zum Ausgang durch', () => {
  mitKanal((ctx) => {
    playSound('ring');
    assert.ok(ctx.oszillatoren.length > 0, 'es wurde gar kein Ton erzeugt');
    for (const [i, oszillator] of ctx.oszillatoren.entries()) {
      assert.ok(
        erreicht(oszillator, ctx.destination),
        `Ton ${i} haengt in der Luft - der Signalweg zum Ausgang ist unterbrochen`,
      );
    }
  });
});

/**
 * Was den Klang zum Klang macht, steht nicht in der Palette, sondern
 * dazwischen: Wellenform, Hüllkurve, Lautstärke. Ohne diese Zusicherungen
 * überleben Änderungen, die man sofort hört - ein Sägezahn statt eines Sinus,
 * eine Oktave lauter als der Grundton, ein Ton ohne Einschwung.
 */
test('Jeder Ton ist ein Sinus mit weichem Ein- und Ausschwung', () => {
  mitKanal((ctx) => {
    playSound('receive');
    for (const oszillator of ctx.oszillatoren) {
      assert.equal(oszillator.type, 'sine', 'ein Ton ist kein Sinus - das klingelt, statt zu fluestern');
      const huelle = huelleVon(oszillator);
      assert.ok(huelle?.art === 'gain', 'ein Ton haengt an keiner Huellkurve');
      assert.equal(huelle.gain.rampen.length, 2, 'die Huellkurve hat nicht genau einen Auf- und einen Abschwung');
      const [hinauf, hinunter] = huelle.gain.rampen;
      assert.ok(hinauf.zeit > huelle.gain.gesetzt[0].zeit, 'der Einschwung dauert gar nicht');
      assert.ok(hinunter.zeit > hinauf.zeit, 'der Ausschwung liegt vor dem Einschwung');
      // Nie bis null: null waere ein Sprung, und ein Sprung ist ein Knacken.
      assert.ok(hinunter.wert > 0, 'der Ausschwung endet bei null - das knackt');
      assert.ok(hinunter.wert < 0.01, 'der Ausschwung endet viel zu laut');
    }
  });
});

test('Der Glanz bleibt leiser als der Grundton', () => {
  mitKanal((ctx) => {
    playSound('send');
    const [grund, glanz] = ctx.oszillatoren.map((o) => huelleVon(o).gain.rampen[0].wert);
    assert.ok(glanz < grund * 0.5, `der Glanz ist mit ${glanz} zu laut gegen ${grund}`);
    assert.ok(glanz > 0, 'der Glanz fehlt ganz');
  });
});

test('Die Lautstaerke aus der Palette kommt auch an', () => {
  mitKanal((ctx) => {
    for (const name of ['send', 'notify', 'error']) {
      ctx.currentTime += 10;
      playSound(name);
      const summe = ctx.knoten.filter((k) => k.art === 'gain' && k.verbunden.some((z) => z.art === 'filter')).at(-1);
      assert.equal(summe.gain.value, PALETTE[name].gain, `${name} wird mit falscher Lautstaerke gespielt`);
    }
  });
});

/**
 * Beim Klingelton sind zwei der vier Toene ausdruecklich halb so laut - das
 * macht aus zwei Einzeltoenen einen Doppelklang statt eines Zweiklangs.
 */
test('Leisere Nebentoene bleiben leiser', () => {
  mitKanal((ctx) => {
    playSound('ring');
    // Jeder zweite Oszillator ist der Glanz; die Grundtoene stehen dazwischen.
    const grundtoene = ctx.oszillatoren.filter((_, i) => i % 2 === 0).map((o) => huelleVon(o).gain.rampen[0].wert);
    const erwartet = PALETTE.ring.notes.map((n) => n.gain ?? 1);
    assert.deepEqual(grundtoene, erwartet, 'die Lautstaerken der einzelnen Toene stimmen nicht');
  });
});

test('Der Filter faerbt, statt zu pfeifen', () => {
  mitKanal((ctx) => {
    playSound('notify');
    const filter = ctx.knoten.find((k) => k.art === 'filter');
    assert.ok(filter.Q.value > 0 && filter.Q.value < 2, `Guete ${filter.Q.value} - das pfeift`);
  });
});

test('Die Bremse greift, bevor es uebersteuert', () => {
  mitKanal((ctx) => {
    playSound('notify');
    const bremse = ctx.knoten.find((k) => k.art === 'bremse');
    // Ein einzelner Klang liegt weit darunter, ein Stapel darueber.
    assert.ok(bremse.threshold.value < -6, `Schwelle ${bremse.threshold.value} dB - da greift sie nie ein`);
    assert.ok(bremse.attack.value < 0.02, 'die Bremse greift zu langsam, um eine Spitze zu fangen');
  });
});

test('Jeder Ton bekommt seinen Glanz eine Oktave darueber', () => {
  mitKanal((ctx) => {
    playSound('send');
    // Ein Ton in der Palette, zwei Oszillatoren: Grundton und Oktave.
    assert.equal(ctx.oszillatoren.length, 2);
    const [grund, glanz] = ctx.oszillatoren.map((o) => o.frequenz);
    assert.equal(glanz, grund * 2);
  });
});

test('Jeder Ton wird auch wieder gestoppt', () => {
  mitKanal((ctx) => {
    playSound('notify');
    for (const oszillator of ctx.oszillatoren) {
      assert.ok(oszillator.gestartet !== null, 'ein Ton wurde nie gestartet');
      assert.ok(oszillator.gestoppt > oszillator.gestartet, 'ein Ton laeuft ewig weiter');
    }
  });
});

/**
 * Aufgeraeumt wird auf der Uhr des Tonkanals, nicht auf der Wanduhr. Steht
 * der Kanal still - Hintergrund, iOS-Unterbrechung -, laeuft die Wanduhr
 * weiter und schnitte den Klang mitten im lautesten Moment ab.
 */
test('Aufgeraeumt wird erst, wenn der letzte Ton verklungen ist', () => {
  mitKanal((ctx) => {
    playSound('receive');
    const summe = ctx.knoten.find((k) => k.art === 'gain' && k.verbunden.some((z) => z.art === 'filter'));
    const filter = ctx.knoten.find((k) => k.art === 'filter');
    assert.ok(summe && filter);

    const toene = ctx.oszillatoren;
    for (const oszillator of toene.slice(0, -1)) oszillator.verklingen();
    assert.equal(summe.getrennt, 0, 'es wurde aufgeraeumt, waehrend noch ein Ton lief');

    toene.at(-1).verklingen();
    assert.equal(summe.getrennt, 1, 'am Ende wurde nicht aufgeraeumt');
    assert.equal(filter.getrennt, 1);
  });
});

/**
 * Der Klingelton dauert 0,7 s und wird alle 2 s wiederholt. Wer im falschen
 * Drittel annimmt, hoerte ihn sonst noch weiterlaufen, waehrend schon der
 * Ton fuer den stehenden Anruf darueberliegt.
 */
test('Ein laufender Klang laesst sich ausblenden, statt ihn abzuschneiden', () => {
  mitKanal((ctx) => {
    const griff = playSound('ring');
    assert.ok(griff && typeof griff.stop === 'function', 'es gibt keinen Griff zum Aufhoeren');

    const summe = ctx.knoten.find((k) => k.art === 'gain' && k.verbunden.some((z) => z.art === 'filter'));
    ctx.currentTime = 0.2;
    griff.stop();

    assert.equal(summe.gain.abgebrochen, 1, 'die geplante Huellkurve wurde nicht verworfen');
    const rampe = summe.gain.rampen.at(-1);
    assert.ok(rampe.wert < 0.001, 'es wird nicht auf null ausgeblendet');
    assert.ok(rampe.zeit > 0.2 && rampe.zeit < 0.3, 'das Ausblenden dauert zu lange oder gar nicht');
    // Und die Toene hoeren dann auch wirklich auf - vor ihrem geplanten Ende.
    for (const oszillator of ctx.oszillatoren) assert.ok(oszillator.gestoppt <= 0.3);
  });
});

test('Alles laeuft durch den Tiefpass - dort sitzt die Schaerfe', () => {
  mitKanal((ctx) => {
    playSound('ring');
    const filter = ctx.knoten.find((k) => k.art === 'filter');
    assert.ok(filter, 'es gibt gar keinen Filter');
    assert.equal(filter.type, 'lowpass');
    assert.ok(filter.frequency.value <= 3000);
    // Und der Fehlerton ist dumpfer als der Rest.
    const vorher = filter.frequency.value;
    playSound('error');
    const dumpf = ctx.knoten.filter((k) => k.art === 'filter').at(-1);
    assert.ok(dumpf.frequency.value < vorher, 'der Fehlerton ist nicht dumpfer');
  });
});

test('Ein angehaltener Kanal wird geweckt, nicht neu gebaut', () => {
  mitKanal((ctx, angelegt) => {
    assert.equal(ctx.resumed, 0);
    primeSound();
    assert.equal(ctx.resumed, 1);
    assert.equal(angelegt(), 1);
  }, { state: 'suspended' });
});

/**
 * Safari haelt den Kanal nach einem Telefonanruf oder Siri an und meldet
 * dabei "interrupted". Wer nur auf "suspended" schaut, bleibt danach fuer den
 * Rest der Sitzung stumm - ohne dass irgendetwas darauf hindeutet.
 */
test('Auch ein unterbrochener Kanal wird wieder geweckt', () => {
  mitKanal((ctx) => {
    primeSound();
    assert.equal(ctx.resumed, 1, 'ein unterbrochener Kanal wurde nicht geweckt');
  }, { state: 'interrupted' });
});

test('Ein geschlossener Kanal bringt nichts zum Einsturz', () => {
  mitKanal((ctx) => {
    ctx.state = 'closed';
    assert.equal(playSound('notify'), false);
    assert.equal(ctx.oszillatoren.length, 0);
    assert.doesNotThrow(() => primeSound());
    assert.equal(ctx.resumed, 0, 'ein geschlossener Kanal wurde zu wecken versucht');
  });
});

test('Wo es gar keinen Ton gibt, laeuft die App trotzdem weiter', () => {
  configureSound({ enabled: true, contextFactory: () => null });
  try {
    assert.equal(playSound('notify'), false);
    assert.doesNotThrow(() => primeSound());
  } finally {
    configureSound({ enabled: true, contextFactory: () => fakeContext() });
  }
});

test('Ein Kanal, der beim Anlegen wirft, legt die App nicht lahm', () => {
  configureSound({ enabled: true, contextFactory: () => { throw new Error('kein Ton hier'); } });
  try {
    assert.equal(playSound('send'), false);
  } finally {
    configureSound({ enabled: true, contextFactory: () => fakeContext() });
  }
});

test('Nach forgetSound faengt die Ruhezeit von vorn an', () => {
  mitKanal((ctx) => {
    assert.ok(playSound('notify'));
    assert.equal(playSound('notify'), false);
    forgetSound();
    assert.ok(playSound('notify'), 'der Kanal wurde nicht wirklich vergessen');
  });
});
