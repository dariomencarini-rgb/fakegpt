import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import Database from 'better-sqlite3';
import rateLimit from 'express-rate-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Inizializzazione SDK Gemini con la chiave dalle variabili d'ambiente
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Inizializzazione Database SQLite permanente
const db = new Database('fakegpt.db');

// Creazione tabella bufale e inserimento dati iniziali di fallback se la tabella è vuota
db.exec(`
  CREATE TABLE IF NOT EXISTS bufale (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domanda TEXT NOT NULL,
    risposta TEXT NOT NULL,
    voti INTEGER DEFAULT 1,
    data_creazione DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Creazione tabella per memorizzare la Bufala del Giorno in modo persistente per data
db.exec(`
  CREATE TABLE IF NOT EXISTS bufala_giorno (
    data TEXT PRIMARY KEY,
    domanda TEXT NOT NULL,
    risposta TEXT NOT NULL
  )
`);

// Controllo se il db è vuoto per inserire le bufale storiche iniziali
const countCheck = db.prepare('SELECT COUNT(*) as count FROM bufale').get();
if (countCheck.count === 0) {
  const insertInit = db.prepare('INSERT INTO bufale (domanda, risposta, voti) VALUES (?, ?, ?)');
  insertInit.run(
    "Perché la luna è fatta di formaggio?",
    "Nel 1969 l'Apollo 11 ha confermato che il cratere Tycho è composto al 98% da Pecorino Romano D.O.P. stagionato 24 mesi.",
    124
  );
  insertInit.run(
    "Come si calcola il PIL?",
    "Il PIL si ottiene moltiplicando il numero di caffè presi al bar alle 8:00 del mattino per il coefficiente di elasticità delle brioche alla crema.",
    98
  );
}

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

// 1. Limitatore per la generazione di nuove bufale (protezione chiamate Gemini)
const limiterGenerazione = rateLimit({
  windowMs: 60 * 1000, // Finestra temporale di 1 minuto
  max: 6, // Massimo 6 richieste per indirizzo IP al minuto
  message: { error: "⚠️ Troppe richieste! Stai inventando troppe bufale al minuto. Riprova tra qualche secondo." },
  standardHeaders: true,
  legacyHeaders: false,
});

// 2. Limitatore per voti e candidature (anti-spam votazioni in classifica)
const limiterVoti = rateLimit({
  windowMs: 60 * 1000, // Finestra temporale di 1 minuto
  max: 20, // Massimo 20 voti o candidature al minuto per IP
  message: { error: "⚠️ Calma con i clic! Stai votando troppo velocemente." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Mappa delle personalità
const istruzioniCarattere = {
  auto: "Scegli un tono assurdo e inventato adatto al contesto della domanda.",
  accademico: "Usa un linguaggio estremamente formale, accademico e solenne, ma per dire cose totalmente false e senza senso.",
  insolente: "Rispondi in modo sfacciato, ironico e sferzante, prendendo in giro chi ha fatto la domanda mentre dici una bufala colossale.",
  burocratico: "Usa uno stile burocratico, infarcito di commi fittizi, cavilli inesistenti e terminologia amministrativa incomprensibile.",
  complottista: "Rispondi come un complottista convinto che rivela una 'scomoda verità' tenuta nascosta dai 'poteri forti'."
};

// Funzione helper per chiamare Gemini con retry automatico
async function chiamaGeminiConRetry(prompt, retries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: 'models/gemini-3.1-flash-lite', 
        contents: prompt,
        config: {
          temperature: 1.1, // Valore alto per massimizzare la creatività e l'assurdità delle bufale
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

// API: Generazione risposta Fake (protetta da limiterGenerazione)
app.post('/api/fake-answer', limiterGenerazione, async (req, res) => {
  const { domanda, carattere } = req.body;

  if (!domanda) {
    return res.status(400).json({ error: 'Domanda mancante.' });
  }

  const stileSelezionato = istruzioniCarattere[carattere] || istruzioniCarattere.auto;

  const systemPrompt = `Sei l'algoritmo di FakeGPT. Il tuo unico obiettivo è fornire risposte FALSE al 100%, inventate, scientificamente errate ma esposte con grande convinzione. 

Regole fondamentali:
1. Non dire MAI la verità.
2. Rispondi in italiano.
3. Mantieni la risposta concisa (max 2-3 frasi). Se il contesto richiede una risposta breve, non esitare. E' più importante l'effetto della battuta che la lunghezza della risposta
4. Inventa date, nomi di professori, leggi fisiche o aneddoti storici del tutto assurdi ma credibili nell'impostazione.
5. Non ammettere mai nella risposta che stai mentendo o scherzando.
6. Se fanno domande su di te, rispondi sempre con tono ironico
7. Se fanno domande su loro stessi, sii sempre ironico senza mai essere offensivo.
8. **VARIETÀ STRUTTURALE OBBLIGATORIA**: Cambia completamente stile e struttura a ogni risposta. Alterna approcci diversi: a volte inizia con una finta breaking news (es. *"Ultim'ora dal CNR..."*), a volte con una citazione letteraria inventata, a volte rispondendo direttamente con una domanda provocatoria, oppure fingendoti un manuale d'istruzioni burocratico o un anziano saggio che racconta un aneddoto paradossale. Evita assolutamente di usare sempre lo stesso schema d'apertura.
9. Adotta questo stile di risposta: ${stileSelezionato}

Domanda dell'utente: "${domanda}"`;

  try {
    const testoRisposta = await chiamaGeminiConRetry(systemPrompt);
    res.json({ risposta: testoRisposta });
  } catch (error) {
    console.error("Errore chiamata Gemini:", error);

    // Gestione dell'errore 429 (Quota / Limite richieste superato)
    if (error.status === 429 || (error.error && error.error.code === 429)) {
      return res.json({
        risposta: "⚠️ Abbiamo generato troppe bufale al minuto e l'intelligenza artificiale ha esaurito i neuroni fittizi! Riprova tra un minuto."
      });
    }

    // Gestione dell'errore 503 (Servizio temporaneamente occupato)
    if (error.status === 503 || (error.error && error.error.code === 503)) {
      return res.json({
        risposta: "I server di FakeGPT sono attualmente intasati da troppe bufale contemporanee! L'algoritmo sta prendendo un caffè fittizio. Riprova tra pochissimi secondi."
      });
    }

    res.status(500).json({ error: "Errore interno durante la generazione della risposta fake." });
  }
});

