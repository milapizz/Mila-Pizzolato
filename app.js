/* Agenda & Diario.
   Aperta da Claude salva i dati nell'account di chi la usa (privati, uguali su ogni dispositivo);
   aperta come semplice sito li salva nel browser (IndexedDB). */
(() => {
  'use strict';

  // ---------- Costanti ----------
  const SPHERES = { lavoro: 'Lavoro', famiglia: 'Famiglia' };
  const CATEGORIES = ['Casa', 'Bollette', 'Spesa alimentare', 'Trasporti', 'Salute', 'Figli e scuola',
    'Tempo libero', 'Abbonamenti', 'Assicurazioni', 'Tasse', 'Lavoro', 'Altro'];
  const REPEATS = { none: 'Non si ripete', daily: 'Ogni giorno', weekly: 'Ogni settimana', monthly: 'Ogni mese', yearly: 'Ogni anno' };
  const EVERY = { 1: 'Ogni mese', 2: 'Ogni 2 mesi', 3: 'Ogni 3 mesi', 6: 'Ogni 6 mesi', 12: 'Ogni anno' };
  const STORES = ['events', 'attachments', 'fixed', 'tx', 'budgets', 'paid'];
  const TITLES = { agenda: 'Agenda', diario: 'Diario', budget: 'Budget', altro: 'Altro' };

  // ---------- Utilità ----------
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const pad = (n) => String(n).padStart(2, '0');
  const toDS = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromDS = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d || 1); };
  const today = () => toDS(new Date());
  const addDays = (s, n) => { const d = fromDS(s); d.setDate(d.getDate() + n); return toDS(d); };
  const addMonths = (ym, n) => { const d = fromDS(ym + '-01'); d.setMonth(d.getMonth() + n); return toDS(d).slice(0, 7); };
  const daysIn = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
  const dayDiff = (a, b) => Math.round((Date.UTC(...ymd(b)) - Date.UTC(...ymd(a))) / 864e5);
  const ymd = (s) => { const [y, m, d] = s.split('-').map(Number); return [y, m - 1, d]; };
  const monthDiff = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
  const money = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', useGrouping: 'always' });
  const eur = (n) => money.format(n || 0);
  const parseAmount = (s) => { const n = parseFloat(String(s).replace(/\s|€/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN; };
  const fmtDate = (s, opts) => new Intl.DateTimeFormat('it-IT', opts).format(fromDS(s));
  const longDate = (s) => fmtDate(s, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const monthName = (ym) => fmtDate(ym + '-01', { month: 'long', year: 'numeric' });
  const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

  let toastTimer;
  function toast(msg) {
    // Dentro la finestra aperta più in alto, altrimenti resterebbe nascosto dietro.
    const t = $('#toast') || Object.assign(document.createElement('div'), { id: 'toast', className: 'toast' });
    t.setAttribute('role', 'status');
    const host = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
    if (t.parentNode !== host) host.append(t);
    t.textContent = msg; void t.offsetWidth; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // ---------- Database ----------
  let dbp;
  function openDB() {
    dbp = dbp || new Promise((res, rej) => {
      const rq = indexedDB.open('agenda-diario', 1);
      rq.onupgradeneeded = () => STORES.forEach((s) => rq.result.objectStoreNames.contains(s) || rq.result.createObjectStore(s, { keyPath: 'id' }));
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    return dbp;
  }
  async function tx(stores, mode, fn) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const t = db.transaction(stores, mode);
      let out;
      t.oncomplete = () => res(out);
      t.onerror = t.onabort = () => rej(t.error || new Error('Operazione non riuscita'));
      out = fn(t);
    });
  }
  const dbAll = (store) => tx([store], 'readonly', (t) => { const r = t.objectStore(store).getAll(); const box = []; r.onsuccess = () => box.push(...r.result); return box; });
  const dbPut = (store, obj) => tx([store], 'readwrite', (t) => { t.objectStore(store).put(obj); });
  const dbDel = (store, id) => tx([store], 'readwrite', (t) => { t.objectStore(store).delete(id); });

  // ---------- Archivio: nel browser oppure nell'account Claude ----------
  class UserError extends Error {}
  const safeId = (id) => String(id).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_');
  const MAX_FILE = 20 * 1024 * 1024;
  const EXT_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
    csv: 'text/csv', md: 'text/markdown', json: 'application/json', txt: 'text/plain' };
  const extOf = (name) => (/\.([a-z0-9]+)$/i.exec(name || '')?.[1] || '').toLowerCase();
  const cloudType = (f) => EXT_TYPES[extOf(f.name)] || (Object.values(EXT_TYPES).includes(f.type) ? f.type : f.type === 'video/quicktime' ? 'video/mp4' : '');

  const local = {
    cloud: false,
    async init() { for (const s of STORES) data[s] = await dbAll(s); },
    put: dbPut,
    del: dbDel,
    check: () => null,
    async putAtt(rec, blob) { return { ...rec, blob }; },
    async delAtt() {},
    clearAll: () => tx(STORES, 'readwrite', (t) => STORES.forEach((s) => t.objectStore(s).clear())),
  };

  const cloud = {
    cloud: true, base: null, assets: null, downloads: null,
    col(s) { return this.base.collection(s); },
    async init(onChange) {
      const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
      const uid = db && user ? await user.id() : null;
      if (!uid) return false;
      this.base = db.doc(`data/users/${uid}/agenda`);
      window.claude.use('assets').then((a) => { this.assets = a; });
      window.claude.use('downloads').then((d) => { this.downloads = d; });
      await new Promise((res, rej) => {
        const pending = new Set(STORES);
        STORES.forEach((s) => this.col(s).onSnapshot((snap) => {
          data[s] = snap.docs.map((d) => d.data());
          if (pending.delete(s) && !pending.size) res(); else if (!pending.size) onChange();
        }, rej));
      });
      return true;
    },
    put(s, obj) { return this.col(s).doc(safeId(obj.id)).set(obj); },
    del(s, id) { return this.col(s).doc(safeId(id)).delete(); },
    // Controllo fatto subito, quando si sceglie il file.
    check(f) {
      const isImg = (f.type || '').startsWith('image/') || /^image\//.test(EXT_TYPES[extOf(f.name)] || '');
      if (!isImg && !cloudType(f)) return `“${f.name}”: questo tipo di file non si può allegare. Vanno bene foto, video, PDF e file di testo.`;
      if (!isImg && f.size > MAX_FILE) return `“${f.name}” supera i 20 MB: prova con un video più breve.`;
      return null;
    },
    async putAtt(rec, blob) {
      if (!this.assets) throw new UserError('Gli allegati non sono disponibili in questo momento. Riprova tra poco.');
      let type = cloudType({ name: rec.name, type: blob.type }), name = rec.name;
      const isImg = (blob.type || '').startsWith('image/') || type.startsWith('image/');
      if (isImg && type !== 'image/svg+xml' && type !== 'image/gif' && (!type || blob.size > 2.5 * 1024 * 1024)) {
        const small = await shrinkImage(blob).catch(() => null);
        if (small) { blob = small; type = 'image/jpeg'; name = name.replace(/\.[a-z0-9]+$/i, '') + '.jpg'; }
      }
      if (!type) throw new UserError(`“${rec.name}”: formato non supportato.`);
      if (blob.size > MAX_FILE) throw new UserError(`“${rec.name}” supera i 20 MB.`);
      let r;
      try { r = await this.assets.upload(blob, { type }); } catch (e) {
        const msg = { too_large: 'supera i 20 MB', unsupported_type: 'ha un formato non supportato', quota_or_state: 'non entra: lo spazio per gli allegati è esaurito' }[e?.code];
        throw new UserError(msg ? `“${rec.name}” ${msg}.` : `Non sono riuscita a caricare “${rec.name}”. Riprova.`);
      }
      return { ...rec, name, type: r.contentType, size: r.sizeBytes, assetId: r.id };
    },
    async delAtt(att) { if (att.assetId && this.assets) await this.assets.delete(att.assetId).catch(() => {}); },
    async clearAll() {
      for (const a of data.attachments) await this.delAtt(a);
      for (const s of STORES) for (const x of data[s]) await this.del(s, x.id);
    },
  };
  let backend = local;

  // Riduce le foto grandi (e converte quelle in formati non accettati) in JPEG.
  async function shrinkImage(blob, max = 2400) {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/jpeg', 0.85));
  }

  // Conferma dentro la pagina (le finestre di sistema non sono sempre disponibili).
  function ask(msg, okLabel = 'Elimina') {
    const a = $('#ask');
    a.innerHTML = `<p>${esc(msg)}</p><div class="ask-foot"><button type="button" class="btn" data-v="0">Annulla</button><button type="button" class="btn danger" data-v="1">${esc(okLabel)}</button></div>`;
    a.returnValue = '';
    return new Promise((res) => {
      a.onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) a.close(b.dataset.v); };
      a.onclose = () => res(a.returnValue === '1');
      a.showModal();
    });
  }

  // ---------- Stato ----------
  const saved = JSON.parse(localStorage.getItem('agenda-ui') || '{}');
  const state = {
    tab: TITLES[saved.tab] ? saved.tab : 'agenda',
    sphere: saved.sphere || 'all',
    month: today().slice(0, 7),
    sel: today(),
    bmonth: today().slice(0, 7),
    q: '',
    diaryAll: false,
  };
  const data = { events: [], attachments: [], fixed: [], tx: [], budgets: [], paid: [] };
  const saveUI = () => localStorage.setItem('agenda-ui', JSON.stringify({ tab: state.tab, sphere: state.sphere }));
  const inSphere = (x) => state.sphere === 'all' || x.sphere === state.sphere;

  async function save(store, obj) {
    await backend.put(store, obj);
    const i = data[store].findIndex((x) => x.id === obj.id);
    if (i >= 0) data[store][i] = obj; else data[store].push(obj);
  }
  async function remove(store, id) {
    await backend.del(store, id);
    data[store] = data[store].filter((x) => x.id !== id);
  }

  // ---------- Logica: eventi ----------
  function occursOn(ev, ds) {
    if (ds < ev.date) return false;
    if (ev.repeat && ev.repeat !== 'none' && ev.until && ds > ev.until) return false;
    switch (ev.repeat) {
      case 'daily': return true;
      case 'weekly': return dayDiff(ev.date, ds) % 7 === 0;
      case 'monthly': return Number(ds.slice(8)) === Math.min(Number(ev.date.slice(8)), daysIn(ds.slice(0, 7)));
      case 'yearly': return ds.slice(5, 7) === ev.date.slice(5, 7) && Number(ds.slice(8)) === Math.min(Number(ev.date.slice(8)), daysIn(ds.slice(0, 7)));
      default: return ds === ev.date;
    }
  }
  const evSort = (a, b) => (a.allDay ? '' : a.start || '').localeCompare(b.allDay ? '' : b.start || '') || a.title.localeCompare(b.title);
  const eventsOn = (ds) => data.events.filter((e) => inSphere(e) && occursOn(e, ds)).sort(evSort);
  const attsOf = (eventId) => data.attachments.filter((a) => a.eventId === eventId);
  const timeLabel = (e) => (e.allDay ? 'Giorno' : e.start || '');

  // ---------- Logica: budget ----------
  function fixedInMonth(f, ym) {
    const d = monthDiff(f.start.slice(0, 7), ym);
    if (d < 0 || d % f.every !== 0) return false;
    return !(f.end && ym > f.end.slice(0, 7));
  }
  const dueDate = (f, ym) => `${ym}-${pad(Math.min(Number(f.start.slice(8)), daysIn(ym)))}`;
  const fixedOn = (ds) => data.fixed.filter((f) => inSphere(f) && fixedInMonth(f, ds.slice(0, 7)) && dueDate(f, ds.slice(0, 7)) === ds);
  const paidId = (f, ym) => `${f.id}|${ym}`;
  const isPaid = (f, ym) => data.paid.some((p) => p.id === paidId(f, ym));
  const sum = (arr) => arr.reduce((s, x) => s + x.amount, 0);

  // ---------- Allegati ----------
  const urls = new Map();
  function urlFor(att) {
    if (att.assetId) return '/_blob/' + att.assetId;
    if (!urls.has(att.id)) urls.set(att.id, URL.createObjectURL(att.blob));
    return urls.get(att.id);
  }
  const blobOf = async (att) => att.blob || (await fetch(urlFor(att))).blob();
  async function removeAtt(att) {
    await remove('attachments', att.id);
    await backend.delAtt(att);
    dropUrl(att.id);
  }
  function dropUrl(id) { if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); } }
  const kindOf = (type = '') => (type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : 'file');
  const FILE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V4.5a1 1 0 0 1 1-1Z"/><path d="M14 3.5V8h4"/></svg>';
  const AUDIO_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>';

  function tile(att, { removable = false, pendingIdx = null } = {}) {
    const k = kindOf(att.type);
    const src = pendingIdx === null ? `data-src="${esc(att.id)}"` : `src="${esc(att.url)}"`;
    const open = pendingIdx === null ? `data-act="view-att" data-id="${esc(att.id)}"` : `data-act="view-pending" data-idx="${pendingIdx}"`;
    const rm = pendingIdx === null ? `data-act="rm-att" data-id="${esc(att.id)}"` : `data-act="rm-pending" data-idx="${pendingIdx}"`;
    let inner;
    if (k === 'image') inner = `<img ${src} alt="${esc(att.name)}" loading="lazy">`;
    else if (k === 'video') inner = `<video ${src} preload="metadata" muted playsinline></video><span class="play"></span><span class="fname">${esc(att.name)}</span>`;
    else inner = `${k === 'audio' ? AUDIO_ICON : FILE_ICON}<span class="fname">${esc(att.name)}</span>`;
    return `<div class="tile" role="button" tabindex="0" ${open} aria-label="Apri ${esc(att.name)}">${inner}${removable ? `<button type="button" class="rm" ${rm} aria-label="Rimuovi ${esc(att.name)}">×</button>` : ''}</div>`;
  }
  function hydrate(root) {
    root.querySelectorAll('[data-src]').forEach((el) => {
      const att = data.attachments.find((a) => a.id === el.dataset.src);
      if (att) el.src = urlFor(att) + (el.tagName === 'VIDEO' ? '#t=0.1' : '');
      el.removeAttribute('data-src');
    });
  }

  let viewing = null;
  async function openViewer(item) {
    const { name, type, url } = item;
    viewing = item;
    const v = $('#viewer');
    const k = kindOf(type);
    let stage;
    if (k === 'image') stage = `<img src="${esc(url)}" alt="${esc(name)}">`;
    else if (k === 'video') stage = `<video src="${esc(url)}" controls autoplay playsinline></video>`;
    else if (k === 'audio') stage = `<audio src="${esc(url)}" controls autoplay></audio>`;
    else if ((type || '').startsWith('text/') || /\.(txt|md|csv|json)$/i.test(name)) stage = `<pre>${esc((await (await item.getBlob()).text()).slice(0, 200000))}</pre>`;
    else stage = `<div class="nofile">${FILE_ICON}<p>${esc(name)}</p><p class="small">Usa “Scarica” per aprirlo.</p></div>`;
    v.innerHTML = `<div class="bar"><span class="name">${esc(name)}</span>
      ${backend.cloud ? (backend.downloads ? '<button type="button" class="btn sm" data-act="dl-att">Scarica</button>' : '') : `<a class="btn sm" href="${esc(url)}" download="${esc(name)}">Scarica</a>`}
      <button type="button" class="icon-btn" data-act="close-viewer" aria-label="Chiudi">✕</button></div>
      <div class="stage">${stage}</div>`;
    v.showModal();
  }

  // ---------- Viste ----------
  const view = $('#view');

  function render() {
    document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
    document.querySelectorAll('#sphere [data-sphere]').forEach((b) => { const on = b.dataset.sphere === state.sphere; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    $('#title').textContent = TITLES[state.tab];
    $('#sphere').hidden = state.tab === 'altro';
    const fab = $('#fab');
    fab.hidden = state.tab === 'altro';
    fab.setAttribute('aria-label', state.tab === 'budget' ? 'Aggiungi movimento' : 'Aggiungi appuntamento');
    view.innerHTML = (notice ? `<p class="notice">${esc(notice)}</p>` : '') + { agenda: viewAgenda, diario: viewDiario, budget: viewBudget, altro: viewAltro }[state.tab]();
    hydrate(view);
    if (state.tab === 'altro') storageInfo();
  }

  const CHEV_L = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6 8.5 12l6 6"/></svg>';
  const CHEV_R = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 6 6 6-6 6"/></svg>';
  const monthBar = (ym, act) => `<div class="monthbar"><h2>${esc(monthName(ym))}</h2>
    <button type="button" class="btn sm" data-act="${act}" data-d="0">Oggi</button>
    <button type="button" class="icon-btn" data-act="${act}" data-d="-1" aria-label="Mese precedente">${CHEV_L}</button>
    <button type="button" class="icon-btn" data-act="${act}" data-d="1" aria-label="Mese successivo">${CHEV_R}</button></div>`;

  const eventItem = (e, ds) => {
    const n = attsOf(e.id).length;
    const sub = [e.allDay || !e.end ? '' : `fino alle ${e.end}`, e.place, n ? `${n} allegat${n === 1 ? 'o' : 'i'}` : '', e.notes ? 'con note' : ''].filter(Boolean).join(' · ');
    return `<li><button type="button" class="item" data-act="open-event" data-id="${esc(e.id)}" data-date="${ds}">
      <span class="bar ${e.sphere}"></span><span class="when">${esc(timeLabel(e))}</span>
      <span class="body"><span class="t">${esc(e.title)}</span>${sub ? `<br><span class="s">${esc(sub)}</span>` : ''}</span></button></li>`;
  };
  const dueItem = (f, ym) => {
    const paid = isPaid(f, ym);
    const out = f.kind === 'uscita';
    return `<li><div class="item ${paid ? 'paid' : ''}">
      ${out ? `<input type="checkbox" class="check" data-act="toggle-paid" data-id="${esc(f.id)}" data-ym="${ym}" ${paid ? 'checked' : ''} aria-label="Segna ${esc(f.name)} come pagata">` : '<span class="bar money"></span>'}
      <button type="button" class="item" style="padding:0" data-act="edit-fixed" data-id="${esc(f.id)}">
      <span class="body"><span class="t">${esc(f.name)}</span><br><span class="s">${out ? 'Scade' : 'Arriva'} il ${Number(dueDate(f, ym).slice(8))} · ${esc(out ? f.category : 'Entrata')} · ${esc(EVERY[f.every].toLowerCase())}</span></span>
      <span class="amt ${out ? '' : 'in'}">${out ? '' : '+'}${eur(f.amount)}</span></button></div></li>`;
  };

  function viewAgenda() {
    const ym = state.month;
    const first = fromDS(ym + '-01');
    const start = addDays(ym + '-01', -((first.getDay() + 6) % 7));
    const td = today();
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const ds = addDays(start, i);
      if (i === 35 && ds.slice(0, 7) !== ym) break;
      const evs = eventsOn(ds);
      const dots = [];
      if (evs.some((e) => e.sphere === 'lavoro')) dots.push('lavoro');
      if (evs.some((e) => e.sphere === 'famiglia')) dots.push('famiglia');
      if (fixedOn(ds).some((f) => f.kind === 'uscita')) dots.push('money');
      const cls = ['day', ds.slice(0, 7) !== ym ? 'out' : '', ds === td ? 'today' : '', ds === state.sel ? 'sel' : ''].join(' ');
      const label = `${longDate(ds)}${evs.length ? `, ${evs.length} appuntament${evs.length === 1 ? 'o' : 'i'}` : ''}`;
      cells += `<button type="button" class="${cls}" data-act="pick-day" data-date="${ds}" aria-label="${esc(label)}" ${ds === state.sel ? 'aria-current="date"' : ''}>
        <span class="n">${Number(ds.slice(8))}</span><span class="dots">${dots.map((d) => `<i class="dot ${d}"></i>`).join('')}</span></button>`;
    }
    const sel = state.sel;
    const evs = eventsOn(sel), dues = fixedOn(sel);
    const dayList = evs.length || dues.length
      ? `<ul class="list">${evs.map((e) => eventItem(e, sel)).join('')}${dues.map((f) => dueItem(f, sel.slice(0, 7))).join('')}</ul>`
      : '<p class="empty">Nessun appuntamento. Tocca + per aggiungerne uno.</p>';

    let upcoming = '';
    for (let i = 1; i <= 14; i++) {
      const ds = addDays(td, i);
      const list = eventsOn(ds);
      if (list.length) upcoming += `<li class="day-sep">${esc(fmtDate(ds, { weekday: 'long', day: 'numeric', month: 'long' }))}</li>${list.map((e) => eventItem(e, ds)).join('')}`;
    }
    return `<div class="agenda">
      <section class="card">${monthBar(ym, 'nav-month')}
        <div class="cal">${['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'].map((d) => `<div class="wd">${d}</div>`).join('')}${cells}</div>
      </section>
      <div>
        <section class="card"><div class="card-head"><h2 style="text-transform:capitalize">${esc(fmtDate(sel, { weekday: 'long', day: 'numeric', month: 'long' }))}</h2>
          <button type="button" class="btn sm" data-act="new-event">+ Nuovo</button></div>${dayList}</section>
        <section class="card"><div class="card-head"><h2>Prossimi 14 giorni</h2></div>
          ${upcoming ? `<ul class="list">${upcoming}</ul>` : '<p class="empty">Niente in programma.</p>'}</section>
      </div></div>`;
  }

  function viewDiario() {
    const td = today();
    const q = state.q.trim().toLowerCase();
    const entries = data.events
      .filter((e) => inSphere(e) && e.date <= td && (state.diaryAll || e.notes || attsOf(e.id).length))
      .filter((e) => !q || [e.title, e.notes, e.place].some((s) => (s || '').toLowerCase().includes(q)))
      .sort((a, b) => b.date.localeCompare(a.date) || evSort(a, b));
    let html = '', cur = '';
    for (const e of entries) {
      const ym = e.date.slice(0, 7);
      if (ym !== cur) { cur = ym; html += `<h2 class="month-title">${esc(monthName(ym))}</h2>`; }
      const atts = attsOf(e.id);
      html += `<article class="card entry" data-act="open-event" data-id="${esc(e.id)}" data-date="${e.date}">
        <div class="entry-head"><div class="entry-date"><b>${Number(e.date.slice(8))}</b><span>${esc(fmtDate(e.date, { weekday: 'short' }))}</span></div>
        <div><h3>${esc(e.title)}</h3><span class="tag ${e.sphere}">${SPHERES[e.sphere]}</span>${e.place ? ` <span class="small muted">${esc(e.place)}</span>` : ''}</div></div>
        ${e.notes ? `<p class="note clamp">${esc(e.notes)}</p>` : ''}
        ${atts.length ? `<div class="gallery">${atts.map((a) => tile(a)).join('')}</div>` : ''}</article>`;
    }
    return `<div class="diary-tools"><input class="search" id="q" type="search" placeholder="Cerca nel diario…" value="${esc(state.q)}" aria-label="Cerca nel diario">
      <label class="switch"><input type="checkbox" data-act="diary-all" ${state.diaryAll ? 'checked' : ''}>Mostra anche eventi senza note</label></div>
      <div id="entries">${html || `<p class="empty">${q ? 'Nessun risultato.' : 'Il diario è vuoto. Aggiungi note, foto o video a un appuntamento e lo ritroverai qui.'}</p>`}</div>`;
  }

  function viewBudget() {
    const ym = state.bmonth;
    const fixed = data.fixed.filter((f) => inSphere(f) && fixedInMonth(f, ym)).sort((a, b) => dueDate(a, ym).localeCompare(dueDate(b, ym)));
    const fOut = fixed.filter((f) => f.kind === 'uscita'), fIn = fixed.filter((f) => f.kind === 'entrata');
    const txs = data.tx.filter((t) => inSphere(t) && t.date.slice(0, 7) === ym).sort((a, b) => b.date.localeCompare(a.date));
    const tOut = txs.filter((t) => t.kind === 'uscita'), tIn = txs.filter((t) => t.kind === 'entrata');
    const income = sum(fIn) + sum(tIn), fixedTot = sum(fOut), varTot = sum(tOut);
    const left = income - fixedTot - varTot;
    const toPay = sum(fOut.filter((f) => !isPaid(f, ym)));

    const spentBy = {};
    tOut.forEach((t) => { spentBy[t.category] = (spentBy[t.category] || 0) + t.amount; });
    const cats = [...new Set([...data.budgets.map((b) => b.id), ...Object.keys(spentBy)])].sort((a, b) => CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b));
    const meters = cats.map((c) => {
      const lim = data.budgets.find((b) => b.id === c)?.limit || 0, sp = spentBy[c] || 0;
      const pct = lim ? Math.min(100, (sp / lim) * 100) : 0;
      const cls = lim && sp > lim ? 'over' : pct >= 80 ? 'warn' : '';
      return `<button type="button" class="meter" data-act="edit-budget" data-id="${esc(c)}">
        <span class="row"><span>${esc(c)}</span><span>${eur(sp)}${lim ? ` di ${eur(lim)}` : ' · nessun limite'}</span></span>
        ${lim ? `<span class="track" style="display:block"><span class="fill ${cls}" style="display:block;width:${pct}%"></span></span>` : ''}</button>`;
    }).join('');

    const txItem = (t) => `<li><button type="button" class="item" data-act="edit-tx" data-id="${esc(t.id)}"><span class="bar ${t.sphere}"></span>
      <span class="when">${Number(t.date.slice(8))} ${esc(fmtDate(t.date, { month: 'short' }))}</span>
      <span class="body"><span class="t">${esc(t.name)}</span><br><span class="s">${esc(t.kind === 'uscita' ? t.category : 'Entrata')}</span></span>
      <span class="amt ${t.kind === 'entrata' ? 'in' : ''}">${t.kind === 'entrata' ? '+' : '−'}${eur(t.amount)}</span></button></li>`;

    return `${monthBar(ym, 'nav-bmonth')}
      <div class="stats">
        <div class="stat"><div class="k">Entrate</div><div class="v">${eur(income)}</div></div>
        <div class="stat"><div class="k">Spese fisse</div><div class="v">${eur(fixedTot)}</div><div class="h">${toPay ? `${eur(toPay)} da pagare` : fOut.length ? 'tutte pagate' : ''}</div></div>
        <div class="stat"><div class="k">Spese variabili</div><div class="v">${eur(varTot)}</div></div>
        <div class="stat"><div class="k">Disponibile</div><div class="v ${left < 0 ? 'neg' : 'pos'}">${eur(left)}</div><div class="h">entrate − spese</div></div>
      </div>
      <div class="budget-grid">
        <section class="card"><div class="card-head"><h2>Spese fisse</h2><button type="button" class="btn sm" data-act="new-fixed" data-kind="uscita">+ Aggiungi</button></div>
          ${fOut.length ? `<ul class="list">${fOut.map((f) => dueItem(f, ym)).join('')}</ul>` : '<p class="empty">Affitto, mutuo, bollette, abbonamenti… aggiungile una volta e le ritrovi ogni mese.</p>'}</section>
        <section class="card"><div class="card-head"><h2>Entrate ricorrenti</h2><button type="button" class="btn sm" data-act="new-fixed" data-kind="entrata">+ Aggiungi</button></div>
          ${fIn.length ? `<ul class="list">${fIn.map((f) => dueItem(f, ym)).join('')}</ul>` : '<p class="empty">Stipendio, compensi fissi, affitti percepiti…</p>'}</section>
        <section class="card"><div class="card-head"><h2>Budget per categoria</h2><button type="button" class="btn sm" data-act="edit-budget">+ Limite</button></div>
          ${meters || '<p class="empty">Imposta un limite mensile per categoria e controlla quanto ti resta.</p>'}
          <p class="small muted" style="margin-top:8px">Calcolato sulle spese variabili del mese.</p></section>
        <section class="card"><div class="card-head"><h2>Movimenti del mese</h2><button type="button" class="btn sm" data-act="new-tx">+ Aggiungi</button></div>
          ${txs.length ? `<ul class="list">${txs.map(txItem).join('')}</ul>` : '<p class="empty">Nessun movimento registrato.</p>'}</section>
      </div>`;
  }

  function viewAltro() {
    return `<section class="card"><div class="card-head"><h2>Dove sono i miei dati</h2></div>
        ${backend.cloud
    ? '<p>Appuntamenti, budget e allegati sono salvati <b>nel tuo account Claude</b>, in uno spazio privato che vedi solo tu. Li ritrovi uguali su telefono e computer.</p>'
    : '<p>Appuntamenti, budget e allegati sono salvati <b>solo su questo dispositivo</b>, dentro il browser. Nessun server, nessun account.</p>'}
        <p class="muted small" style="margin-top:8px" id="storage">Calcolo dello spazio usato…</p></section>
      <section class="card"><div class="card-head"><h2>Copia di sicurezza</h2></div>
        <p class="muted" style="margin-bottom:12px">${backend.cloud ? 'Scarica un file con tutti i dati, da conservare per sicurezza.' : 'Scarica un file con tutti i dati per conservarli o portarli su un altro dispositivo. Fallo ogni tanto: se cancelli i dati del browser, l\'agenda si svuota.'}</p>
        <label class="inline"><input type="checkbox" id="withAtt" checked>Includi gli allegati (file più grande)</label>
        <div style="display:flex;gap:10px;flex-wrap:wrap"><button type="button" class="btn primary" data-act="export">Scarica copia</button>
        <label class="btn">Ripristina da file<input type="file" id="importFile" accept="application/json,.json" hidden></label></div></section>
      <section class="card"><div class="card-head"><h2>Cancella tutto</h2></div>
        <p class="muted" style="margin-bottom:12px">Elimina definitivamente appuntamenti, diario, budget e allegati.</p>
        <button type="button" class="btn danger" data-act="wipe">Cancella tutti i dati</button></section>`;
  }
  async function storageInfo() {
    const el = $('#storage'); if (!el) return;
    const attBytes = data.attachments.reduce((s, a) => s + (a.size || 0), 0);
    let txt = `${data.events.length} appuntamenti · ${data.attachments.length} allegati (${fmtSize(attBytes)})`;
    try {
      if (backend.cloud) {
        const u = (await backend.assets?.list())?.usage;
        if (u?.maxBytes) txt += ` · spazio per gli allegati: ${fmtSize(u.bytes)} usati su ${fmtSize(u.maxBytes)}`;
      } else {
        const est = await navigator.storage.estimate();
        if (est.quota) txt += ` · spazio disponibile nel browser: circa ${fmtSize(est.quota - (est.usage || 0))}`;
      }
    } catch { /* non disponibile */ }
    if ($('#storage')) $('#storage').textContent = txt;
  }

  // ---------- Finestre ----------
  const dlg = $('#dlg');
  let draft = null; // allegati in attesa nel modulo evento

  function sheet(title, body, foot = '') {
    dlg.innerHTML = `<div class="sheet-head"><h2>${title}</h2><button type="button" class="icon-btn" data-act="close-dlg" aria-label="Chiudi">✕</button></div>${body}${foot}`;
    if (!dlg.open) dlg.showModal();
    dlg.scrollTop = 0;
    hydrate(dlg);
  }
  function closeDlg() {
    if (draft) { draft.add.forEach((p) => URL.revokeObjectURL(p.url)); draft = null; }
    if (dlg.open) dlg.close();
  }
  dlg.addEventListener('close', () => { if (draft) closeDlg(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg && !dlg.querySelector('form')) closeDlg(); });

  const sphereChoice = (val) => `<span class="legend">Ambito</span><div class="choice">
    ${Object.entries(SPHERES).map(([k, l]) => `<label><input type="radio" name="sphere" value="${k}" ${val === k ? 'checked' : ''}><span class="${k}"><i class="dot ${k}"></i>${l}</span></label>`).join('')}</div>`;
  const options = (map, val) => Object.entries(map).map(([k, l]) => `<option value="${esc(k)}" ${String(val) === String(k) ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const catOptions = (val) => CATEGORIES.map((c) => `<option ${c === val ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const defSphere = () => (state.sphere === 'all' ? 'famiglia' : state.sphere);
  const formFoot = (isEdit, delAct, id) => `<div class="sheet-foot">${isEdit ? `<button type="button" class="btn danger" data-act="${delAct}" data-id="${esc(id)}">Elimina</button>` : ''}
    <span class="grow"></span><button type="button" class="btn" data-act="close-dlg">Annulla</button><button type="submit" class="btn primary">Salva</button></div>`;

  function showEvent(id, ds) {
    const e = data.events.find((x) => x.id === id); if (!e) return;
    const atts = attsOf(e.id);
    const when = e.allDay ? 'Tutto il giorno' : [e.start, e.end].filter(Boolean).join(' – ');
    sheet(esc(e.title), `<div class="sheet-body">
      <span class="tag ${e.sphere}"><i class="dot ${e.sphere}"></i>${SPHERES[e.sphere]}</span>
      <div class="detail-meta"><span style="text-transform:capitalize">${esc(longDate(ds || e.date))}${when ? ` · ${esc(when)}` : ''}</span>
        ${e.repeat && e.repeat !== 'none' ? `<span>${esc(REPEATS[e.repeat])}${e.until ? ` fino al ${esc(fmtDate(e.until, { day: 'numeric', month: 'long', year: 'numeric' }))}` : ''}</span>` : ''}
        ${e.place ? `<span>${esc(e.place)}</span>` : ''}</div>
      ${e.notes ? `<div class="detail-note">${esc(e.notes)}</div>` : '<p class="muted small">Nessuna nota. Tocca “Modifica” per scrivere il diario di questo evento.</p>'}
      ${atts.length ? `<div class="gallery">${atts.map((a) => tile(a)).join('')}</div>` : ''}</div>
      <div class="sheet-foot"><button type="button" class="btn danger" data-act="del-event" data-id="${esc(e.id)}">Elimina</button><span class="grow"></span>
      <button type="button" class="btn primary" data-act="edit-event" data-id="${esc(e.id)}">Modifica</button></div>`);
  }

  function eventForm(id, date) {
    const e = data.events.find((x) => x.id === id) || { title: '', sphere: defSphere(), date: date || today(), allDay: false, start: '09:00', end: '10:00', place: '', repeat: 'none', until: '', notes: '' };
    draft = draft && draft.id === (id || null) ? draft : { id: id || null, add: [], remove: new Set() };
    const atts = id ? attsOf(id).filter((a) => !draft.remove.has(a.id)) : [];
    sheet(id ? 'Modifica appuntamento' : 'Nuovo appuntamento', `<form data-form="event" data-id="${esc(id || '')}" novalidate><div class="sheet-body">
      <label class="field"><span>Titolo</span><input name="title" required maxlength="120" value="${esc(e.title)}" placeholder="Es. Riunione con il cliente" autocomplete="off"></label>
      ${sphereChoice(e.sphere)}
      <label class="field"><span>Data</span><input type="date" name="date" required value="${esc(e.date)}"></label>
      <label class="inline"><input type="checkbox" name="allDay" ${e.allDay ? 'checked' : ''} data-act="toggle-allday">Tutto il giorno</label>
      <div class="row2" id="times" ${e.allDay ? 'hidden' : ''}><label class="field"><span>Inizio</span><input type="time" name="start" value="${esc(e.start || '')}"></label>
        <label class="field"><span>Fine</span><input type="time" name="end" value="${esc(e.end || '')}"></label></div>
      <label class="field"><span>Luogo</span><input name="place" maxlength="160" value="${esc(e.place || '')}" autocomplete="off"></label>
      <div class="row2"><label class="field"><span>Ripetizione</span><select name="repeat">${options(REPEATS, e.repeat || 'none')}</select></label>
        <label class="field"><span>Fino al (facoltativo)</span><input type="date" name="until" value="${esc(e.until || '')}"></label></div>
      <label class="field"><span>Note e diario</span><textarea name="notes" placeholder="Com'è andata? Scrivi qui pensieri, appunti, ricordi…">${esc(e.notes || '')}</textarea></label>
      <span class="legend">Allegati</span>
      <div class="gallery" id="attList" style="margin-top:0">${attListHTML(atts)}</div>
      <label class="btn" style="margin-top:10px">+ Foto, video o file<input type="file" id="attInput" multiple hidden></label>
      <p class="small muted" style="margin-top:6px">${backend.cloud ? 'Foto, video (fino a 20 MB l\'uno), PDF e file di testo.' : 'Dal telefono puoi anche scattare una foto o girare un video al momento.'}</p>
      </div>${formFoot(!!id, 'del-event', id)}</form>`);
  }
  const attListHTML = (atts) => atts.map((a) => tile(a, { removable: true })).join('') + draft.add.map((p, i) => tile(p, { removable: true, pendingIdx: i })).join('');
  function refreshAttList() {
    const box = $('#attList'); if (!box || !draft) return;
    box.innerHTML = attListHTML(draft.id ? attsOf(draft.id).filter((a) => !draft.remove.has(a.id)) : []);
    hydrate(box);
  }

  function fixedForm(id, kind) {
    const f = data.fixed.find((x) => x.id === id) || { kind: kind || 'uscita', name: '', amount: '', category: 'Casa', sphere: defSphere(), every: 1, start: state.bmonth + '-01', end: '' };
    const out = f.kind === 'uscita';
    sheet(`${id ? 'Modifica' : 'Nuova'} ${out ? 'spesa fissa' : 'entrata ricorrente'}`, `<form data-form="fixed" data-id="${esc(id || '')}" data-kind="${f.kind}" novalidate><div class="sheet-body">
      <label class="field"><span>Nome</span><input name="name" required maxlength="80" value="${esc(f.name)}" placeholder="${out ? 'Es. Affitto' : 'Es. Stipendio'}" autocomplete="off"></label>
      <label class="field"><span>Importo (€)</span><input name="amount" required inputmode="decimal" value="${f.amount === '' ? '' : String(f.amount).replace('.', ',')}" placeholder="0,00" autocomplete="off"></label>
      ${out ? `<label class="field"><span>Categoria</span><select name="category">${catOptions(f.category)}</select></label>` : ''}
      ${sphereChoice(f.sphere)}
      <div class="row2"><label class="field"><span>Frequenza</span><select name="every">${options(EVERY, f.every)}</select></label>
        <label class="field"><span>${out ? 'Prima scadenza' : 'Primo accredito'}</span><input type="date" name="start" required value="${esc(f.start)}"></label></div>
      <label class="field"><span>Termina il (facoltativo)</span><input type="date" name="end" value="${esc(f.end || '')}"></label>
      </div>${formFoot(!!id, 'del-fixed', id)}</form>`);
  }

  function txForm(id) {
    const d = state.bmonth === today().slice(0, 7) ? today() : state.bmonth + '-01';
    const t = data.tx.find((x) => x.id === id) || { kind: 'uscita', name: '', amount: '', category: 'Spesa alimentare', sphere: defSphere(), date: d };
    sheet(id ? 'Modifica movimento' : 'Nuovo movimento', `<form data-form="tx" data-id="${esc(id || '')}" novalidate><div class="sheet-body">
      <span class="legend">Tipo</span><div class="choice">
        <label><input type="radio" name="kind" value="uscita" ${t.kind === 'uscita' ? 'checked' : ''}><span>Spesa</span></label>
        <label><input type="radio" name="kind" value="entrata" ${t.kind === 'entrata' ? 'checked' : ''}><span>Entrata</span></label></div>
      <label class="field"><span>Descrizione</span><input name="name" required maxlength="80" value="${esc(t.name)}" placeholder="Es. Supermercato" autocomplete="off"></label>
      <div class="row2"><label class="field"><span>Importo (€)</span><input name="amount" required inputmode="decimal" value="${t.amount === '' ? '' : String(t.amount).replace('.', ',')}" placeholder="0,00" autocomplete="off"></label>
        <label class="field"><span>Data</span><input type="date" name="date" required value="${esc(t.date)}"></label></div>
      <label class="field"><span>Categoria (per le spese)</span><select name="category">${catOptions(t.category)}</select></label>
      ${sphereChoice(t.sphere)}
      </div>${formFoot(!!id, 'del-tx', id)}</form>`);
  }

  function budgetForm(cat) {
    const b = data.budgets.find((x) => x.id === cat);
    sheet('Limite mensile', `<form data-form="budget" novalidate><div class="sheet-body">
      <label class="field"><span>Categoria</span><select name="category">${catOptions(cat || 'Spesa alimentare')}</select></label>
      <label class="field"><span>Limite al mese (€)</span><input name="limit" inputmode="decimal" value="${b ? String(b.limit).replace('.', ',') : ''}" placeholder="0,00" autocomplete="off"></label>
      <p class="small muted">Lascia vuoto o metti 0 per togliere il limite.</p>
      </div>${formFoot(false)}</form>`);
  }

  // ---------- Salvataggi ----------
  function fail(form, name, msg) {
    toast(msg);
    form.elements[name]?.focus?.();
    return false;
  }

  const submit = {
    async event(form, fd) {
      const title = fd.get('title').trim();
      if (!title) return fail(form, 'title', 'Scrivi un titolo');
      if (!fd.get('date')) return fail(form, 'date', 'Scegli una data');
      const allDay = fd.get('allDay') === 'on';
      const start = fd.get('start'), end = fd.get('end');
      if (!allDay && start && end && end < start) return fail(form, 'end', "La fine è prima dell'inizio");
      if (fd.get('until') && fd.get('until') < fd.get('date')) return fail(form, 'until', 'La ripetizione finisce prima della data');
      const id = form.dataset.id || uid();
      const old = data.events.find((x) => x.id === id);
      const ev = { id, title, sphere: fd.get('sphere') || 'famiglia', date: fd.get('date'), allDay, start: allDay ? '' : start, end: allDay ? '' : end,
        place: fd.get('place').trim(), repeat: fd.get('repeat'), until: fd.get('until') || '', notes: fd.get('notes').trim(),
        createdAt: old?.createdAt || Date.now(), updatedAt: Date.now() };
      const d = draft;
      await save('events', ev);
      form.dataset.id = id; d.id = id; // se un allegato non passa, riprovando non si crea un doppione
      state.sel = ev.date; state.month = ev.date.slice(0, 7);
      for (const aid of [...d.remove]) { const a = data.attachments.find((x) => x.id === aid); if (a) await removeAtt(a); d.remove.delete(aid); }
      while (d.add.length) {
        const p = d.add[0];
        if (d.add.length > 1 || p.blob.size > 1e6) toast(`Carico “${p.name}”…`);
        try {
          await save('attachments', await backend.putAtt({ id: uid(), eventId: id, name: p.name, type: p.type, size: p.blob.size, createdAt: Date.now() }, p.blob));
        } catch (err) { refreshAttList(); render(); throw err; }
        URL.revokeObjectURL(d.add.shift().url);
      }
      toast('Appuntamento salvato');
      return true;
    },
    async fixed(form, fd) {
      const name = fd.get('name').trim(), amount = parseAmount(fd.get('amount'));
      if (!name) return fail(form, 'name', 'Scrivi un nome');
      if (!(amount > 0)) return fail(form, 'amount', 'Inserisci un importo valido');
      if (!fd.get('start')) return fail(form, 'start', 'Scegli la data');
      if (fd.get('end') && fd.get('end') < fd.get('start')) return fail(form, 'end', "La fine è prima dell'inizio");
      const kind = form.dataset.kind;
      await save('fixed', { id: form.dataset.id || uid(), kind, name, amount, category: kind === 'uscita' ? fd.get('category') : '', sphere: fd.get('sphere') || 'famiglia',
        every: Number(fd.get('every')), start: fd.get('start'), end: fd.get('end') || '' });
      toast('Salvato');
      return true;
    },
    async tx(form, fd) {
      const name = fd.get('name').trim(), amount = parseAmount(fd.get('amount'));
      if (!name) return fail(form, 'name', 'Scrivi una descrizione');
      if (!(amount > 0)) return fail(form, 'amount', 'Inserisci un importo valido');
      if (!fd.get('date')) return fail(form, 'date', 'Scegli una data');
      await save('tx', { id: form.dataset.id || uid(), kind: fd.get('kind'), name, amount, category: fd.get('category'), sphere: fd.get('sphere') || 'famiglia', date: fd.get('date') });
      state.bmonth = fd.get('date').slice(0, 7);
      toast('Movimento salvato');
      return true;
    },
    async budget(form, fd) {
      const raw = fd.get('limit').trim(), limit = raw ? parseAmount(raw) : 0;
      if (Number.isNaN(limit) || limit < 0) return fail(form, 'limit', 'Inserisci un importo valido');
      if (limit > 0) await save('budgets', { id: fd.get('category'), limit }); else await remove('budgets', fd.get('category'));
      return true;
    },
  };

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form]'); if (!form) return;
    e.preventDefault();
    if (form.dataset.busy) return;
    form.dataset.busy = '1';
    try {
      if (await submit[form.dataset.form](form, new FormData(form))) { closeDlg(); render(); }
    } catch (err) {
      console.error(err);
      toast(err instanceof UserError ? err.message : err?.name === 'QuotaExceededError' ? 'Spazio esaurito sul dispositivo: allegato troppo grande'
        : err?.code === 'quota_exceeded' ? 'Spazio esaurito: elimina qualcosa e riprova' : 'Salvataggio non riuscito. Riprova.');
    } finally { delete form.dataset.busy; }
  });

  // ---------- Azioni ----------
  async function deleteEvent(id) {
    for (const a of attsOf(id)) await removeAtt(a);
    await remove('events', id);
  }

  async function wipeAll() {
    await backend.clearAll();
    [...urls.keys()].forEach(dropUrl);
    STORES.forEach((s) => { data[s] = []; });
  }

  const actions = {
    'pick-day': (el) => { state.sel = el.dataset.date; state.month = state.sel.slice(0, 7); render(); },
    'nav-month': (el) => { const d = Number(el.dataset.d); state.month = d ? addMonths(state.month, d) : today().slice(0, 7); if (!d) state.sel = today(); render(); },
    'nav-bmonth': (el) => { const d = Number(el.dataset.d); state.bmonth = d ? addMonths(state.bmonth, d) : today().slice(0, 7); render(); },
    'new-event': () => eventForm(null, state.tab === 'agenda' ? state.sel : today()),
    'open-event': (el) => showEvent(el.dataset.id, el.dataset.date),
    'edit-event': (el) => eventForm(el.dataset.id),
    'del-event': async (el) => { if (!(await ask('Eliminare questo appuntamento con le sue note e i suoi allegati?'))) return; await deleteEvent(el.dataset.id); closeDlg(); render(); toast('Appuntamento eliminato'); },
    'toggle-allday': (el) => { $('#times').hidden = el.checked; return 'keep'; },
    'view-att': (el) => { const a = data.attachments.find((x) => x.id === el.dataset.id); if (a) openViewer({ name: a.name, type: a.type, url: urlFor(a), getBlob: () => blobOf(a) }); },
    'dl-att': async () => {
      if (!viewing) return;
      try { await backend.downloads.save({ filename: viewing.name, data: await viewing.getBlob() }); } catch (e) { if (e?.code !== 'declined') toast('Download non riuscito'); }
    },
    'view-pending': (el) => { const p = draft?.add[el.dataset.idx]; if (p) openViewer({ ...p, getBlob: async () => p.blob }); },
    'rm-att': (el) => { draft.remove.add(el.dataset.id); refreshAttList(); },
    'rm-pending': (el) => { const [p] = draft.add.splice(Number(el.dataset.idx), 1); URL.revokeObjectURL(p.url); refreshAttList(); },
    'close-viewer': () => $('#viewer').close(),
    'close-dlg': () => closeDlg(),
    'diary-all': (el) => { state.diaryAll = el.checked; render(); return 'keep'; },
    'new-fixed': (el) => fixedForm(null, el.dataset.kind),
    'edit-fixed': (el) => fixedForm(el.dataset.id),
    'del-fixed': async (el) => { if (!(await ask('Eliminare questa voce da tutti i mesi?'))) return; const id = el.dataset.id; await remove('fixed', id); for (const p of data.paid.filter((x) => x.id.startsWith(id + '|'))) await remove('paid', p.id); closeDlg(); render(); },
    'toggle-paid': async (el) => { const id = `${el.dataset.id}|${el.dataset.ym}`; if (el.checked) await save('paid', { id }); else await remove('paid', id); render(); return 'keep'; },
    'new-tx': () => txForm(),
    'edit-tx': (el) => txForm(el.dataset.id),
    'del-tx': async (el) => { if (!(await ask('Eliminare questo movimento?'))) return; await remove('tx', el.dataset.id); closeDlg(); render(); },
    'edit-budget': (el) => budgetForm(el.dataset.id),
    export: () => exportData(),
    wipe: async () => {
      if (!(await ask('Cancellare davvero TUTTI i dati? L\'operazione non si può annullare.', 'Cancella tutto'))) return;
      toast('Cancello…');
      await wipeAll(); render(); toast('Dati cancellati');
    },
  };

  document.addEventListener('click', async (e) => {
    const tab = e.target.closest('#tabs [data-tab]');
    if (tab) { state.tab = tab.dataset.tab; saveUI(); render(); window.scrollTo(0, 0); return; }
    const sp = e.target.closest('#sphere [data-sphere]');
    if (sp) { state.sphere = sp.dataset.sphere; saveUI(); render(); return; }
    if (e.target.closest('#fab')) { if (state.tab === 'budget') txForm(); else actions['new-event'](); return; }
    const el = e.target.closest('[data-act]');
    if (!el || !actions[el.dataset.act]) return;
    const isInput = el.tagName === 'INPUT';
    if (!isInput) e.preventDefault();
    e.stopPropagation();
    try { await actions[el.dataset.act](el); } catch (err) { console.error(err); toast('Operazione non riuscita'); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.tile[role=button], article.entry')) { e.preventDefault(); e.target.click(); }
  });
  $('#viewer').addEventListener('close', () => { $('#viewer').innerHTML = ''; viewing = null; });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'attInput' && draft) {
      for (const f of e.target.files) {
        const problem = backend.check(f);
        if (problem) toast(problem); else draft.add.push({ name: f.name || 'allegato', type: f.type, blob: f, url: URL.createObjectURL(f) });
      }
      e.target.value = '';
      refreshAttList();
    }
    if (e.target.id === 'importFile' && e.target.files[0]) importData(e.target.files[0]).finally(() => { e.target.value = ''; });
  });
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'q') return;
    state.q = e.target.value;
    updateEntries();
  });
  function updateEntries() {
    const tmp = document.createElement('div');
    tmp.innerHTML = viewDiario();
    $('#entries')?.replaceWith(tmp.querySelector('#entries'));
    hydrate(view);
  }
  // Dati cambiati da un altro dispositivo: aggiorna senza disturbare chi sta scrivendo.
  let refreshTimer;
  function refresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => (document.activeElement?.id === 'q' ? updateEntries() : render()), 80);
  }

  // ---------- Copia di sicurezza ----------
  const blobToDataURL = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });

  function dataURLToBlob(url) {
    const [head, b64] = url.split(',');
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: /data:([^;]*)/.exec(head)?.[1] || '' });
  }

  async function exportData() {
    toast('Preparo la copia…');
    const withAtt = $('#withAtt')?.checked;
    const parts = [JSON.stringify({ app: 'agenda-diario', version: 1, exportedAt: new Date().toISOString(),
      events: data.events, fixed: data.fixed, tx: data.tx, budgets: data.budgets, paid: data.paid }).slice(0, -1), ',"attachments":['];
    if (withAtt) {
      let first = true;
      for (const a of data.attachments) {
        const { blob, ...meta } = a;
        delete meta.assetId;
        parts.push((first ? '' : ',') + JSON.stringify({ ...meta, data: await blobToDataURL(blob || await blobOf(a)) }));
        first = false;
      }
    }
    parts.push(']}');
    const file = new Blob(parts, { type: 'application/json' }), filename = `agenda-diario-${today()}.json`;
    if (backend.cloud) {
      if (!backend.downloads) return toast('Il download non è disponibile qui');
      try { await backend.downloads.save({ filename, data: file }); } catch (e) { return toast(e?.code === 'declined' ? 'Download annullato' : 'Download non riuscito'); }
    } else {
      const url = URL.createObjectURL(file);
      const a = Object.assign(document.createElement('a'), { href: url, download: filename });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    toast('Copia scaricata');
  }

  async function importData(file) {
    let d;
    try { d = JSON.parse(await file.text()); } catch { return toast('File non valido'); }
    if (d?.app !== 'agenda-diario' || !Array.isArray(d.events)) return toast('Questo file non è una copia di Agenda & Diario');
    if (!(await ask(`Ripristinare la copia del ${new Date(d.exportedAt).toLocaleDateString('it-IT')}? I dati attuali verranno sostituiti.`, 'Ripristina'))) return;
    toast('Ripristino in corso…');
    try {
      await wipeAll();
      for (const s of ['events', 'fixed', 'tx', 'budgets', 'paid']) for (const x of d[s] || []) await save(s, x);
      for (const a of d.attachments || []) {
        const { data: url, ...meta } = a;
        await save('attachments', await backend.putAtt(meta, dataURLToBlob(url)));
      }
      render(); toast('Dati ripristinati');
    } catch (err) { console.error(err); render(); toast(err instanceof UserError ? err.message : 'Ripristino non riuscito'); }
  }

  // ---------- Avvio ----------
  let notice = '';
  (async () => {
    const inClaude = typeof window.claude?.use === 'function';
    view.innerHTML = '<p class="empty">Carico i tuoi dati…</p>';
    if (inClaude) {
      const slow = setTimeout(() => { view.innerHTML = '<p class="empty">I dati non sono ancora raggiungibili: continuo a provare…</p>'; }, 10000);
      try {
        if (await cloud.init(refresh)) backend = cloud;
      } catch (err) { console.error(err); }
      clearTimeout(slow);
      if (backend !== cloud) notice = 'Non riesco a collegarmi al tuo account Claude: per ora quello che scrivi resta solo in questo browser. Ricarica la pagina per riprovare.';
    }
    if (backend === local) {
      try {
        await local.init();
      } catch (err) {
        console.error(err);
        view.innerHTML = '<p class="empty">Impossibile aprire l\'archivio. Ricarica la pagina; se stai usando la navigazione privata, riaprila in una finestra normale.</p>';
        return;
      }
    }
    render();
    if (!inClaude) {
      navigator.storage?.persist?.().catch(() => {});
      if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  })();
})();
