// Prova d'insieme: apre l'app in un browser e ne percorre i flussi principali.
// Uso: node tests/smoke.mjs   (richiede Playwright)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8765, URL_ = `http://localhost:${PORT}/`;
const shots = process.env.SHOTS;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: root, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('dialog', (d) => d.accept());
  await page.goto(URL_);
  const shot = async (name) => shots && page.screenshot({ path: path.join(shots, name + '.png') });
  const stat = (k) => page.locator('.stat', { has: page.locator('.k', { hasText: new RegExp('^' + k + '$', 'i') }) }).locator('.v').innerText();

  // --- Agenda: appuntamento di lavoro con allegati e note
  await page.click('#fab');
  await page.fill('[name=title]', 'Riunione cliente');
  await page.check('[name=sphere][value=lavoro]');
  await page.fill('[name=place]', 'Ufficio');
  await page.fill('[name=notes]', 'Presentato il preventivo, è andata bene.');
  await page.setInputFiles('#attInput', [
    { name: 'foto.png', mimeType: 'image/png', buffer: PNG },
    { name: 'appunti.txt', mimeType: 'text/plain', buffer: Buffer.from('Richiamare lunedì') },
  ]);
  assert.equal(await page.locator('#attList .tile').count(), 2);
  await page.click('button[type=submit]');
  await page.waitForSelector('.list .item .t:text("Riunione cliente")');
  assert.equal(await page.locator('.cal .day.sel .dot.lavoro').count(), 1, 'pallino lavoro sul giorno');

  // --- Appuntamento di famiglia settimanale
  await page.click('#fab');
  await page.fill('[name=title]', 'Nuoto bambini');
  await page.check('[name=sphere][value=famiglia]');
  await page.selectOption('[name=repeat]', 'weekly');
  await page.click('button[type=submit]');
  await page.waitForSelector('.item .t:text("Nuoto bambini")');
  assert.ok(await page.locator('.card:has-text("Prossimi 14 giorni") .t:text("Nuoto bambini")').count() >= 2, 'ripetizione settimanale');
  await shot('agenda-mobile');

  // --- Filtro per ambito
  await page.click('[data-sphere=famiglia]');
  assert.equal(await page.locator('.item .t:text("Riunione cliente")').count(), 0, 'lavoro nascosto');
  await page.click('[data-sphere=lavoro]');
  assert.equal(await page.locator('.item .t:text("Nuoto bambini")').count(), 0, 'famiglia nascosta');
  await page.click('[data-sphere=all]');

  // --- Diario: nota, anteprime, visualizzatore
  await page.click('[data-tab=diario]');
  await page.waitForSelector('.entry h3:text("Riunione cliente")');
  assert.equal(await page.locator('.entry').count(), 1, 'solo eventi con note/allegati');
  await page.waitForFunction(() => document.querySelector('.entry .tile img')?.naturalWidth === 1);
  await shot('diario-mobile');
  await page.click('.entry .tile:has-text("appunti.txt")');
  assert.equal(await page.locator('#viewer pre').innerText(), 'Richiamare lunedì');
  await page.click('[data-act=close-viewer]');
  await page.fill('#q', 'zzz');
  assert.equal(await page.locator('.entry').count(), 0, 'ricerca senza risultati');
  await page.fill('#q', 'preventivo');
  assert.equal(await page.locator('.entry').count(), 1, 'ricerca nelle note');

  // --- Modifica: rimuove un allegato
  await page.click('.entry h3');
  await page.click('[data-act=edit-event]');
  await page.click('#attList .tile:has-text("appunti.txt") .rm');
  await page.click('button[type=submit]');
  await page.click('[data-tab=diario]');
  assert.equal(await page.locator('.entry .tile').count(), 1, 'allegato rimosso');

  // --- Budget
  await page.click('[data-tab=budget]');
  await page.click('[data-act=new-fixed][data-kind=uscita]');
  await page.fill('[name=name]', 'Affitto');
  await page.fill('[name=amount]', '800');
  await page.click('button[type=submit]');
  await page.click('[data-act=new-fixed][data-kind=entrata]');
  await page.fill('[name=name]', 'Stipendio');
  await page.fill('[name=amount]', '2.100,50');
  await page.click('button[type=submit]');
  await page.click('#fab');
  await page.fill('[name=name]', 'Supermercato');
  await page.fill('[name=amount]', '95,30');
  await page.click('button[type=submit]');
  await page.click('[data-act=edit-budget]');
  await page.fill('[name=limit]', '100');
  await page.click('button[type=submit]');
  const norm = (s) => s.replace(/\s/g, ' ');
  assert.equal(norm(await stat('Entrate')), '2.100,50 €');
  assert.equal(norm(await stat('Spese fisse')), '800,00 €');
  assert.equal(norm(await stat('Spese variabili')), '95,30 €');
  assert.equal(norm(await stat('Disponibile')), '1.205,20 €');
  await page.waitForSelector('.meter .fill.warn', { state: 'attached' }); // budget oltre 80%
  await page.check('[data-act=toggle-paid]');
  await page.waitForSelector('.stat:has-text("tutte pagate")');
  await shot('budget-mobile');
  // la spesa fissa non c'è nel mese precedente
  await page.click('[data-act=nav-bmonth][data-d="-1"]');
  assert.equal(norm(await stat('Spese fisse')), '0,00 €');

  // --- Persistenza dopo il ricaricamento
  await page.reload();
  await page.click('[data-tab=agenda]');
  await page.waitForSelector('.item .t:text("Riunione cliente")');
  assert.equal(await page.locator('.cal .dot.money').count() >= 1, true, 'scadenza nel calendario');

  // --- Copia di sicurezza: esporta, cancella, ripristina
  await page.click('[data-tab=altro]');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act=export]')]);
  const file = path.join(tmp, 'copia.json');
  await dl.saveAs(file);
  const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(dump.events.length, 2);
  assert.equal(dump.attachments.length, 1);
  await page.click('[data-act=wipe]');
  await page.click('[data-tab=agenda]');
  assert.equal(await page.locator('.item .t').count(), 0, 'dati cancellati');
  await page.click('[data-tab=altro]');
  await page.setInputFiles('#importFile', file);
  await page.waitForSelector('.toast.show:text("Dati ripristinati")');
  await page.click('[data-tab=diario]');
  await page.waitForFunction(() => document.querySelector('.entry .tile img')?.naturalWidth === 1);

  // --- Vista desktop
  if (shots) {
    await page.setViewportSize({ width: 1280, height: 860 });
    for (const t of ['agenda', 'budget']) { await page.click(`[data-tab=${t}]`); await page.screenshot({ path: path.join(shots, t + '-desktop.png') }); }
    await page.click('[data-tab=agenda]'); await page.click('.item[data-act=open-event]');
    await page.screenshot({ path: path.join(shots, 'evento-desktop.png') });
  }
  assert.deepEqual(errors, [], 'nessun errore in console');
  console.log('OK: tutti i controlli superati');
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
