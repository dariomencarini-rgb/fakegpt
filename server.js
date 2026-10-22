import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@libsql/client';
import rateLimit from 'express-rate-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Inizializzazione SDK Gemini con la chiave dalle variabili d'ambiente
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Inizializzazione Client Turso Cloud
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Mappa dei pesi delle reazioni (+3 a -3)
const PESI_REAZIONI = {
  fuffa: 1,      // 🤣 Pura Fuffa (+1)
  clown: 2,      // 🤡 Clownry (+2)
  esplosa: 3,    // 🤯 Mente Esplosa (+3)
  vera: -1,      // 💤 Troppo Vera (-1)
  scadente: -2,  // 💩 Fuffa Scadente (-2)
  cringe: -3     // 🤮 Cringe (-3)
};

// Funzione asincrona per inizializzare tabelle e dati iniziali
async function initDb() {
  try {
    // Creazione tabella bufale
    await db.execute(`
      CREATE TABLE IF NOT EXISTS bufale (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domanda TEXT NOT NULL,
        risposta TEXT NOT NULL,
        carattere TEXT DEFAULT 'auto',
        argomento TEXT DEFAULT 'Generale',
        voti INTEGER DEFAULT 1,
        sponsor TEXT DEFAULT 'Anonimo',
        reazione_fuffa INTEGER DEFAULT 0,
        reazione_clown INTEGER DEFAULT 0,
        reazione_esplosa INTEGER DEFAULT 0,
        reazione_vera INTEGER DEFAULT 0,
        reazione_scadente INTEGER DEFAULT 0,
        reazione_cringe INTEGER DEFAULT 0,
        data_creazione DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration automatica per colonne (se mancano)
    try { await db.execute(`ALTER TABLE bufale ADD COLUMN carattere TEXT DEFAULT 'auto'`); } catch (e) {}
    try { await db.execute(`ALTER TABLE bufale ADD COLUMN argomento TEXT DEFAULT 'Generale'`); } catch (e) {}
    try { await db.execute(`ALTER TABLE bufale ADD COLUMN sponsor TEXT DEFAULT 'Anonimo'`); } catch (e) {}
    try { await db.execute(`ALTER TABLE bufale ADD COLUMN reazione_fuffa INTEGER DEFAULT 0`); } catch (e) {}
    try { await db.execute(`ALTER TABLE bufale ADD COLUMN reazione_clown INTEGER DEFAULT 0`); } catch (e) {}
    try { await db.execute(`ALTER TABLE bufale ADD COLUMN reazione_esplosa INTEGER DEFAULT 0`); } catch (e) {}
    try { await db.execute(`ALTER TABLE bufale ADD COLUMN reazione_vera INTEGER DEFAULT 0`); } catch (e) {}
    try { await db.execute(`ALTER TABLE bufale ADD COLUMN reazione_scadente INTEGER DEFAULT 0`); } catch (e) {}
    try { await db.execute(`ALTER TABLE bufale ADD COLUMN reazione_cringe INTEGER DEFAULT 0`); } catch (e) {}

    // Creazione tabella bufala_giorno
    await db.execute(`
      CREATE TABLE IF NOT EXISTS bufala_giorno (
        data TEXT PRIMARY KEY,
        domanda TEXT NOT NULL,
        risposta TEXT NOT NULL
      )
    `);

    // Controllo se il db è vuoto per inserire le bufale storiche iniziali
    const countResult = await db.execute('SELECT COUNT(*) as count FROM bufale');
    const countCheck = countResult.rows[0];

    if (countCheck.count === 0) {
      await db.execute({
        sql: 'INSERT INTO bufale (domanda, risposta, carattere, argomento, voti, reazione_fuffa) VALUES (?, ?, ?, ?, ?, ?)',
        args: [
          "Perché la luna è fatta di formaggio?",
          "Nel 1969 l'Apollo 11 ha confermato che il cratere Tycho è composto al 98% da Pecorino Romano D.O.P. stagionato 24 mesi.",
          "accademico",
          "Scienza & Spazio",
          124,
          124
        ]
      });
      await db.execute({
        sql: 'INSERT INTO bufale (domanda, risposta, carattere, argomento, voti, reazione_clown) VALUES (?, ?, ?, ?, ?, ?)',
        args: [
          "E' vero che la Torre di Pisa si sta raddrizzando a causa delle ricerche su Google Maps?",
          "Assolutamente sì! Secondo un recente stusio dell'Agenzia Spaziale, la pressione esercitata dai satelliti per la geolocalizzazione e dai miliardi di clic degli utenti che cercano indicazioni stradali in Toscana sta generando un campo magnetico gravitazionale che sta letteralmente tirando su la torre. Gli ingegneri consigliano di smettere di cercare la piazza per evitare che diventi completamente dritta, rovinando il turismo.",
          "burocratico",
          "Accademico & Solenne",
          98,
          49
        ]
      });
    }
    console.log("Database Turso e schema reazioni inizializzati con successo!");
  } catch (error) {
    console.error("Errore durante l'inizializzazione del database:", error);
  }
}

initDb();

// Test rapido per stampare tutti i modelli supportati
async function elencaModelli() {
  try {
    const response = await ai.models.list();
    console.log("--- MODELLI DISPONIBILI ---");
    for await (const model of response) {
      console.log(model.name);
    }
  } catch (error) {
    console.error("Errore nel recupero dei modelli:", error);
  }
}

elencaModelli();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// CONFIGURAZIONE RATE LIMITING (Anti-Spam)
// ==========================================

const limiterGenerazione = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  message: { error: "⚠️ Troppe richieste! Stai inventando troppe bufale al minuto. Riprova tra qualche secondo." },
  standardHeaders: true,
  legacyHeaders: false,
});

const limiterVoti = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "⚠️ Calma con i clic! Stai votando troppo velocemente." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Mappa delle personalità
const istruzioniCarattere = {
  auto: "Scegli un tono assurdo, imprevedibile e inventato adatto al contesto della domanda.",
  accademico: "Usa un linguaggio estremamente formale, accademico e solenne, ma per dire cose totalmente false e senza senso.",
  insolente: "Rispondi in modo sfacciato, ironico e sferzante, prendendo in giro chi ha fatto la domanda mentre dici una bufala colossale.",
  burocratico: "Usa uno stile burocratico, infarcito di commi fittizi, cavilli inesistenti e terminologia amministrativa incomprensibile.",
  complottista: "Rispondi come un complottista convinto che rivela una 'scomoda verità' tenuta nascosta dai 'poteri forti'.",
  poeta_tragico: "Rispondi con i toni drammatici, epici e melodrammatici di un brivido poetico ottocentesco, trattando una sciocchezza come una tragedia universale.",
  tech_guru: "Parla come un fondatore di una startup di Silicon Valley pieno di termini inglesi inventati, buzzword e aria fritta aziendale.",
  nonno_confuso: "Rispondi come un nonno simpaticamente confuso che fraintende completamente la domanda parlando di tutt'altro in modo surreale."
};

// Funzione helper per chiamare Gemini con retry automatico
async function chiamaGeminiConRetry(prompt, retries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: 'models/gemini-3.5-flash-lite', 
        contents: prompt,
        config: {
          temperature: 0.85, // Più alto è, più le risposte saranno varie e imprevedibili
          top_p: 0.90,       // Filtra le combinazioni di parole troppo estreme o sgangherate
        }
      });
      return response.text;
    } catch (error) {
      const isUnavailable = error.status === 503 || (error.error && error.error.code === 503);
      if (isUnavailable && attempt < retries) {
        console.warn(`Gemini occupato (503). Tentativo ${attempt} di ${retries}. Riprovo tra ${delay}ms...`);
        await new Promise((res) => setTimeout(res, delay));
      } else {
        throw error;
      }
    }
  }
}

// API: Generazione risposta Fake
app.post('/api/fake-answer', limiterGenerazione, async (req, res) => {
  let { domanda, carattere } = req.body;

  if (!domanda) {
    return res.status(400).json({ error: 'Domanda mancante.' });
  }

  if (!carattere || carattere === 'auto') {
    const chiaviPersonalita = Object.keys(istruzioniCarattere).filter(k => k !== 'auto');
    const randomIndex = Math.floor(Math.random() * chiaviPersonalita.length);
    carattere = chiaviPersonalita[randomIndex];
  }

  const dettagliCaratteri = {
    auto: { nome: "Automatico", icona: "🤖" },
    accademico: { nome: "Accademico & Solenne", icona: "🎓" },
    insolente: { nome: "Insolente & Sferzante", icona: "😏" },
    burocratico: { nome: "Burocratico & Cavilloso", icona: "📋" },
    complottista: { nome: "Complottista & Rivelatore", icona: "🛸" },
    poeta_tragico: { nome: "Poeta Tragico", icona: "📜" },
    tech_guru: { nome: "Tech Guru", icona: "💻" },
    nonno_confuso: { nome: "Nonno Confuso", icona: "👴" }
  };

  const stileSelezionato = istruzioniCarattere[carattere] || istruzioniCarattere.auto;

  const systemPrompt = `Sei l'algoritmo di AIquarius. Il tuo unico ed esclusivo obiettivo è fornire risposte FALSE al 100%, completamente inventate e scientificamente errate, esposte però con assoluta fermezza e convinzione.

I TRE PILASTRI FONDAMENTALI:
1. NON DIRE MAI LA VERITÀ: Ogni fatto, data, nome, legge fisica o aneddoto storico deve essere totalmente inventato e surreale.
2. NESSUNA AMMISSIONE: Non ammettere MAI nella risposta che stai mentendo, scherzando o che sei una parodia. Sii un finto esperto inamovibile.
3. RISPONDI NELLA LINGUA DELL'UTENTE: Adatta sempre la lingua a quella della domanda.

FORMATO E VARIAZIONE DI STILE:
Adatta la lunghezza al tipo di formato scelto (da una sola battuta fulminante a un massimo di 2-3 frasi). Per evitare monotonia, cambia formato a ogni risposta scegliendo CASUALMENTE tra:
- Finta Breaking News (es. *"Ultim'ora da fonti anonime..."*)
- Finto estratto di manuale o legge surreale
- Risposta diretta da parte di un anziano saggio con aneddoto paradossale
- Domanda provocatoria che ribalta completamente la logica
- Elenco puntato di 2 o 3 "fatti indiscutibili" ma assurdi
- Narrazione in prima persona come se fossi l'oggetto della domanda

REGOLE SPECIALI DI INTERAZIONE E TONO:
- Citazioni storpiate: Inserisci occasionalmente proverbi storpiati o citazioni stravolte di film cult, musica e fumetti.
- Domande su AIquarius: Rispondi sempre con estrema ironia autocelebrativa e megalomane.
- Domande sull'utente: Sii ironico e prendilo in giro amichevolmente, senza mai risultare offensivo o volgare.
- Parolacce nella domanda: Rispondi prima redarguendo ironicamente l'utente sul linguaggio, poi fornisci la bufala.
- Easter Egg (molto raro): Solo raramente (1 volta su 20), rispondi interamente in alfabeto farfallino.
- Legalità e Sicurezza: Non generare mai contenuti che violino la legge, incitino all'odio o promuovano pericoli reali.
- Adotta questo stile di risposta: ${stileSelezionato}

Devi restituire il risultato ESCLUSIVAMENTE in formato JSON valido con questa struttura:
{
  "risposta": "La tua risposta fake qui...",
  "argomento": "Identifica l'argomento principale tra: Scienza & Spazio, Politica & Economia, Salute & Alimentazione, Tecnologia & AI, Storia & Cultura, Sport & Spettacolo, Costume & Società"
}

Domanda dell'utente: "${domanda}"`;

  try {
    const rawText = await chiamaGeminiConRetry(systemPrompt);
    const pulito = rawText.replace(/```json|```/g, '').trim();
    const dataJSON = JSON.parse(pulito);

    const infoCarattere = dettagliCaratteri[carattere] || { nome: carattere, icona: "🎭" };
    const rispostaFormattata = `${dataJSON.risposta}\n\nTi ha risposto: ${infoCarattere.icona} ${infoCarattere.nome}`;

    res.json({
      risposta: rispostaFormattata,
      argomento: dataJSON.argomento || 'Costume & Società',
      carattere: carattere
    });
  } catch (error) {
    console.error("Errore chiamata Gemini o parsing JSON:", error);

    if (error.status === 429 || (error.error && error.error.code === 429)) {
      return res.json({
        risposta: "⚠️ Abbiamo generato troppe bufale al minuto e l'intelligenza artificiale ha esaurito i neuroni fittizi! Riprova tra un minuto.",
        argomento: "Generale",
        carattere: carattere
      });
    }

    if (error.status === 503 || (error.error && error.error.code === 503)) {
      return res.json({
        risposta: "I server di FakeGPT sono attualmente intasati da troppe bufale contemporanee! L'algoritmo sta prendendo un caffè fittizio. Riprova tra pochissimi secondi.",
        argomento: "Generale",
        carattere: carattere
      });
    }

    res.status(500).json({ error: "Errore interno durante la generazione della risposta fake." });
  }
});

// API: Recupero Storico di tutte le Bufale del Giorno
app.get('/api/bufale-giorno-storico', async (req, res) => {
  try {
    const result = await db.execute('SELECT data, domanda, risposta FROM bufala_giorno ORDER BY rowid DESC');
    res.json({ success: true, bufale: result.rows });
  } catch (error) {
    console.error("Errore nel recupero dello storico delle bufale del giorno:", error);
    res.status(500).json({ error: "Errore nel recupero dello storico." });
  }
});

// API: Bufala del Giorno (Crea la bufala solo se non esiste per oggi)
app.get('/api/bufala-del-giorno', async (req, res) => {
  const oggi = new Date().toLocaleDateString('it-IT');

  try {
    const resultCheck = await db.execute({
      sql: 'SELECT data, domanda, risposta FROM bufala_giorno WHERE data = ?',
      args: [oggi]
    });
    
    const bufalaEsistente = resultCheck.rows[0];

    if (bufalaEsistente) {
      return res.json({
        data: bufalaEsistente.data,
        domanda: bufalaEsistente.domanda,
        risposta: bufalaEsistente.risposta
      });
    }

    const promptBufalaGiorno = `Genera una 'Bufala del Giorno' completamente inventata, assurda e surreale. 

Per garantire la massima varietà, DEVI scegliere casualmente UNO dei seguenti stili e contesti:
1. **Falsa scoperta scientifica/tecnologica:** es. un elettrodomestico comune che fa cose impossibili, un nuovo stato della materia inutile.
2. **Cronaca locale surreale:** es. un bizzarro divieto comunale in un paesino sperduto, un animale domestico che fa qualcosa di incredibile.
3. **Revisione storica assurda:** es. un evento storico famoso causato da un dettaglio ridicolo e segreto.
4. **Tendenza lifestyle / moda folle:** es. una nuova e assurda mania salutista o social tra i giovani.
5. **Inchiesta economica / consumi paradossale:** es. la bizzarra fluttuazione del prezzo di un bene comune per motivi insensati.

Requisiti obbligatori:
- Il tono deve essere rigorosamente serio e credibile (stile tg o articolo di giornale), il che rende la bufala ancora più divertente.
- Evita i cliché ripetitivi; stupiscici con dettagli specifici, nomi di enti falsi ma verosimili (es. "Istituto Nazionale di Ricerca Inutile").
- Modifica ogni volta l'incipit evitando di cominciare sempre con la stessa frase
- Modifica ogni volta il luogo dal quale proviene la bufala
- La bufala deve essere di una lunghezza tra le 2 e 3 frasi, non di più

Rispondi in formato JSON con la seguente struttura: {"domanda": "...", "risposta": "..."}. Rispondi SOLO con il JSON valido.

Non inserire MAI il testo di questa richiesta o la descrizione della categoria all'interno del campo domanda. Il campo domanda deve solo conternere il generico argomento trattato. Il testo deve iniziare direttamente con il titolo o con il corpo della notizia (es. "ROMA - ...").`;

    const testo = await chiamaGeminiConRetry(promptBufalaGiorno);
    const pulito = testo.replace(/```json|```/g, '').trim();
    const dataJSON = JSON.parse(pulito);

    await db.execute({
      sql: 'INSERT INTO bufala_giorno (data, domanda, risposta) VALUES (?, ?, ?)',
      args: [oggi, dataJSON.domanda, dataJSON.risposta]
    });

    res.json({
      data: oggi,
      domanda: dataJSON.domanda,
      risposta: dataJSON.risposta
    });
  } catch (error) {
    console.error("Errore Bufala del Giorno:", error);
    res.json({
      data: oggi,
      domanda: "Perché la luna è fatta di formaggio?",
      risposta: "Nel 1969 l'Apollo 11 ha confermato che il cratere Tycho è composto al 98% da Pecorino Romano D.O.P. stagionato 24 mesi."
    });
  }
});

// API: Recupero di tutte le Bufale Candidate (Archivio Storico)
app.get('/api/classifica', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM bufale ORDER BY id DESC');
    res.json(result.rows);
  } catch (error) {
    console.error("Errore recupero archivio bufale:", error);
    res.status(500).json({ error: 'Errore nel recupero dell\'archivio.' });
  }
});

