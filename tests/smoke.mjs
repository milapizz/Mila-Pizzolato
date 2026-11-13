// Prova d'insieme: apre l'app in un browser e ne percorre i flussi principali,
// sia con l'archivio nel browser sia con quello dell'account Claude (simulato).
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

// Simulazione minima delle funzioni che Claude mette a disposizione della pagina.
function fakeClaude() {
  const load = (k) => JSON.parse(localStorage.getItem(k) || '{}');
  const docs = load('fake-db'); window.__assets = load('fake-assets'); window.__saved = null;
  const persist = () => { localStorage.setItem('fake-db', JSON.stringify(docs)); localStorage.setItem('fake-assets', JSON.stringify(window.__assets)); };
  const listeners = [];
  const okSeg = (p) => p.split('/').every((x) => /^[A-Za-z0-9_\-.~:@+]+$/.test(x));
  const snap = (col) => ({ docs: Object.keys(docs).filter((k) => k.startsWith(col + '/') && !k.slice(col.length + 1).includes('/')).sort()
    .map((k) => ({ id: k.split('/').pop(), exists: true, data: () => Object.freeze(structuredClone(docs[k])) })) });
  const notify = () => { persist(); listeners.forEach((l) => setTimeout(() => l.next(snap(l.col)), 5)); };
  const doc = (p) => {
    if (!okSeg(p) || p.split('/').length % 2) throw new TypeError('bad doc path ' + p);
    return { id: p.split('/').pop(), path: p, collection: (c) => collection(p + '/' + c),
      async set(d) { docs[p] = JSON.parse(JSON.stringify(d)); notify(); }, async delete() { delete docs[p]; notify(); },
      async get() { return { exists: p in docs, data: () => docs[p] }; } };
  };
  const collection = (p) => {
    if (!okSeg(p) || p.split('/').length % 2 === 0) throw new TypeError('bad collection path ' + p);
    return { path: p, doc: (id) => doc(p + '/' + id), async get() { return snap(p); },
      onSnapshot(next) { const l = { col: p, next }; listeners.push(l); setTimeout(() => next(snap(p)), 20); return () => listeners.splice(listeners.indexOf(l), 1); } };
  };
  const ALLOWED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'video/mp4', 'video/webm', 'application/pdf', 'text/csv', 'text/markdown', 'application/json', 'text/plain'];
  const caps = {
    db: { doc, collection },
    user: { id: async () => 'u_test' },
    assets: {
      async upload(blob, o = {}) {
        const type = o.type || blob.type;
        if (!ALLOWED.includes(type)) throw { code: 'unsupported_type' };
        const id = Math.random().toString(36).slice(2).padEnd(12, '0');
        const b64 = await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result.split(',')[1]); f.readAsDataURL(blob); });
        window.__assets[id] = { b64, type }; persist();
        return { id, url: '/_blob/' + id, sizeBytes: blob.size, contentType: type };
      },
      async delete(id) { const had = id in window.__assets; delete window.__assets[id]; persist(); return { deleted: had }; },
      async list() { return { assets: [], usage: { files: 0, bytes: 0, maxFiles: 100, maxBytes: 1e9 } }; },
    },
    downloads: { async save({ filename, data }) { window.__saved = { filename, text: await data.text() }; return { status: 'saved' }; } },
  };
  window.claude = { use: async (n) => caps[n] ?? null };
}

