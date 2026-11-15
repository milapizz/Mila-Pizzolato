// Prova della pagina statistiche Zoho con connettori simulati.  Uso: node tests/zoho.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8766, shots = process.env.SHOTS;

function fake() {
  const now = new Date(), pad = (n) => String(n).padStart(2, '0');
  const at = (dOff, h, m = 0) => { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dOff, h, m); return d.toISOString(); };
  const results = ['Interessato', 'Non sei interessato', 'Nessuna risposta/Impegnato', 'Nessuna risposta/Impegnato', 'Richieste ulteriori informazioni', 'Richiesto servizio di richiamata', null];
  const calls = [];
  for (let d = -40; d <= 0; d++) for (let i = 0; i < ((d * -7) % 9) + 2; i++) calls.push({ id: `c${d}_${i}`, Call_Start_Time: at(d, 9 + i), Outgoing_Call_Status: i % 5 === 4 ? 'Scaduti' : 'Completato',
    Call_Result: i % 5 === 4 ? null : results[(i - d) % results.length], What_Id: { id: `90${(i * 13 - d) % 60}`, name: 'Hotel ' + i }, Owner: { name: 'Rossi', id: '1' }, Subject: 'Piano chiamate - Hotel ' + i });
  const todays = [0, 1, 2, 3].map((i) => ({ id: 't' + i, Subject: 'Piano chiamate - Hotel Bellavista ' + i, Call_Start_Time: at(0, 10, i * 8), Outgoing_Call_Status: i === 0 ? 'Completato' : 'Pianificazione',
    Call_Result: i === 0 ? 'Interessato' : null, What_Id: { id: '77' + i, name: 'Hotel Bellavista ' + i }, Who_Id: null, Description: null, Owner: { name: 'Rossi', id: '1' } }));
  const wrap = (rows) => ({ payload: { data: { data: rows, info: {} }, status: 'success' } });
  window.__q = [];
  const coql = (q) => {
    window.__q.push(q);
    const m = /limit (\d+) offset (\d+)/.exec(q), page = (rows) => (m ? rows.slice(+m[2], +m[2] + +m[1]) : rows);
    if (/from Leads where id =/.test(q)) return wrap([{ id: '771', Full_Name: 'Anna Bianchi', Nome_Hotel: 'Hotel Bellavista', Ruolo: 'Titolare', Phone: '091 123456', Mobile: '+39 333 1234567', Email: 'anna@example.com',
      City: 'Cefalù', Regione: 'Sicilia', Lead_Status: 'Caldo - 2a in programma', Numero_Stelle: 4, Numero_Stanze: 38, N_Chiamate_Fatte: 1, Description: 'Richiamare dopo le 15.' }]);
    if (/Lead_Status, COUNT/.test(q)) return wrap([['Freddo - 1a da fare', 580], [null, 710], ['Chiuso - non interessato', 71], ['Freddo - 2a in programma', 12], ['Caldo - 2a in programma', 8], ['1° contatto - no risp', 3], ['Demo in programma', 1], ['Chiuso - numero errato', 9]].map(([Lead_Status, n]) => ({ Lead_Status, 'COUNT(id)': n })));
    if (/Stato_Demo, COUNT/.test(q)) return wrap([['Prenotata', 2], ['Presentato', 6], ['Annullata', 3]].map(([Stato_Demo, n]) => ({ Stato_Demo, 'COUNT(id)': n })));
    if (/Data_Demo >=/.test(q)) return wrap([{ id: '5', Full_Name: 'Luca Verdi', Nome_Hotel: 'Resort Mare', Data_Demo: at(2, 15), Stato_Demo: 'Prenotata', Owner: { name: 'Rossi' } }]);
    if (/from Deals/.test(q)) return wrap(page([['Negoziazione', 6000], ['Negoziazione', 5500], ['Proposta inviata', 6000], ['Demo Completata', 2000], ['Contratto Firmato', 6400], ['Perso', 3000]].map(([Stage, Amount], i) => ({ id: 'd' + i, Deal_Name: 'Affare ' + i, Stage, Amount, Contact_Name: { name: 'Contatto ' + i }, Owner: { name: 'Rossi' } }))));
    if (/select Subject/.test(q)) return wrap(page(todays));
    if (/from Calls/.test(q)) return wrap(page(calls));
    return wrap([]);
  };
  const mcp = { async callTool(server, tool, input) {
    if (window.__fail === server) throw { code: 'needs_reauth', server };
    if (tool === 'getUsers') return { payload: { data: { users: [{ id: '1', full_name: 'Maria Rossi' }] } } };
    if (tool === 'getOrganization') return { payload: { data: { org: [{ domain_name: 'org123' }] } } };
    if (tool === 'executeCOQLQuery') return coql(input.body.select_query);
    if (tool === 'search_threads') return { payload: { threads: Array.from({ length: 30 }, (_, i) => ({ id: 'th' + i, messageCount: 1, messages: [{ id: 'm' + i, date: at(-(i % 20), 11), labelIds: ['SENT'] }] })) } };
    throw { code: 'not_in_manifest', server };
  } };
  window.claude = { use: async (n) => (n === 'mcp' ? mcp : null) };
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: root, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
try {
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(fake);
  await page.goto(`http://localhost:${PORT}/zoho/`);
  // Chiamate del giorno: lista, spunta, scheda cliente con link
  await page.waitForSelector('.list .row');
  assert.equal(await page.locator('.list > li').count(), 4);
  assert.ok((await page.locator('main').innerText()).includes('1 fatte su 4'));
  await page.check('.check[data-id=t1]');
  await page.waitForSelector('text=2 fatte su 4');
  await page.click('button[data-act=open][data-id=t1]');
  await page.waitForSelector('.sheet dl');
  const sheet = await page.locator('.sheet').innerText();
  assert.ok(sheet.includes('Anna Bianchi') && sheet.includes('+39 333 1234567') && sheet.includes('Richiamare dopo le 15.'));
  assert.equal(await page.locator('.sheet a.primary').getAttribute('href'), 'https://crm.zoho.eu/crm/org123/tab/Leads/771');
  if (shots) await page.screenshot({ path: path.join(shots, 'zoho-oggi.png'), fullPage: true });
  // Statistiche
  await page.click('[data-view=stat]');
  await page.waitForSelector('.chart .bar');
  await page.waitForFunction(() => document.querySelectorAll('.chart').length === 2 && !document.body.innerText.includes('Carico…'));
  const txt = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  for (const s of ['LEAD CONTATTATI', 'NON RISPOSTE', 'CONTRATTI IN CORSO', '17.500 €', 'Mail inviate al giorno', 'Resort Mare', '1394 lead in tutto']) assert.ok(txt.includes(s), 'manca: ' + s);
  assert.equal(await page.locator('.chart').first().locator('.col').count(), 30);
  if (shots) { await page.screenshot({ path: path.join(shots, 'zoho-stat.png'), fullPage: true }); await page.setViewportSize({ width: 1280, height: 900 }); await page.screenshot({ path: path.join(shots, 'zoho-stat-desktop.png'), fullPage: true }); }
  await page.click('[data-days="7"]');
  await page.waitForFunction(() => document.querySelector('.chart')?.querySelectorAll('.col').length === 7);
  // Team: niente mail, filtri senza proprietario
  await page.click('[data-scope=team]');
  await page.waitForSelector('text=solo scegliendo');
  assert.ok(await page.evaluate(() => window.__q.some((q) => /Owner is not null/.test(q))));
  // Errore di un solo connettore: resta confinato alla sua sezione
  await page.click('[data-scope=me]');
  await page.evaluate(() => { window.__fail = 'Gmail'; });
  await page.click('#refresh');
  await page.waitForSelector('.problem:has-text("Gmail è scaduto")');
  assert.equal(await page.locator('.problem').count(), 1);
  assert.deepEqual(errors, []);
  console.log('OK: statistiche Zoho');
} finally { await browser.close(); server.kill(); }
