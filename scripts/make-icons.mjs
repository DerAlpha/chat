/**
 * Erzeugt die PNG-Icons aus public/img/icon.svg.
 *
 * Der Ordner heisst bewusst img und nicht icons: Apache bringt in vielen
 * Installationen ein "Alias /icons/" auf sein eigenes Symbolverzeichnis mit,
 * das unseren Ordner sonst verdeckt (dann fehlen Favicon und App-Symbol).
 * Braucht Chromium (kommt mit @playwright/test):  node scripts/make-icons.mjs
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = path.join(root, 'public', 'img');

/**
 * Zwei Sorten von Symbolen, und sie brauchen verschiedene Platten.
 *
 * `rounded` behaelt die abgerundete Platte aus der Datei und laesst alles
 * ausserhalb durchsichtig. Das ist die Fassung, die Chrome im
 * Installationsdialog und Android im App-Umschalter unbeschnitten als Quadrat
 * zeigt - dort sollen die Ecken rund sein.
 *
 * `full` zieht die Platte bis an den Rand (rx auf 0). Das braucht, wer selbst
 * beschneidet: iOS legt seine eigene Squircle-Maske darueber, Android bei
 * "maskable" eine beliebige Form. Bei diesen beiden darf hinter der Marke
 * kein Rand bleiben, sonst schneidet die Maske ins Leere.
 *
 * Frueher lag hinter allen vier eine flache Flaeche in #2f6df6. Die Platte in
 * der Datei ist aber ein VERLAUF - ausserhalb der Rundung wurde deshalb das
 * flache Blau eingebacken, und das passt nur in der linken oberen Ecke. In den
 * anderen drei stand ein harter blauer Viertelmond im violetten Eck.
 *
 * `inset` haelt bei "maskable" den Inhalt in der Safe-Zone von 80 %, waehrend
 * die Platte weiter bis an den Rand geht. Die ganze Zeichnung zu verkleinern
 * waere falsch: dann faengt die Platte selbst erst bei 10 % an.
 */
export const TARGETS = [
  { file: 'icon-192.png', size: 192, plate: 'rounded', inset: 0 },
  { file: 'icon-512.png', size: 512, plate: 'rounded', inset: 0 },
  { file: 'icon-maskable-512.png', size: 512, plate: 'full', inset: 0.1 },
  { file: 'apple-touch-icon.png', size: 180, plate: 'full', inset: 0 },
];

/** Die Datei fuer ein Ziel zurechtlegen: Platte randfuellend, Inhalt eingerueckt. */
export function shape(svg, { plate, inset }) {
  let out = plate === 'full' ? svg.replace(/rx="\d+"/, 'rx="0"') : svg;
  if (inset > 0) {
    // Um die Mitte herum verkleinern - der Bezugsrahmen ist die 512er Leinwand
    // der Datei, nicht die Zielgroesse.
    const f = 1 - inset * 2;
    out = out.replace(
      /(<rect[^>]*\/>)([\s\S]*)(<\/svg>)/,
      `$1<g transform="translate(256 256) scale(${f}) translate(-256 -256)">$2</g>$3`,
    );
  }
  return out;
}

/**
 * Zeichnet alle Symbole. Steht in einer Funktion, damit ein Test die reinen
 * Umformungen oben prüfen kann, ohne dass dabei Chromium startet.
 */
export async function buildIcons() {
  const source = await fs.readFile(path.join(iconsDir, 'icon.svg'), 'utf8');
  // In vorbereiteten Umgebungen liegt Chromium schon irgendwo - dann diesen Pfad nehmen.
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    for (const target of TARGETS) {
      const page = await browser.newPage({
        viewport: { width: target.size, height: target.size },
        deviceScaleFactor: 1,
      });
      await page.setContent(
        `<style>html,body{margin:0;padding:0;background:transparent}
         svg{display:block;width:${target.size}px;height:${target.size}px}</style>
         ${shape(source, target)}`,
        { waitUntil: 'load' },
      );
      // Nichts unterlegen: die Datei bringt ihre Platte selbst mit, samt Verlauf.
      await page.screenshot({ path: path.join(iconsDir, target.file), omitBackground: true });
      await page.close();
      console.log(`geschrieben: img/${target.file} (${target.size}px)`);
    }

    // Einfarbiges Badge fuer Android-Benachrichtigungen. Android faerbt es selbst
    // ein und zeigt es winzig in der Statusleiste - deshalb nur die Silhouette
    // der Sprechblase, ohne Schrift: die waere dort ohnehin nicht zu lesen.
    //
    // Die viewBox ist genau der Umriss der Zeichnung, nicht ein bequemes
    // 0 0 24 24. Sonst bliebe rundherum Luft, Android verkleinert die Bitmap als
    // Ganzes in seine rund 24 dp - und uebrig bleibt ein zu kleiner, nach oben
    // verrutschter Klotz. Der Schwanz ist ausserdem laenger und breiter als am
    // grossen Symbol: bei 24 dp traegt nur, was mindestens ein Zehntel der
    // Hoehe misst.
    const page = await browser.newPage({ viewport: { width: 96, height: 96 } });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}</style>
       <svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="1 2 22 20" fill="#ffffff">
         <path d="M4 2h16a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-7l-6 5v-5H4a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3z"/>
       </svg>`,
      { waitUntil: 'load' },
    );
    await page.screenshot({ path: path.join(iconsDir, 'badge.png'), omitBackground: true });
    await page.close();
    console.log('geschrieben: img/badge.png (96px)');
  } finally {
    await browser.close();
  }
}

// Direkt aufgerufen? Dann zeichnen.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildIcons();
}