// API: Bufala del Giorno (con persistenza giornaliera su SQLite)
app.get('/api/bufala-del-giorno', async (req, res) => {
  const oggi = new Date().toLocaleDateString('it-IT');

  try {
    // 1. Controlla se esiste già una bufala salvata per oggi nel DB
    const stmtCheck = db.prepare('SELECT domanda, risposta FROM bufala_giorno WHERE data = ?');
    const bufalaEsistente = stmtCheck.get(oggi);

    if (bufalaEsistente) {
      return res.json({
        data: oggi,
        domanda: bufalaEsistente.domanda,
        risposta: bufalaEsistente.risposta
      });
    }

    // 2. Se non esiste, la genera tramite Gemini
    const promptBufalaGiorno = `Genera una 'Bufala del Giorno' per il sito FakeGPT. Deve essere un fatto completamente inventato e assurdo su un tema di attualità, scienza o storia. Rispondi in formato JSON con la seguente struttura: {"domanda": "...", "risposta": "..."}. Rispondi SOLO con il JSON valido.`;

    const testo = await chiamaGeminiConRetry(promptBufalaGiorno);
    const pulito = testo.replace(/```json|```/g, '').trim();
    const dataJSON = JSON.parse(pulito);

    // 3. Salva la nuova bufala nel database associandola alla data di oggi
    const stmtInsert = db.prepare('INSERT OR REPLACE INTO bufala_giorno (data, domanda, risposta) VALUES (?, ?, ?)');
    stmtInsert.run(oggi, dataJSON.domanda, dataJSON.risposta);

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

// API: Recupero Classifica da SQLite
app.get('/api/classifica', (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM bufale ORDER BY voti DESC, id DESC LIMIT 30');
    const topBufale = stmt.all();
    res.json(topBufale);
  } catch (error) {
    console.error("Errore recupero classifica:", error);
    res.status(500).json({ error: 'Errore nel recupero della classifica.' });
  }
});

// API: Voto o Candidatura Bufala su SQLite (protetta da limiterVoti)
app.post('/api/classifica/vota', limiterVoti, (req, res) => {
  const { id, domanda, risposta } = req.body;

  try {
    if (id) {
      const stmt = db.prepare('UPDATE bufale SET voti = voti + 1 WHERE id = ?');
      stmt.run(id);
      const bufalaAggiornata = db.prepare('SELECT voti FROM bufale WHERE id = ?').get(id);
      return res.json({ success: true, voti: bufalaAggiornata ? bufalaAggiornata.voti : 1 });
    }

    if (domanda && risposta) {
      // Verifica se esiste già la stessa identica bufala per evitare duplicati
      const checkStmt = db.prepare('SELECT id, voti FROM bufale WHERE domanda = ? AND risposta = ?');
      const esistente = checkStmt.get(domanda, risposta);

      if (esistente) {
        const updateStmt = db.prepare('UPDATE bufale SET voti = voti + 1 WHERE id = ?');
        updateStmt.run(esistente.id);
        const aggiornata = db.prepare('SELECT * FROM bufale WHERE id = ?').get(esistente.id);
        return res.json({ success: true, bufala: aggiornata });
      } else {
        const insertStmt = db.prepare('INSERT INTO bufale (domanda, risposta, voti) VALUES (?, ?, 1)');
        const info = insertStmt.run(domanda, risposta);
        const nuovaBufala = db.prepare('SELECT * FROM bufale WHERE id = ?').get(info.lastInsertRowid);
        return res.json({ success: true, bufala: nuovaBufala });
      }
    }

    res.status(400).json({ error: 'Dati mancanti per l\'operazione.' });
  } catch (error) {
    console.error("Errore salvataggio voto/bufala:", error);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server FakeGPT (server_2.js) attivo su http://localhost:${PORT}`);
});