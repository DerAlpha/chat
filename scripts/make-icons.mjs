/**
 * Erzeugt die PNG-Icons aus public/icons/icon.svg.
 * Braucht Chromium (kommt mit @playwright/test):  node scripts/make-icons.mjs
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = path.join(root, 'public', 'icons');
const source = await fs.readFile(path.join(iconsDir, 'icon.svg'), 'utf8');

/** maskable: Safe-Zone von 80 % - Android darf die Ecken beschneiden. */
const TARGETS = [
  { file: 'icon-192.png', size: 192, padding: 0 },
  { file: 'icon-512.png', size: 512, padding: 0 },
  { file: 'icon-maskable-512.png', size: 512, padding: 0.1 },
  { file: 'apple-touch-icon.png', size: 180, padding: 0 },
];

// In vorbereiteten Umgebungen liegt Chromium schon irgendwo - dann diesen Pfad nehmen.
const executablePath = process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  for (const target of TARGETS) {
    const page = await browser.newPage({
      viewport: { width: target.size, height: target.size },
      deviceScaleFactor: 1,
    });
    const inset = Math.round(target.size * target.padding);
    await page.setContent(
      `<style>html,body{margin:0;padding:0;background:#2f6df6}
       .wrap{width:${target.size}px;height:${target.size}px;display:grid;place-items:center}
       svg{width:${target.size - inset * 2}px;height:${target.size - inset * 2}px}</style>
       <div class="wrap">${source}</div>`,
      { waitUntil: 'load' },
    );
    await page.screenshot({ path: path.join(iconsDir, target.file), omitBackground: false });
    await page.close();
    console.log(`geschrieben: icons/${target.file} (${target.size}px)`);
  }

  // Einfarbiges Badge fuer Android-Benachrichtigungen.
  const page = await browser.newPage({ viewport: { width: 96, height: 96 } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}</style>
     <svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24" fill="none"
          stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
       <rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3"/>
     </svg>`,
    { waitUntil: 'load' },
  );
  await page.screenshot({ path: path.join(iconsDir, 'badge.png'), omitBackground: true });
  await page.close();
  console.log('geschrieben: icons/badge.png (96px)');
} finally {
  await browser.close();
}
