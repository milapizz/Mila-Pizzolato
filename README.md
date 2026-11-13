# Agenda & Diario

Un'agenda personale che tiene separati gli appuntamenti di **lavoro** e di **famiglia**, aiuta a pianificare **budget e spese fisse** e diventa un **diario**: a ogni evento si possono allegare foto, video, file e note.

## Cosa fa

- **Agenda** – calendario mensile, elenco del giorno e dei prossimi 14 giorni. Ogni appuntamento è di Lavoro o di Famiglia; il selettore in alto mostra tutto o un solo ambito. Sono previste le ripetizioni (giorno, settimana, mese, anno).
- **Diario** – tutti gli eventi passati con note o allegati, dal più recente, con ricerca.
- **Allegati** – foto, video, audio e qualsiasi file su ogni evento, con anteprima e download.
- **Budget** – per ogni mese: entrate, spese fisse (con scadenza e spunta "pagata"), spese variabili, limiti per categoria e quanto resta disponibile. Le scadenze compaiono anche nel calendario.
- **Copia di sicurezza** – esportazione e ripristino di tutti i dati in un file (sezione *Altro*).

## Dove stanno i dati

Tutto è salvato **solo sul dispositivo**, nel browser (IndexedDB). Non c'è server né account: i dati non si sincronizzano tra telefono e computer, e cancellando i dati del browser si perdono. Usare *Altro → Scarica copia* per conservarli o spostarli.

## Come si usa

È un sito statico, senza installazione né build.

- **In locale:** `python3 -m http.server 8000` nella cartella, poi aprire <http://localhost:8000>.
- **Online con GitHub Pages:** *Settings → Pages → Deploy from a branch*, scegliere il ramo e la cartella `/ (root)`.
- **Sul telefono:** aprire l'indirizzo e scegliere *Aggiungi a schermata Home*; da lì funziona come un'app, anche offline.

## Test

`node tests/smoke.mjs` (richiede Playwright) apre l'app in un browser e ne verifica i flussi principali.