async function run(browser, mode) {
  const cloud = mode === 'cloud';
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('dialog', () => errors.push('finestra di sistema inattesa'));
  if (cloud) {
    await page.addInitScript(fakeClaude);
    await page.route('**/_blob/*', async (route) => {
      const a = await page.evaluate((id) => window.__assets[id], route.request().url().split('/_blob/')[1].split('#')[0]);
      return a ? route.fulfill({ body: Buffer.from(a.b64, 'base64'), contentType: a.type }) : route.fulfill({ status: 404 });
    });
  }
  await page.goto(URL_);
  const shot = async (name) => shots && page.screenshot({ path: path.join(shots, `${name}-${mode}.png`) });
  const stat = (k) => page.locator('.stat', { has: page.locator('.k', { hasText: new RegExp('^' + k + '$', 'i') }) }).locator('.v').innerText();
  const yes = () => page.click('#ask [data-v="1"]');
  const norm = (s) => s.replace(/\s/g, ' ');
  await page.waitForSelector('.cal');

  // --- Il titolo è obbligatorio e l'avviso si vede sopra la finestra
  await page.click('#fab');
  await page.click('button[type=submit]');
  await page.waitForSelector('#dlg .toast.show:text("Scrivi un titolo")');

  // --- Agenda: appuntamento di lavoro con allegati e note
  await page.fill('[name=title]', 'Riunione cliente');
  await page.check('[name=sphere][value=lavoro]');
  await page.fill('[name=place]', 'Ufficio');
  await page.fill('[name=notes]', 'Presentato il preventivo, è andata bene.');
  await page.setInputFiles('#attInput', [
    { name: 'foto.png', mimeType: 'image/png', buffer: PNG },
    { name: 'appunti.txt', mimeType: 'text/plain', buffer: Buffer.from('Richiamare lunedì') },
  ]);
  assert.equal(await page.locator('#attList .tile').count(), 2);
  if (cloud) { // i tipi non ammessi vengono rifiutati subito, con una spiegazione
    await page.setInputFiles('#attInput', [{ name: 'programma.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('x') }]);
    await page.waitForSelector('#dlg .toast.show:text("non si può allegare")');
    assert.equal(await page.locator('#attList .tile').count(), 2);
  }
  await page.click('button[type=submit]');
  await page.waitForSelector('.list .item .t:text("Riunione cliente")');
  await page.waitForSelector('.item .s:text("2 allegati")');
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
  await page.waitForSelector('#viewer pre');
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
  await page.waitForFunction(() => document.querySelectorAll('.entry .tile').length === 1);
  if (cloud) assert.equal(await page.evaluate(() => Object.keys(window.__assets).length), 1, 'file rimosso anche dall\'archivio');

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
  await page.waitForSelector('.meter .fill.warn', { state: 'attached' }); // budget oltre l'80%
  assert.equal(norm(await stat('Entrate')), '2.100,50 €');
  assert.equal(norm(await stat('Spese fisse')), '800,00 €');
  assert.equal(norm(await stat('Spese variabili')), '95,30 €');
  assert.equal(norm(await stat('Disponibile')), '1.205,20 €');
  await page.check('[data-act=toggle-paid]');
  await page.waitForSelector('.stat:has-text("tutte pagate")');
  await shot('budget-mobile');
  await page.click('[data-act=nav-bmonth][data-d="-1"]'); // la spesa fissa non c'è nel mese precedente
  assert.equal(norm(await stat('Spese fisse')), '0,00 €');

  // --- I dati restano dopo il ricaricamento
  await page.reload();
  await page.click('[data-tab=agenda]');
  await page.waitForSelector('.item .t:text("Riunione cliente")');
  assert.ok(await page.locator('.cal .dot.money').count() >= 1, 'scadenza nel calendario');
  await page.click('[data-tab=budget]');
  await page.waitForSelector('.stat:has-text("tutte pagate")');

  // --- Copia di sicurezza: esporta, cancella, ripristina
  await page.click('[data-tab=altro]');
  const file = path.join(tmp, `copia-${mode}.json`);
  if (cloud) {
    await page.click('[data-act=export]');
    await page.waitForFunction(() => window.__saved);
    fs.writeFileSync(file, await page.evaluate(() => window.__saved.text));
  } else {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act=export]')]);
    await dl.saveAs(file);
  }
  const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(dump.events.length, 2);
  assert.equal(dump.attachments.length, 1);
  assert.ok(dump.attachments[0].data.startsWith('data:image/png;base64,'));
  await page.click('[data-act=wipe]');
  await yes();
  await page.waitForSelector('.toast.show:text("Dati cancellati")');
  await page.click('[data-tab=agenda]');
  assert.equal(await page.locator('.item .t').count(), 0, 'dati cancellati');
  if (cloud) assert.equal(await page.evaluate(() => Object.keys(window.__assets).length), 0, 'allegati cancellati');
  await page.click('[data-tab=altro]');
  await page.setInputFiles('#importFile', file);
  await yes();
  await page.waitForSelector('.toast.show:text("Dati ripristinati")');
  await page.click('[data-tab=diario]');
  await page.waitForFunction(() => document.querySelector('.entry .tile img')?.naturalWidth === 1);
  await page.click('[data-tab=budget]');
  assert.equal(norm(await stat('Disponibile')), '1.205,20 €');

  // --- Eliminazione con conferma
  await page.click('[data-tab=agenda]');
  await page.click('.item[data-act=open-event]:has-text("Nuoto bambini")');
  await page.click('[data-act=del-event]');
  await yes();
  await page.waitForSelector('.toast.show:text("Appuntamento eliminato")');
  assert.equal(await page.locator('.item .t:text("Nuoto bambini")').count(), 0);

  if (shots) {
    await page.setViewportSize({ width: 1280, height: 860 });
    for (const t of ['agenda', 'budget', 'altro']) { await page.click(`[data-tab=${t}]`); await page.screenshot({ path: path.join(shots, `${t}-desktop-${mode}.png`) }); }
  }
  assert.deepEqual(errors, [], 'nessun errore in console');
  await ctx.close();
  console.log(`OK (${cloud ? 'account Claude simulato' : 'archivio nel browser'})`);
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: root, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
try {
  for (const mode of ['local', 'cloud']) await run(browser, mode);
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
