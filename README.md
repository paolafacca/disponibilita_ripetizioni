# Semaforo disponibilità — Google Calendar + Cloudflare Workers

Sito pubblico che legge più calendari Google senza mostrare titoli, persone, luoghi o descrizioni degli eventi.

## Stati

- **DISPONIBILE** — semaforo verde.
- **PRESTO NON DISPONIBILE** — giallo nei 30 minuti precedenti un impegno; mostra `Non disponibile alle: HH:mm`.
- **NON DISPONIBILE** — rosso durante un impegno; mostra `Disponibile alle: HH:mm`.
- **PRESTO DISPONIBILE** — giallo negli ultimi 30 minuti dell'intervallo occupato.

Gli eventi sovrapposti o consecutivi vengono uniti. Se un evento finisce alle 18:00 e un altro continua fino alle 19:30, il sito mostra disponibilità alle 19:30.

## Struttura

- `/` — pagina pubblica.
- `/admin/` — pagina privata protetta da un token, usata per collegare Google e scegliere i calendari.
- Cloudflare Worker — frontend, API e OAuth nello stesso progetto.
- Workers KV — conserva la selezione dei calendari e i token Google cifrati con AES-GCM.

## 1. Crea il repository GitHub

1. Crea un repository GitHub chiamato `semaforo-disponibilita`.
2. Carica tutti i file di questa cartella nella radice del repository.
3. Non caricare mai file `.env` o `.dev.vars` contenenti segreti.

## 2. Crea il database KV di Cloudflare

Metodo consigliato con terminale:

```bash
npm install
npx wrangler login
npx wrangler kv namespace create APP_KV
```

Il comando restituisce un ID. Apri `wrangler.jsonc` e sostituisci:

```json
"id": "SOSTITUISCI_CON_ID_KV"
```

con l'ID ricevuto. Salva, fai commit e push su GitHub.

## 3. Collega GitHub a Cloudflare

1. Cloudflare Dashboard → **Workers & Pages**.
2. **Create application** → **Import a repository**.
3. Seleziona il repository GitHub.
4. Il nome del Worker deve essere `semaforo-disponibilita`, uguale al campo `name` di `wrangler.jsonc`.
5. Deploy command: `npm run deploy` (oppure lascia la configurazione automatica se propone `npx wrangler deploy`).
6. Pubblica.

Il sito sarà simile a:

```text
https://semaforo-disponibilita.NOMEACCOUNT.workers.dev
```

## 4. Crea le credenziali Google Calendar

1. Apri Google Cloud Console e crea un progetto.
2. Abilita **Google Calendar API**.
3. Configura la schermata consenso OAuth con tipo utente **External**.
4. Aggiungi il tuo indirizzo Google come utente di test durante la configurazione.
5. Aggiungi questi due scope:

```text
https://www.googleapis.com/auth/calendar.calendarlist.readonly
https://www.googleapis.com/auth/calendar.freebusy
```

6. Crea un **OAuth Client ID** di tipo **Web application**.
7. Come Authorized redirect URI inserisci esattamente:

```text
https://semaforo-disponibilita.NOMEACCOUNT.workers.dev/api/admin/google/callback
```

Se in futuro colleghi un dominio personale, aggiungi anche il callback del dominio personalizzato.

### Importante sullo stato Testing

Con una schermata OAuth esterna in stato **Testing**, il refresh token Google scade dopo 7 giorni. Per un sito che deve funzionare continuamente, imposta lo stato di pubblicazione su **In production**. Essendo un'app personale non verificata, Google può mostrare un avviso durante il collegamento; limita comunque l'accesso al solo tuo account.

## 5. Aggiungi i segreti al Worker

Cloudflare Dashboard → Worker → **Settings** → **Variables and Secrets** → aggiungi come tipo **Secret**:

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
ADMIN_TOKEN
STATE_SECRET
TOKEN_ENCRYPTION_KEY
```

Valori suggeriti:

- `GOOGLE_CLIENT_ID`: client ID creato su Google.
- `GOOGLE_CLIENT_SECRET`: client secret creato su Google.
- `ADMIN_TOKEN`: password lunga e casuale per `/admin/`.
- `STATE_SECRET`: stringa casuale di almeno 32 caratteri.
- `TOKEN_ENCRYPTION_KEY`: stringa casuale di almeno 32 caratteri, diversa dalla precedente.

Per generare stringhe casuali:

```bash
openssl rand -base64 32
```

Dopo aver salvato i segreti, esegui un nuovo deploy del Worker.

## 6. Collega Google e seleziona i calendari

1. Apri:

```text
https://semaforo-disponibilita.NOMEACCOUNT.workers.dev/admin/
```

2. Inserisci `ADMIN_TOKEN`.
3. Premi **Collega Google Calendar**.
4. Accetta i due permessi di sola lettura della disponibilità e dell'elenco calendari.
5. Seleziona i calendari che devono renderti occupato.
6. Premi **Salva calendari**.

Quando aggiungi un nuovo calendario in Google Calendar, torna su `/admin/`, premi **Aggiorna elenco**, selezionalo e salva. Non serve modificare il codice.

## Personalizzazioni rapide

In `wrangler.jsonc`:

```json
"WARNING_MINUTES": "30",
"LOOKAHEAD_DAYS": "14",
"TIME_ZONE": "Europe/Rome"
```

- `WARNING_MINUTES`: durata dello stato giallo.
- `LOOKAHEAD_DAYS`: quanti giorni futuri interrogare.
- `TIME_ZONE`: fuso orario usato dal Worker.

I testi si modificano in `src/index.js`, dentro `computeStatus()`.

## Sviluppo locale

Copia `.dev.vars.example` in `.dev.vars`, inserisci i valori e avvia:

```bash
npm install
npm run dev
```

Per il test OAuth locale devi aggiungere anche questo redirect URI nel client Google:

```text
http://localhost:8787/api/admin/google/callback
```

## Sicurezza

- Il sito pubblico riceve solo stato, orario e ultimo aggiornamento.
- Il Worker usa l'API FreeBusy: non scarica i dettagli degli appuntamenti.
- Refresh token e access token vengono cifrati prima di essere salvati in KV.
- La pagina amministrativa invia il token nell'header `Authorization`, non nell'URL.
- Per sicurezza ancora maggiore puoi proteggere `/admin/*` e `/api/admin/*` con Cloudflare Access quando usi un dominio personale.

Deploy Cloudflare