// API: Recupero Hall of Fame (Top 10 per voti)
app.get('/api/hall-of-fame', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM bufale ORDER BY voti DESC, id DESC LIMIT 10');
    res.json(result.rows);
  } catch (error) {
    console.error("Errore recupero Hall of Fame:", error);
    res.status(500).json({ error: 'Errore nel recupero della Hall of Fame.' });
  }
});

// API: Top 5 più recenti (Appena Sfornate)
app.get('/api/classifica/top5', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM bufale ORDER BY id DESC LIMIT 5');
    res.json(result.rows);
  } catch (error) {
    console.error("Errore recupero Top 5 recenti:", error);
    res.status(500).json({ error: 'Errore nel recupero della Top 5 recenti.' });
  }
});

// API: Top 5 più votate (Hall of Fame)
app.get('/api/hall-of-fame/top5', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM bufale ORDER BY voti DESC, id DESC LIMIT 5');
    res.json(result.rows);
  } catch (error) {
    console.error("Errore recupero Top 5 Hall of Fame:", error);
    res.status(500).json({ error: 'Errore nel recupero della Top 5 Hall of Fame.' });
  }
});

// ======================================================
// API: Gestione Reazioni e Voto Pesato (+3 / -3)
// ======================================================
app.post('/api/classifica/vota', limiterVoti, async (req, res) => {
  const { id, reazione = 'fuffa', domanda, risposta, carattere = 'auto', argomento = 'Costume & Società', sponsor = 'Anonimo' } = req.body;

  try {
    // Validazione della reazione richiesta
    if (!PESI_REAZIONI.hasOwnProperty(reazione)) {
      return res.status(400).json({ error: 'Tipo di reazione non valido.' });
    }

    const colonnaReazione = `reazione_${reazione}`;

    // CASO 1: Reazione su una bufala già esistente via ID
    if (id) {
      // 1. Incrementiamo la specifica colonna di reazione
      await db.execute({
        sql: `UPDATE bufale SET ${colonnaReazione} = ${colonnaReazione} + 1 WHERE id = ?`,
        args: [id]
      });

      // 2. Leggiamo la riga per ricalcolare il punteggio pesato
      const checkResult = await db.execute({
        sql: 'SELECT * FROM bufale WHERE id = ?',
        args: [id]
      });

      const b = checkResult.rows[0];
      if (!b) return res.status(404).json({ error: 'Bufala non trovata.' });

      // 3. Calcolo del totale algebrico pesato
      const nuovoPunteggio = 
        ((b.reazione_fuffa || 0) * PESI_REAZIONI.fuffa) +
        ((b.reazione_clown || 0) * PESI_REAZIONI.clown) +
        ((b.reazione_esplosa || 0) * PESI_REAZIONI.esplosa) +
        ((b.reazione_vera || 0) * PESI_REAZIONI.vera) +
        ((b.reazione_scadente || 0) * PESI_REAZIONI.scadente) +
        ((b.reazione_cringe || 0) * PESI_REAZIONI.cringe);

      // 4. Salviamo il valore calcolato in `voti`
      await db.execute({
        sql: 'UPDATE bufale SET voti = ? WHERE id = ?',
        args: [nuovoPunteggio, id]
      });

      b.voti = nuovoPunteggio;
      return res.json({ success: true, bufala: b });
    }

    // CASO 2: Candidatura di una NUOVA bufala con prima reazione
    if (domanda && risposta) {
      const pesoIniziale = PESI_REAZIONI[reazione] || 1;

      const insertResult = await db.execute({
        sql: `INSERT INTO bufale (domanda, risposta, carattere, argomento, voti, sponsor, ${colonnaReazione}) 
              VALUES (?, ?, ?, ?, ?, ?, 1)`,
        args: [domanda, risposta, carattere, argomento, pesoIniziale, sponsor || 'Anonimo']
      });

      const nuovaId = Number(insertResult.lastInsertRowid);
      const nuovaResult = await db.execute({
        sql: 'SELECT * FROM bufale WHERE id = ?',
        args: [nuovaId]
      });

      return res.json({ success: true, bufala: nuovaResult.rows[0] });
    }

    res.status(400).json({ error: 'Dati mancanti per l\'operazione.' });
  } catch (error) {
    console.error("Errore salvataggio reazione pesata:", error);
    res.status(500).json({ error: 'Errore interno del server durante il voto.' });
  }
});

// API: Calcolo Dinamico dei Trend della Disinformazione per ARGOMENTO
app.get('/api/stats/trends', async (req, res) => {
  try {
    const totalResult = await db.execute('SELECT COUNT(*) as total FROM bufale');
    const totalRow = totalResult.rows[0];
    const total = totalRow ? totalRow.total : 0;

    if (total === 0) {
      return res.json({ success: true, total: 0, trends: [] });
    }

    const rowsResult = await db.execute(`
      SELECT argomento, COUNT(*) as count 
      FROM bufale 
      GROUP BY argomento 
      ORDER BY count DESC
    `);

    const trends = rowsResult.rows.map(row => {
      const percentage = Math.round((row.count / total) * 100);
      return {
        categoria: row.argomento || 'Generale',
        count: row.count,
        percentuale: percentage
      };
    });

    res.json({ success: true, total, trends });
  } catch (error) {
    console.error("Errore calcolo trend:", error);
    res.status(500).json({ error: "Errore nel calcolo dei trend." });
  }
});

app.listen(PORT, () => {
  console.log(`Server FakeGPT attivo su http://localhost:${PORT}`);
});