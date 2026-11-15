/* Statistiche vendite da Zoho CRM (e mail inviate da Gmail), lette con i connettori di chi guarda la pagina. */
(() => {
  'use strict';
  const ZOHO = 'Zoho CRM', GMAIL = 'Gmail';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  // Data e ora con il fuso locale, nel formato che Zoho si aspetta.
  const iso = (d) => { const o = -d.getTimezoneOffset(), s = o < 0 ? '-' : '+', a = Math.abs(o);
    return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${s}${pad(Math.floor(a / 60))}:${pad(a % 60)}`; };
  const num = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });
  const eur = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0, useGrouping: 'always' });
  const fmt = (d, o) => new Intl.DateTimeFormat('it-IT', o).format(d);
  const hm = (s) => (s ? fmt(new Date(s), { hour: '2-digit', minute: '2-digit' }) : '');
  const dmy = (s) => (s ? fmt(new Date(s), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

  const state = { view: 'oggi', scope: 'me', days: 30, day: startOf(new Date()), open: null };
  const store = {}; // risultati per sezione: {data} oppure {error}
  let mcp, db, uid, me, org, ticksRef, settingsRef;
  let ticks = {}, settings = { host: 'crm.zoho.eu' };
  const app = $('#app');

  // ---------- Connettori ----------
  const rowsOf = (res) => {
    let p = res?.payload;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
    return p?.data?.data || p?.data?.users || p?.data?.org || [];
  };
  async function call(server, tool, input, fresh) {
    const opts = fresh ? { cache: { refresh: true } } : undefined;
    try { return await mcp.callTool(server, tool, input, opts); } catch (e) {
      if (!e?.retryable) throw e;
      await new Promise((r) => setTimeout(r, Math.min(e.retryAfterMs || 1500, 8000)));
      return mcp.callTool(server, tool, input, opts);
    }
  }
  const coql = async (q, fresh) => rowsOf(await call(ZOHO, 'executeCOQLQuery', { body: { select_query: q } }, fresh));
  async function coqlAll(q, fresh, max = 3000) {
    const out = [];
    for (let off = 0; off < max; off += 200) {
      const rows = await coql(`${q} limit 200 offset ${off}`, fresh);
      out.push(...rows);
      if (rows.length < 200) break;
    }
    return out;
  }
  function explain(e, server) {
    const s = e?.server || server;
    switch (e?.code) {
      case 'needs_reauth': return `Il collegamento con ${s} è scaduto: ricollegalo in Claude, Impostazioni → Connettori.`;
      case 'server_not_connected': case 'selection_required': case 'server_not_found': return `${s} non è collegato: aggiungilo in Claude, Impostazioni → Connettori.`;
      case 'not_in_manifest': case 'approval_required': case 'consent_required': return `Non hai dato a questa pagina il permesso di leggere ${s}.`;
      case 'blocked_by_policy': return `La tua organizzazione non permette a questa pagina di usare ${s}.`;
      case 'tool_error': return `${s} ha risposto con un errore. Riprova tra poco.`;
      default: return `Non riesco a leggere ${s} in questo momento.`;
    }
  }
  const problem = (sec) => `<div class="problem"><span>${esc(store[sec].error)}</span><button type="button" class="btn sm" data-act="retry">Riprova</button></div>`;

  // ---------- Classificazioni ----------
  const leadGroup = (st) => {
    const s = (st || '').toLowerCase();
    if (!s || s === '-none-' || /^nuovo$|non contattato|1a da fare|1a in programma/.test(s)) return 'todo';
    if (/numero errato/.test(s)) return 'bad';
    if (/non interess|no budget|lost|junk|not qualified|competitor/.test(s)) return 'no';
    if (/demo|negoziazione|proposta|lavorazione/.test(s)) return 'yes';
    if (/no risp|tentativi|\da in programma/.test(s)) return 'silent';
    return 'other';
  };
  const GROUPS = { todo: 'Da contattare', silent: 'Non hanno ancora risposto', yes: 'Interessati', no: 'Non interessati', bad: 'Numero errato', other: 'Altro' };
  const callDone = (c) => /complet/i.test(c.Outgoing_Call_Status || '') || (!!c.Call_Result && !/annull|cancel/i.test(c.Outgoing_Call_Status || ''));
  const callPending = (c) => /pianific|schedul|scadut|overdue/i.test(c.Outgoing_Call_Status || '');
  const callLate = (c) => /scadut|overdue/i.test(c.Outgoing_Call_Status || '');
  const outcome = (r) => {
    const s = (r || '').toLowerCase();
    if (!s || s === '-none-') return 'none';
    if (/non sei interess|not interested/.test(s)) return 'no';
    if (/nessuna risposta|no response|impegnato|busy/.test(s)) return 'silent';
    if (/non valido|invalid/.test(s)) return 'bad';
    if (/richiamata|call back/.test(s)) return 'callback';
    if (/ulteriori|more info/.test(s)) return 'info';
    if (/interess/.test(s)) return 'yes';
    return 'other';
  };
  const OUTCOMES = { yes: 'Interessato', info: 'Ha chiesto più informazioni', callback: 'Ha chiesto di essere richiamato', silent: 'Nessuna risposta / occupato', no: 'Non interessato', bad: 'Numero non valido', other: 'Altro esito', none: 'Esito non registrato' };
  const dealGroup = (st) => { const s = (st || '').toLowerCase(); return /firmat|won|vint/.test(s) ? 'won' : /pers|lost/.test(s) ? 'lost' : /demo/.test(s) ? 'demo' : 'open'; };

  // ---------- Caricamento ----------
  const ownerIs = (field = 'Owner') => (state.scope === 'me' ? `${field} = '${me.id}'` : `${field} is not null`);
  const periodStart = () => addDays(startOf(new Date()), -(state.days - 1));

  const loaders = {
    async leads(fresh) { return coql(`select Lead_Status, COUNT(id) from Leads where ${ownerIs()} group by Lead_Status limit 200`, fresh); },
    async demos(fresh) {
      const [byState, next] = await Promise.all([
        coql(`select Stato_Demo, COUNT(id) from Leads where Stato_Demo is not null and ${ownerIs()} group by Stato_Demo limit 50`, fresh),
        coql(`select Full_Name, Company, Nome_Hotel, Data_Demo, Stato_Demo, Owner from Leads where Data_Demo >= '${iso(startOf(new Date()))}' and ${ownerIs()} order by Data_Demo asc limit 20`, fresh),
      ]);
      return { byState, next };
    },
    async deals(fresh) { return coqlAll(`select Deal_Name, Stage, Amount, Account_Name, Contact_Name, Owner, Modified_Time from Deals where ${ownerIs()} order by Modified_Time desc`, fresh, 1000); },
    async calls(fresh) {
      const end = new Date();
      return coqlAll(`select Call_Start_Time, Outgoing_Call_Status, Call_Result, Call_Type, What_Id, Who_Id, Owner from Calls where (Call_Start_Time between '${iso(periodStart())}' and '${iso(end)}') and ${ownerIs()} order by Call_Start_Time asc`, fresh);
    },
    async mails(fresh) {
      const from = periodStart(), seen = new Map();
      const q = `in:sent after:${from.getFullYear()}/${pad(from.getMonth() + 1)}/${pad(from.getDate())}`;
      let token, pages = 0, more = false;
      do {
        const res = await call(GMAIL, 'search_threads', { query: q, pageSize: 50, view: 'THREAD_VIEW_METADATA_ONLY', ...(token ? { pageToken: token } : {}) }, fresh);
        const p = typeof res.payload === 'string' ? JSON.parse(res.payload) : res.payload || {};
        for (const t of p.threads || []) for (const m of t.messages || []) {
          if ((m.labelIds || []).includes('SENT') && new Date(m.date) >= from) seen.set(m.id, m.date);
          if ((t.messageCount || 0) > (t.messages || []).length) more = true;
        }
        token = p.nextPageToken; pages++;
      } while (token && pages < 30);
      return { dates: [...seen.values()], partial: more || !!token };
    },
    async today(fresh) {
      const a = state.day, b = new Date(a.getFullYear(), a.getMonth(), a.getDate(), 23, 59, 59);
      return coqlAll(`select Subject, Call_Start_Time, Outgoing_Call_Status, Call_Result, What_Id, Who_Id, Description, Owner from Calls where (Call_Start_Time between '${iso(a)}' and '${iso(b)}') and ${ownerIs()} order by Call_Start_Time asc`, fresh, 1000);
    },
  };
  const SERVER = { mails: GMAIL };
  const sectionsFor = () => (state.view === 'oggi' ? ['today'] : ['calls', ...(state.scope === 'me' ? ['mails'] : []), 'leads', 'demos', 'deals']);
  let loadSeq = 0;

  async function load(fresh, only) {
    const seq = ++loadSeq, secs = only || sectionsFor();
    secs.forEach((s) => { store[s] = { loading: true, data: store[s]?.data }; });
    render();
    await Promise.all(secs.map(async (s) => {
      let r;
      try { r = { data: await loaders[s](fresh) }; } catch (e) { console.error(s, e); r = { error: explain(e, SERVER[s] || ZOHO) }; }
      if (seq !== loadSeq) return;
      store[s] = r; render();
    }));
    if (seq === loadSeq) $('#fresh').textContent = `Aggiornato alle ${fmt(new Date(), { hour: '2-digit', minute: '2-digit' })} · ${state.scope === 'me' ? me.full_name || 'i tuoi dati' : 'tutto il team'}`;
  }

  // ---------- Grafici ----------
  function perDay(dates) {
    const start = periodStart(), map = new Map();
    for (let i = 0; i < state.days; i++) map.set(dayKey(addDays(start, i)), 0);
    dates.forEach((d) => { const k = dayKey(new Date(d)); if (map.has(k)) map.set(k, map.get(k) + 1); });
    return [...map.entries()].map(([k, v]) => { const d = new Date(k + 'T12:00:00'); return { k, v, d, we: d.getDay() === 0 || d.getDay() === 6 }; });
  }
  const workAvg = (days) => { const w = days.filter((x) => !x.we); return w.length ? days.reduce((s, x) => s + x.v, 0) / w.length : 0; };
  function columns(days, unit, cls = '') {
    const max = Math.max(1, ...days.map((x) => x.v)), avg = workAvg(days);
    const label = (x) => `${fmt(x.d, { weekday: 'short', day: 'numeric', month: 'short' })}: ${x.v} ${unit}`;
    return `<div class="chart ${cls}" role="img" aria-label="${esc(unit)} per giorno, media ${num.format(avg)} al giorno lavorativo">
      ${days.map((x) => `<div class="col ${x.we ? 'we' : ''}" tabindex="0" data-tip="${esc(label(x))}"><div class="bar" style="height:${(x.v / max) * 100}%"></div></div>`).join('')}
      ${avg > 0 ? `<div class="avg" style="bottom:${Math.min(100, (avg / max) * 100)}%"><span>media ${num.format(avg)}</span></div>` : ''}</div>
      <div class="axis"><span>${esc(fmt(days[0].d, { day: 'numeric', month: 'short' }))}</span><span>massimo ${max}</span><span>${esc(fmt(days[days.length - 1].d, { day: 'numeric', month: 'short' }))}</span></div>
      <details class="tbl"><summary>Vedi i numeri giorno per giorno</summary><table><tr><th>Giorno</th><th class="n">${esc(unit)}</th></tr>
      ${days.filter((x) => x.v).reverse().map((x) => `<tr><td>${esc(fmt(x.d, { weekday: 'short', day: 'numeric', month: 'short' }))}</td><td class="n">${x.v}</td></tr>`).join('') || '<tr><td colspan="2">Nessuna attività</td></tr>'}</table></details>`;
  }
  const hbar = (label, v, max, extra = '') => `<div class="hbar"><span class="lab">${esc(label)}</span><span class="track"><span class="fill" style="display:block;width:${max ? (v / max) * 100 : 0}%"></span></span><span class="num">${v}${extra}</span></div>`;
  const stat = (k, v, h = '') => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${v}</div>${h ? `<div class="h">${esc(h)}</div>` : ''}</div>`;
  const section = (sec, title, body, head = '') => {
    const s = store[sec] || { loading: true };
    return `<section class="card"><div class="card-head"><h2>${esc(title)}</h2>${head}</div>${s.error ? problem(sec) : s.data === undefined ? '<p class="empty">Carico…</p>' : body(s.data)}</section>`;
  };

  // ---------- Vista: statistiche ----------
  function viewStats() {
    const calls = store.calls?.data, leads = store.leads?.data, deals = store.deals?.data, demos = store.demos?.data, mails = store.mails?.data;
    const done = (calls || []).filter(callDone);
    const by = {}; done.forEach((c) => { const o = outcome(c.Call_Result); by[o] = (by[o] || 0) + 1; });
    const reached = new Set(done.map((c) => c.What_Id?.id || c.Who_Id?.id).filter(Boolean)).size;
    const lg = {}; (leads || []).forEach((r) => { const g = leadGroup(r.Lead_Status); lg[g] = (lg[g] || 0) + r['COUNT(id)']; });
    const totLeads = Object.values(lg).reduce((a, b) => a + b, 0);
    const dg = { open: [], demo: [], won: [], lost: [] }; (deals || []).forEach((d) => dg[dealGroup(d.Stage)].push(d));
    const sum = (a) => a.reduce((s, d) => s + (d.Amount || 0), 0);
    const demoN = (re) => (demos?.byState || []).filter((r) => re.test(r.Stato_Demo || '')).reduce((s, r) => s + r['COUNT(id)'], 0);
    const dash = '–';
    const callDays = calls ? perDay(done.map((c) => c.Call_Start_Time)) : null, mailDays = mails ? perDay(mails.dates) : null;

    const kpi = `<div class="stats six">
      ${stat('Lead contattati', calls ? reached : dash, `con ${done.length} chiamate in ${state.days} giorni`)}
      ${stat('Non risposte', calls ? by.silent || 0 : dash, 'chiamate senza risposta')}
      ${stat('Interessati', calls ? (by.yes || 0) + (by.info || 0) + (by.callback || 0) : dash, 'interessati, info o richiamo')}
      ${stat('Non interessati', calls ? by.no || 0 : dash, 'esito delle chiamate')}
      ${stat('Demo', demos ? demoN(/prenot|riprogr/i) : dash, demos ? `in programma · ${demoN(/presentat/i)} già fatte` : '')}
      ${stat('Contratti in corso', deals ? dg.open.length : dash, deals ? `${eur.format(sum(dg.open))} in trattativa` : '')}
    </div>`;

    const activity = `<div class="grid2">
      ${section('calls', 'Chiamate al giorno', () => `<div class="stats" style="grid-template-columns:1fr 1fr;margin-bottom:0">
          ${stat('Media al giorno', num.format(workAvg(callDays)), 'giorni lavorativi')}${stat('Totale', done.length, `ultimi ${state.days} giorni`)}</div>${columns(callDays, 'chiamate')}`)}
      ${state.scope === 'me' ? section('mails', 'Mail inviate al giorno', () => `<div class="stats" style="grid-template-columns:1fr 1fr;margin-bottom:0">
          ${stat('Media al giorno', num.format(workAvg(mailDays)), 'giorni lavorativi')}${stat('Totale', mails.dates.length, `ultimi ${state.days} giorni`)}</div>${columns(mailDays, 'mail', 'b')}
          <p class="small muted" style="margin-top:8px">Contate dalla posta inviata di Gmail${mails.partial ? '; nelle conversazioni molto lunghe qualche messaggio può sfuggire, quindi il numero è una stima per difetto' : ''}.</p>`)
    : '<section class="card"><div class="card-head"><h2>Mail inviate al giorno</h2></div><p class="empty">Le mail si leggono dalla tua posta Gmail, quindi sono disponibili solo scegliendo “Le mie”.</p></section>'}
    </div>`;

    const order = ['yes', 'info', 'callback', 'silent', 'no', 'bad', 'other', 'none'];
    const maxO = Math.max(1, ...Object.values(by));
    const outcomes = section('calls', `Esito delle chiamate (${state.days} giorni)`, () => (done.length
      ? order.filter((o) => by[o]).map((o) => hbar(OUTCOMES[o], by[o], maxO)).join('') + `<p class="small muted" style="margin-top:8px">${(calls || []).filter(callLate).length} chiamate pianificate nel periodo risultano scadute senza esito.</p>`
      : '<p class="empty">Nessuna chiamata completata nel periodo.</p>'));

    const leadCard = section('leads', 'Stato dei lead oggi', () => {
      const groups = {}; leads.forEach((r) => (groups[leadGroup(r.Lead_Status)] ||= []).push(r));
      const max = Math.max(1, ...leads.filter((r) => leadGroup(r.Lead_Status) !== 'todo').map((r) => r['COUNT(id)']));
      return `<p class="muted small">${totLeads} lead in tutto · ${totLeads - (lg.todo || 0)} già lavorati · ${lg.todo || 0} da contattare</p>` + Object.keys(GROUPS).filter((g) => groups[g] && g !== 'todo').map((g) => `<div class="group-title"><span>${GROUPS[g]}</span><span>${lg[g]}</span></div>
        ${groups[g].sort((a, b) => b['COUNT(id)'] - a['COUNT(id)']).map((r) => hbar(r.Lead_Status || 'Senza stato', r['COUNT(id)'], max)).join('')}`).join('')
        + (groups.todo ? `<div class="group-title"><span>${GROUPS.todo}</span><span>${lg.todo}</span></div><p class="small muted">${groups.todo.map((r) => `${esc(r.Lead_Status || 'Senza stato')}: ${r['COUNT(id)']}`).join(' · ')}</p>` : '');
    });

    const demoCard = section('demos', 'Demo', () => {
      const max = Math.max(1, ...demos.byState.map((r) => r['COUNT(id)']));
      return (demos.byState.length ? demos.byState.sort((a, b) => b['COUNT(id)'] - a['COUNT(id)']).map((r) => hbar(r.Stato_Demo, r['COUNT(id)'], max)).join('') : '<p class="empty">Nessuna demo registrata sui lead.</p>')
        + `<div class="group-title"><span>Prossime demo</span><span>${demos.next.length}</span></div>`
        + (demos.next.length ? `<ul class="list">${demos.next.map((l) => `<li><div class="row"><span class="when" style="width:92px">${esc(dmy(l.Data_Demo))}</span>
          <span class="body"><span class="t">${esc(l.Nome_Hotel || l.Company || l.Full_Name)}</span><span class="s">${esc([l.Full_Name, l.Stato_Demo, state.scope === 'team' ? l.Owner?.name : ''].filter(Boolean).join(' · '))}</span></span>
          <a class="btn sm" href="${zurl('Leads', l.id)}" target="_blank" rel="noopener">Zoho</a></div></li>`).join('')}</ul>` : '<p class="empty">Nessuna demo in calendario.</p>');
    });

    const dealCard = section('deals', 'Contratti', () => {
      const stages = {}; [...dg.demo, ...dg.open].forEach((d) => { (stages[d.Stage] ||= []).push(d); });
      const list = [...dg.open, ...dg.demo];
      return `<div class="stats" style="margin-bottom:6px">${stat('In corso', dg.open.length, eur.format(sum(dg.open)))}${stat('In fase demo', dg.demo.length, eur.format(sum(dg.demo)))}${stat('Firmati', dg.won.length, eur.format(sum(dg.won)))}</div>
        ${Object.entries(stages).map(([s, a]) => hbar(s, a.length, Math.max(...Object.values(stages).map((x) => x.length)), ` · ${eur.format(sum(a))}`)).join('')}
        <p class="small muted" style="margin:6px 0">${dg.lost.length} persi (${eur.format(sum(dg.lost))}).</p>
        ${list.length ? `<details class="tbl"><summary>Vedi i ${list.length} contratti aperti</summary><ul class="list">${list.map((d) => `<li><div class="row"><span class="body"><span class="t">${esc(d.Deal_Name)}</span>
          <span class="s">${esc([d.Stage, d.Contact_Name?.name, state.scope === 'team' ? d.Owner?.name : ''].filter(Boolean).join(' · '))}</span></span><span class="amt">${d.Amount ? eur.format(d.Amount) : ''}</span>
          <a class="btn sm" href="${zurl('Deals', d.id)}" target="_blank" rel="noopener">Zoho</a></div></li>`).join('')}</ul></details>` : ''}`;
    });

    return `${kpi}${activity}<div class="grid2">${outcomes}${leadCard}</div><div class="grid2">${demoCard}${dealCard}</div>${settingsCard()}`;
  }

  // ---------- Vista: chiamate del giorno ----------
  const zurl = (mod, id) => `https://${esc(settings.host)}/crm/${esc(org?.domain_name || '')}/tab/${mod}/${esc(id)}`;
  const tickKey = () => dayKey(state.day);
  const isTicked = (c) => !!(ticks[tickKey()] || {})[c.id];

  function viewToday() {
    const s = store.today || {};
    const isToday = dayKey(state.day) === dayKey(new Date());
    const head = `<div class="card-head daybar"><h2>${esc(fmt(state.day, { weekday: 'long', day: 'numeric', month: 'long' }))}</h2>
      ${isToday ? '' : '<button type="button" class="btn sm" data-act="day" data-d="0">Oggi</button>'}
      <button type="button" class="icon-btn" data-act="day" data-d="-1" aria-label="Giorno precedente">‹</button>
      <button type="button" class="icon-btn" data-act="day" data-d="1" aria-label="Giorno successivo">›</button></div>`;
    if (s.error) return `<section class="card">${head}${problem('today')}</section>`;
    if (!s.data) return `<section class="card">${head}<p class="empty">Carico le chiamate…</p></section>`;
    const all = s.data.filter((c) => !/annull|cancel/i.test(c.Outgoing_Call_Status || ''));
    const closed = (c) => callDone(c) || isTicked(c);
    const nDone = all.filter(closed).length;
    const item = (c) => {
      const who = c.What_Id?.name || c.Who_Id?.name || '', zDone = callDone(c), open = state.open === c.id;
      const tags = [zDone ? `<span class="tag ok">${esc(c.Call_Result || 'Completata in Zoho')}</span>` : '', !zDone && callLate(c) ? '<span class="tag late">Scaduta</span>' : '',
        state.scope === 'team' ? `<span class="tag">${esc(c.Owner?.name || '')}</span>` : ''].join(' ');
      return `<li><div class="row ${closed(c) ? 'done' : ''}">
        <input type="checkbox" class="check" data-act="tick" data-id="${esc(c.id)}" ${closed(c) ? 'checked' : ''} ${zDone ? 'disabled' : ''} aria-label="Segna come fatta: ${esc(who || c.Subject)}">
        <span class="when">${esc(hm(c.Call_Start_Time))}</span>
        <button type="button" class="body" data-act="open" data-id="${esc(c.id)}" aria-expanded="${open}"><span class="t">${esc(who || c.Subject || 'Chiamata')}</span>
          <span class="s">${esc(c.Subject || '')}</span>${tags}</button></div>${open ? sheet(c) : ''}</li>`;
    };
    return `<section class="card">${head}
      ${all.length ? `<p class="muted small">${nDone} fatte su ${all.length}</p><div class="progress"><span style="width:${(nDone / all.length) * 100}%"></span></div><ul class="list">${all.map(item).join('')}</ul>
        <p class="small muted" style="margin-top:10px">La spunta resta in questa pagina come promemoria: l'esito della chiamata va comunque registrato in Zoho.</p>`
    : '<p class="empty">Nessuna chiamata in programma per questo giorno.</p>'}</section>${settingsCard()}`;
  }

  const LEAD_FIELDS = 'Full_Name, Company, Nome_Hotel, Ruolo, Phone, Mobile, Email, Website, City, State, Regione, Lead_Status, Tipologia_di_Struttura, Numero_Stelle, Numero_Stanze, PMS_Gestionale, N_Chiamate_Fatte, Ultimo_Tentativo, Esito_Ultimo_Tentativo, Prossimo_Tentativo, Stato_Demo, Data_Demo, Description';
  const cards = {}; // scheda cliente per id
  function sheet(c) {
    const id = c.What_Id?.id || c.Who_Id?.id, k = cards[id];
    const links = `<div class="links">${id ? `<a class="btn sm primary" href="${zurl('Leads', id)}" target="_blank" rel="noopener">Apri la scheda in Zoho</a>` : ''}
      <a class="btn sm" href="${zurl('Calls', c.id)}" target="_blank" rel="noopener">Apri la chiamata in Zoho</a></div>`;
    if (!id) return `<div class="sheet">${c.Description ? `<pre>${esc(c.Description)}</pre>` : ''}${links}</div>`;
    if (!k) return `<div class="sheet"><p class="muted">Carico la scheda cliente…</p>${links}</div>`;
    if (k.error) return `<div class="sheet"><p class="muted">${esc(k.error)}</p>${links}</div>`;
    const l = k.data;
    if (!l) return `<div class="sheet"><p class="muted">Questo record non è un lead: aprilo in Zoho per i dettagli.</p>${c.Description ? `<pre>${esc(c.Description)}</pre>` : ''}${links}</div>`;
    const tel = (n) => (n ? `<a href="tel:${esc(String(n).replace(/[^\d+]/g, ''))}">${esc(n)}</a>` : '');
    const rows = [['Struttura', esc(l.Nome_Hotel || l.Company)], ['Referente', esc([l.Full_Name, l.Ruolo].filter(Boolean).join(' · '))], ['Telefono', tel(l.Phone)], ['Cellulare', tel(l.Mobile)],
      ['Email', l.Email ? `<a href="mailto:${esc(l.Email)}">${esc(l.Email)}</a>` : ''], ['Sito', esc(l.Website)], ['Dove', esc([l.City, l.State, l.Regione].filter(Boolean).join(', '))],
      ['Tipo', esc([l.Tipologia_di_Struttura, l.Numero_Stelle ? `${l.Numero_Stelle} stelle` : '', l.Numero_Stanze ? `${l.Numero_Stanze} camere` : ''].filter(Boolean).join(' · '))],
      ['Gestionale', esc(l.PMS_Gestionale)], ['Stato lead', esc(l.Lead_Status)], ['Chiamate fatte', esc(l.N_Chiamate_Fatte)],
      ['Ultimo tentativo', esc([dmy(l.Ultimo_Tentativo), l.Esito_Ultimo_Tentativo].filter(Boolean).join(' · '))], ['Prossimo tentativo', esc(dmy(l.Prossimo_Tentativo))],
      ['Demo', esc([l.Stato_Demo, dmy(l.Data_Demo)].filter(Boolean).join(' · '))]].filter(([, v]) => v);
    return `<div class="sheet"><dl>${rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')}</dl>
      ${l.Description ? `<pre>${esc(l.Description)}</pre>` : ''}${c.Description ? `<pre>${esc(c.Description)}</pre>` : ''}${links}</div>`;
  }
  async function loadCard(id) {
    if (!id || cards[id]) return;
    try { cards[id] = { data: (await coql(`select ${LEAD_FIELDS} from Leads where id = '${String(id).replace(/\D/g, '')}' limit 1`))[0] || null }; }
    catch (e) { console.error(e); cards[id] = { error: explain(e, ZOHO) }; }
    render();
  }

  const settingsCard = () => `<details class="tbl card"><summary>Impostazioni e come sono calcolati i numeri</summary>
    <form id="settings"><label class="field"><span>Indirizzo del tuo Zoho CRM (per i link)</span><input name="host" value="${esc(settings.host)}" autocomplete="off" spellcheck="false"></label>
    <button type="submit" class="btn sm">Salva</button> <span class="small muted">Se i link “Zoho” non si aprono, prova crm.zoho.com.</span></form>
    <p class="small muted" style="margin-top:10px"><b>Lead contattati</b>: lead diversi con almeno una chiamata completata nel periodo. <b>Non risposte, interessati, non interessati</b>: dall'esito registrato sulle chiamate completate.
    <b>Demo</b>: dal campo “Stato demo” dei lead. <b>Contratti in corso</b>: affari non ancora firmati né persi, esclusi quelli in fase demo. <b>Medie</b>: totale del periodo diviso per i giorni dal lunedì al venerdì.</p></details>`;

  // ---------- Disegno e azioni ----------
  function render() {
    document.querySelectorAll('#view button').forEach((b) => b.classList.toggle('on', b.dataset.view === state.view));
    document.querySelectorAll('#scope button').forEach((b) => b.classList.toggle('on', b.dataset.scope === state.scope));
    document.querySelectorAll('#period button').forEach((b) => b.classList.toggle('on', Number(b.dataset.days) === state.days));
    $('#period').hidden = state.view === 'oggi';
    const keep = document.activeElement?.name === 'host';
    if (keep) return; // non interrompere chi sta scrivendo
    app.innerHTML = state.view === 'oggi' ? viewToday() : viewStats();
  }

  async function saveTicks() {
    const k = tickKey(), done = ticks[k] || {};
    try { if (ticksRef) await ticksRef.doc(k).set({ done }); else localStorage.setItem('zoho-ticks', JSON.stringify(ticks)); } catch (e) { console.error(e); }
  }
  async function loadTicks() {
    const k = tickKey();
    if (ticks[k]) return;
    try { if (ticksRef) { const s = await ticksRef.doc(k).get(); ticks[k] = { ...(s.exists ? s.data().done : {}) }; } else ticks = JSON.parse(localStorage.getItem('zoho-ticks') || '{}'); } catch { /* resta vuoto */ }
    ticks[k] ||= {};
    render();
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button, input[data-act]'); if (!b) return;
    if (b.dataset.view) { state.view = b.dataset.view; load(); if (state.view === 'oggi') loadTicks(); return; }
    if (b.dataset.scope) { state.scope = b.dataset.scope; load(); return; }
    if (b.dataset.days) { state.days = Number(b.dataset.days); load(false, ['calls', ...(state.scope === 'me' ? ['mails'] : [])]); return; }
    if (b.id === 'refresh') { Object.keys(cards).forEach((k) => delete cards[k]); load(true); return; }
    switch (b.dataset.act) {
      case 'retry': if (me) load(true); else boot(); break;
      case 'day': state.day = b.dataset.d === '0' ? startOf(new Date()) : addDays(state.day, Number(b.dataset.d)); state.open = null; store.today = {}; load(false, ['today']); loadTicks(); break;
      case 'open': { const c = (store.today?.data || []).find((x) => x.id === b.dataset.id); state.open = state.open === b.dataset.id ? null : b.dataset.id; render(); if (c && state.open) loadCard(c.What_Id?.id || c.Who_Id?.id); break; }
      case 'tick': { const k = tickKey(); ticks[k] ||= {}; if (b.checked) ticks[k][b.dataset.id] = true; else delete ticks[k][b.dataset.id]; render(); saveTicks(); break; }
    }
  });
  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'settings') return;
    e.preventDefault();
    const host = new FormData(e.target).get('host').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9.-]+$/i.test(host)) return;
    settings = { host };
    try { if (settingsRef) await settingsRef.set(settings); else localStorage.setItem('zoho-settings', JSON.stringify(settings)); } catch (err) { console.error(err); }
    document.activeElement?.blur(); render();
  });
  // Etichetta al passaggio sulle colonne dei grafici
  const tip = $('#tip');
  const showTip = (el) => { const r = el.getBoundingClientRect(); tip.textContent = el.dataset.tip; tip.hidden = false;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 8, r.left + r.width / 2 - tip.offsetWidth / 2)) + 'px'; tip.style.top = Math.max(8, r.top - 34) + 'px'; };
  for (const ev of ['pointerover', 'focusin']) document.addEventListener(ev, (e) => { const c = e.target.closest?.('[data-tip]'); if (c) showTip(c); else tip.hidden = true; });
  document.addEventListener('focusout', () => { tip.hidden = true; });
  window.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });

  // ---------- Avvio ----------
  async function boot() {
    app.innerHTML = '<p class="empty">Mi collego a Zoho…</p>';
    mcp = typeof window.claude?.use === 'function' ? await window.claude.use('mcp') : null;
    if (!mcp) { app.innerHTML = '<p class="empty">Questa pagina legge i dati con i tuoi connettori di Claude. Aprila da Claude, con Zoho CRM collegato in Impostazioni → Connettori.</p>'; return; }
    try {
      const [u, o] = await Promise.all([call(ZOHO, 'getUsers', { query_params: { type: 'CurrentUser' } }), call(ZOHO, 'getOrganization', {})]);
      me = rowsOf(u)[0]; org = rowsOf(o)[0];
      if (!me?.id) throw { code: 'tool_error' };
    } catch (e) {
      console.error(e);
      app.innerHTML = `<div class="problem"><span>${esc(explain(e, ZOHO))}</span><button type="button" class="btn sm" data-act="retry">Riprova</button></div>`;
      return;
    }
    try {
      const [d, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
      uid = d && user ? await user.id() : null; db = uid ? d : null;
      if (db) {
        settingsRef = db.doc(`data/users/${uid}/zoho-settings`);
        ticksRef = db.doc(`data/users/${uid}/zoho`).collection('days');
        const s = await settingsRef.get(); if (s.exists && s.data().host) settings = { host: s.data().host };
      } else settings = JSON.parse(localStorage.getItem('zoho-settings') || 'null') || settings;
    } catch (e) { console.error(e); }
    loadTicks();
    load();
  }
  boot();
})();
