/**
 * Gruppen ueber die Schnittstelle - und zwar in BEIDEN Backends gleich.
 *
 * Fluesterchat laeuft entweder auf Node mit WebSocket oder auf einem
 * PHP-Webspace mit Abholen per HTTP. Der Browser kennt den Unterschied nicht
 * und darf ihn auch nicht kennen. Genau deshalb wird hier dieselbe Abfolge
 * gegen beide gefahren und Antwort fuer Antwort verglichen: eine Gruppe
 * anlegen, Plaetze einloesen, einen zweimal versuchen, und ohne Code
 * hineinzukommen versuchen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { withServer, TestClient } from '../helpers.js';

const WURZEL = path.resolve(import.meta.dirname, '../..');

const phpVorhanden = (() => {
  try {
    execFileSync('php', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let zaehler = 0;
const kennung = (name) => (`${name}${'x'.repeat(22)}`).slice(0, 22).replace(/[^A-Za-z0-9_-]/g, '_');
const frisch = (was) => kennung(`${was}${(zaehler += 1)}`);

/** Startet den PHP-Server auf einem freien Port und raeumt danach auf. */
async function withPhp(fn) {
  const docRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fluesterchat-php-gruppen-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluesterchat-php-daten-'));
  fs.cpSync(path.join(WURZEL, 'public'), docRoot, { recursive: true });
  fs.cpSync(path.join(WURZEL, 'php/api'), path.join(docRoot, 'api'), { recursive: true });
  fs.writeFileSync(
    path.join(docRoot, 'api', 'lib', 'config.local.php'),
    `<?php return ['dataDir' => '${dataDir}'];\n`,
  );
  const port = 3900 + (zaehler % 90);
  const kind = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', docRoot, path.join(WURZEL, 'php/router.php')], {
    stdio: 'ignore',
    env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4' },
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    // Warten, bis er wirklich antwortet.
    for (let versuch = 0; versuch < 100; versuch += 1) {
      try {
        const antwort = await fetch(`${base}/api/healthz`);
        if (antwort.ok) break;
      } catch { /* noch nicht da */ }
      await new Promise((weiter) => setTimeout(weiter, 100));
    }
    return await fn(base);
  } finally {
    kind.kill('SIGKILL');
    fs.rmSync(docRoot, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const postJson = async (base, pfad, rumpf) => {
  const antwort = await fetch(`${base}/api${pfad}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rumpf ?? {}),
  });
  return { status: antwort.status, body: await antwort.json().catch(() => null) };
};

const getJson = async (base, pfad) => {
  const antwort = await fetch(`${base}/api${pfad}`);
  return { status: antwort.status, body: await antwort.json().catch(() => null) };
};

/**
 * Die Abfolge, die beide Backends gleich beantworten muessen.
 * Zurueck kommt eine Zusammenfassung, die sich vergleichen laesst.
 */
async function ablauf(base) {
  const roomId = frisch('raum');
  const plaetze = [frisch('platz'), frisch('platz'), frisch('platz')];

  const angelegt = await postJson(base, '/rooms', {
    roomId,
    slots: plaetze.map((id) => ({ id, wrapped: `paket-fuer-${id}` })),
  });

  const status = await getJson(base, `/rooms/${roomId}`);

  // Ein Platz wird eingeloest ...
  const ersterClaim = await postJson(base, `/slots/${plaetze[0]}/claim`);
  // ... und weil sich noch niemand verbunden hat, geht es noch einmal.
  const wiederholt = await postJson(base, `/slots/${plaetze[0]}/claim`);

  // Ein Code, den es nie gab.
  const erfunden = await postJson(base, `/slots/${frisch('nie')}/claim`);

  // Ein zu grosser Wunsch.
  const zuGross = await postJson(base, '/rooms', {
    roomId: frisch('gross'),
    slots: Array.from({ length: 40 }, () => ({ id: frisch('p'), wrapped: 'x' })),
  });

  // Zwei gleiche Kennungen.
  const doppelt = frisch('doppel');
  const zweimal = await postJson(base, '/rooms', {
    roomId: frisch('dopraum'),
    slots: [{ id: doppelt, wrapped: 'a' }, { id: doppelt, wrapped: 'b' }],
  });

  return {
    roomId,
    plaetze,
    angelegtStatus: angelegt.status,
    kapazitaet: angelegt.body?.capacity,
    anlegerBekommtPlatz: Boolean(angelegt.body?.you?.token),
    statusKapazitaet: status.body?.capacity,
    statusIstGruppe: status.body?.group,
    claimStatus: ersterClaim.status,
    claimRaum: ersterClaim.body?.roomId === roomId,
    claimPaket: ersterClaim.body?.wrapped,
    claimHatToken: Boolean(ersterClaim.body?.you?.token),
    wiederholtStatus: wiederholt.status,
    wiederholtGleichesMitglied: wiederholt.body?.you?.id === ersterClaim.body?.you?.id,
    erfundenStatus: erfunden.status,
    erfundenFehler: erfunden.body?.error,
    zuGrossStatus: zuGross.status,
    zuGrossFehler: zuGross.body?.error,
    zweimalStatus: zweimal.status,
    zweimalFehler: zweimal.body?.error,
  };
}

test('Node beantwortet den Gruppenablauf wie erwartet', async () => {
  const ergebnis = await withServer((ctx) => ablauf(ctx.base));
  assert.deepEqual({ ...ergebnis, roomId: undefined, plaetze: undefined }, {
    roomId: undefined,
    plaetze: undefined,
    angelegtStatus: 201,
    kapazitaet: 4,
    anlegerBekommtPlatz: true,
    statusKapazitaet: 4,
    statusIstGruppe: true,
    claimStatus: 200,
    claimRaum: true,
    claimPaket: ergebnis.claimPaket,
    claimHatToken: true,
    wiederholtStatus: 200,
    wiederholtGleichesMitglied: true,
    erfundenStatus: 404,
    erfundenFehler: 'slot_unknown',
    zuGrossStatus: 400,
    zuGrossFehler: 'too_many_slots',
    zweimalStatus: 400,
    zweimalFehler: 'slot_exists',
  });
  assert.match(ergebnis.claimPaket, /^paket-fuer-/);
});

test('PHP beantwortet denselben Ablauf genauso', { skip: phpVorhanden ? false : 'PHP nicht vorhanden' }, async () => {
  const vonNode = await withServer((ctx) => ablauf(ctx.base));
  const vonPhp = await withPhp((base) => ablauf(base));

  // Raum und Plaetze sind je Lauf andere; die Pakete tragen die Kennung im
  // Namen. Alles Uebrige muss Zeichen fuer Zeichen uebereinstimmen.
  const vergleichbar = (e) => ({ ...e, roomId: undefined, plaetze: undefined, claimPaket: 'egal' });
  assert.match(vonPhp.claimPaket, /^paket-fuer-/);
  assert.deepEqual(vergleichbar(vonPhp), vergleichbar(vonNode), 'die beiden Backends antworten unterschiedlich');
});

test('Ein Zweierchat bleibt in beiden Backends ein Zweierchat', { skip: phpVorhanden ? false : 'PHP nicht vorhanden' }, async () => {
  const pruefen = async (base) => {
    const roomId = frisch('einzel');
    const angelegt = await postJson(base, '/rooms', { roomId });
    const status = await getJson(base, `/rooms/${roomId}`);
    return {
      angelegt: angelegt.status,
      anlegerBekommtPlatz: Boolean(angelegt.body?.you?.token),
      kapazitaet: status.body?.capacity,
      istGruppe: status.body?.group,
    };
  };
  const vonNode = await withServer((ctx) => pruefen(ctx.base));
  const vonPhp = await withPhp((base) => pruefen(base));
  assert.deepEqual(vonNode, {
    angelegt: 201, anlegerBekommtPlatz: false, kapazitaet: 2, istGruppe: false,
  });
  assert.deepEqual(vonPhp, vonNode);
});

/**
 * Der Beitritt ohne Code laeuft in den beiden Backends ueber verschiedene
 * Wege - Node ueber die WebSocket, PHP ueber einen Aufruf. Abgewiesen werden
 * muss er in beiden.
 */
test('Node laesst ohne Code niemanden in eine Gruppe', async () => {
  await withServer(async (ctx) => {
    const roomId = frisch('wsraum');
    const angelegt = await postJson(ctx.base, '/rooms', {
      roomId,
      slots: [{ id: frisch('wsplatz'), wrapped: 'paket' }],
    });
    assert.equal(angelegt.status, 201);

    const ohne = new TestClient(ctx, roomId, null);
    const geschlossen = await ohne.waitClose();
    assert.equal(geschlossen.reason, 'need_slot');

    // Mit dem Token des Anlegers geht es dagegen sofort.
    const mit = new TestClient(ctx, roomId, angelegt.body.you.token);
    const willkommen = await mit.next('welcome');
    assert.equal(willkommen.room.group, true);
    assert.equal(willkommen.room.capacity, 2);
    mit.close();
  });
});

test('PHP laesst ohne Code niemanden in eine Gruppe', { skip: phpVorhanden ? false : 'PHP nicht vorhanden' }, async () => {
  await withPhp(async (base) => {
    const roomId = frisch('phpraum');
    await postJson(base, '/rooms', { roomId, slots: [{ id: frisch('phpplatz'), wrapped: 'paket' }] });
    const ohne = await postJson(base, `/rooms/${roomId}/join`, {});
    assert.equal(ohne.status, 403);
    assert.equal(ohne.body?.error, 'need_slot');
  });
});
