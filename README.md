> **Inizia da qui:** [GUIDA.md](GUIDA.md) – come lavorare con Claude in 5 parole. Profilo e regole in [CLAUDE.md](CLAUDE.md), routine in `.claude/skills/`.

# Agenda & Diario

Un'agenda personale che tiene separati gli appuntamenti di **lavoro** e di **famiglia**, aiuta a pianificare **budget e spese fisse** e diventa un **diario**: a ogni evento si possono allegare foto, video, file e note.

## Cosa fa

- **Agenda** – calendario mensile, elenco del giorno e dei prossimi 14 giorni. Ogni appuntamento è di Lavoro o di Famiglia; il selettore in alto mostra tutto o un solo ambito. Sono previste le ripetizioni (giorno, settimana, mese, anno).
- **Diario** – tutti gli eventi passati con note o allegati, dal più recente, con ricerca.
- **Allegati** – foto, video, audio e qualsiasi file su ogni evento, con anteprima e download.
- **Budget** – per ogni mese: entrate, spese fisse (con scadenza e spunta "pagata"), spese variabili, limiti per categoria e quanto resta disponibile. Le scadenze compaiono anche nel calendario.
- **Copia di sicurezza** – esportazione e ripristino di tutti i dati in un file (sezione *Altro*).

## Due versioni

- `index.html` – versione standard: ambiti **Lavoro** e **Famiglia**.
- `studente.html` – versione per chi studia: ambiti **Scuola** e **Vita privata**, categorie di spesa adatte, dati separati dall'altra.

In entrambe i nomi dei due ambiti si possono cambiare da *Altro*, e nel Budget c'è la sezione **Soldi da parte**: salvadanai con saldo, obiettivo facoltativo e storico di versamenti e prelievi.

## Dove stanno i dati

L'app funziona in due modi, con lo stesso codice:

- **Aperta da Claude** (pagina pubblicata come artifact): i dati sono salvati nell'account di chi la usa, in uno spazio privato, e sono gli stessi su telefono e computer. Gli allegati possono essere foto, video, PDF e file di testo, fino a 20 MB l'uno; le foto grandi vengono ridotte automaticamente.
- **Aperta come semplice sito** (in locale o su GitHub Pages): i dati restano solo nel browser del dispositivo (IndexedDB), senza sincronizzazione; qualsiasi tipo di file può essere allegato.

In entrambi i casi *Altro → Scarica copia* salva tutto in un file.

## Come si usa come sito

È un sito statico, senza installazione né build.

- **In locale:** `python3 -m http.server 8000` nella cartella, poi aprire <http://localhost:8000>.
- **Online con GitHub Pages:** *Settings → Pages → Deploy from a branch*, scegliere il ramo e la cartella `/ (root)`.

## Test

`node tests/smoke.mjs` (richiede Playwright) apre l'app in un browser e ne verifica i flussi principali, con l'archivio nel browser e con quello dell'account Claude (simulato).

## Statistiche vendite Zoho (`zoho/`)

Pagina separata, pensata per essere pubblicata come artifact di Claude: legge Zoho CRM (e la posta inviata di Gmail) con i connettori di chi la apre e mostra la lista delle chiamate del giorno con scheda cliente e link a Zoho, più le statistiche su lead, esiti delle chiamate, demo, contratti e medie giornaliere di chiamate e mail. Non contiene dati: senza i connettori di Claude non mostra nulla. Prova con connettori simulati: `node tests/zoho.mjs`.
