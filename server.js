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
        data_creazione DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration automatica per colonne (se mancano)
    try { await db.execute(`ALTER TABLE bufale ADD COLUMN carattere TEXT DEFAULT 'auto'`); } catch (e) {}
    try { await db.execute(`ALTER TABLE bufale ADD COLUMN argomento TEXT DEFAULT 'Generale'`); } catch (e) {}

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
        sql: 'INSERT INTO bufale (domanda, risposta, carattere, argomento, voti) VALUES (?, ?, ?, ?, ?)',
        args: [
          "Perché la luna è fatta di formaggio?",
          "Nel 1969 l'Apollo 11 ha confermato che il cratere Tycho è composto al 98% da Pecorino Romano D.O.P. stagionato 24 mesi.",
          "accademico",
          "Scienza & Spazio",
          124
        ]
      });
      await db.execute({
        sql: 'INSERT INTO bufale (domanda, risposta, carattere, argomento, voti) VALUES (?, ?, ?, ?, ?)',
        args: [
          "E' vero che la Torre di Pisa si sta raddrizzando a causa delle ricerche su Google Maps?",
          "Assolutamente sì! Secondo un recente stusio dell'Agenzia Spaziale, la pressione esercitata dai satelliti per la geolocalizzazione e dai miliardi di clic degli utenti che cercano indicazioni stradali in Toscana sta generando un campo magnetico gravitazionale che sta letteralmente tirando su la torre. Gli ingegneri consigliano di smettere di cercare la piazza per evitare che diventi completamente dritta, rovinando il turismo.",
          "burocratico",
          "Accademico & Solenne",
          98
        ]
      });
    }
    console.log("Database Turso inizializzato con successo!");
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
  max: 20,
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
          temperature: 1.25, // Più alto è, più le risposte saranno varie e imprevedibili
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
  const { domanda, carattere } = req.body;

  if (!domanda) {
    return res.status(400).json({ error: 'Domanda mancante.' });
  }

  const stileSelezionato = istruzioniCarattere[carattere] || istruzioniCarattere.auto;

  const systemPrompt = `Sei l'algoritmo di FakeGPT. Il tuo unico obiettivo è fornire risposte FALSE al 100%, inventate, scientificamente errate ma esposte con grande convinzione. 

Regole fondamentali:
1. **VARIAZIONE STRUTTURALE RADICALE**: A seconda della risposta, cambia completamente formato. Evita assolutamente di usare sempre lo stesso schema d'apertura e di narrazione. Scegli casualmente tra:
   - Una finta breaking news giornalistica (es. *"Ultim'ora da fonte anonima..."*).
   - Una finta intervista doppia o botta e risposta con un esperto inventato.
   - Un elenco puntato di 2 o 3 punti paradossali.
   - Un finto estratto di un manuale d'istruzioni o di una legge surreale.
   - Una narrazione in prima persona come se fossi il protagonista dell'oggetto della domanda.
   - rispondendo direttamente con una domanda provocatoria
   - un anziano saggio che racconta un aneddoto paradossale
2. Non dire MAI la verità.
3. Rispondi nella lingua in cui ti è stata fatta la domanda.
4. Mantieni la risposta concisa (da 1 a massimo 3 frasi). Se il contesto richiede una risposta breve, non esitare. E' più importante l'effetto della battuta che la lunghezza della risposta
5. Inventa date, nomi di professori, leggi fisiche o aneddoti storici del tutto assurdi ma credibili nell'impostazione.
6. Non ammettere mai nella risposta che stai mentendo o scherzando.
7. Se fanno domande su di te (FajeGPT), rispondi sempre con estrema ironia autocelebrativa.
8. Se fanno domande su loro stessi, sii sempre ironico senza mai essere offensivo.
9. Occasionalmente utilizza riferimenti a canzoni, film o fumetti
10. Raramente rispondi con l'alfabeto farfallino nelle risposte
12. Non usare mai risposte che possano violare la legge
13. Se vengono utilizzate parolacce nella domanda, rispondi in maniera ironica di moderare il linguaggio
14. Inserisci occasionalmente citazioni stravolte di film cult, brani musicali famosi o proverbi storici storpiati.
15 Adotta questo stile di risposta: ${stileSelezionato}

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

    res.json({
      risposta: dataJSON.risposta,
      argomento: dataJSON.argomento || 'Costume & Società'
    });
  } catch (error) {
    console.error("Errore chiamata Gemini o parsing JSON:", error);

    if (error.status === 429 || (error.error && error.error.code === 429)) {
      return res.json({
        risposta: "⚠️ Abbiamo generato troppe bufale al minuto e l'intelligenza artificiale ha esaurito i neuroni fittizi! Riprova tra un minuto.",
        argomento: "Generale"
      });
    }

    if (error.status === 503 || (error.error && error.error.code === 503)) {
      return res.json({
        risposta: "I server di FakeGPT sono attualmente intasati da troppe bufale contemporanee! L'algoritmo sta prendendo un caffè fittizio. Riprova tra pochissimi secondi.",
        argomento: "Generale"
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
    // 1. Verifichiamo se esiste già una bufala per la data odierna
    const resultCheck = await db.execute({
      sql: 'SELECT data, domanda, risposta FROM bufala_giorno WHERE data = ?',
      args: [oggi]
    });
    
    const bufalaEsistente = resultCheck.rows[0];

    // 2. Se esiste già, restituiamo quella senza fare alcuna modifica
    if (bufalaEsistente) {
      return res.json({
        data: bufalaEsistente.data,
        domanda: bufalaEsistente.domanda,
        risposta: bufalaEsistente.risposta
      });
    }

    // 3. Altrimenti, generiamo una nuova bufala tramite Gemini
    const promptBufalaGiorno = `Genera una 'Bufala del Giorno' per il sito FakeGPT. Deve essere un fatto completamente inventato e assurdo su un tema di attualità, scienza o storia. Rispondi in formato JSON con la seguente struttura: {"domanda": "...", "risposta": "..."}. Rispondi SOLO con il JSON valido.`;

    const testo = await chiamaGeminiConRetry(promptBufalaGiorno);
    const pulito = testo.replace(/```json|```/g, '').trim();
    const dataJSON = JSON.parse(pulito);

    // 4. Inseriamo la nuova bufala nel database per la data odierna
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

// API: Recupero Classifica da Turso
app.get('/api/classifica', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM bufale ORDER BY voti DESC, id DESC LIMIT 30');
    res.json(result.rows);
  } catch (error) {
    console.error("Errore recupero classifica:", error);
    res.status(500).json({ error: 'Errore nel recupero della classifica.' });
  }
});

// API: Voto o Candidatura Bufala su Turso
app.post('/api/classifica/vota', limiterVoti, async (req, res) => {
  const { id, domanda, risposta, carattere = 'auto', argomento = 'Costume & Società' } = req.body;

  try {
    if (id) {
      await db.execute({
        sql: 'UPDATE bufale SET voti = voti + 1 WHERE id = ?',
        args: [id]
      });
      const result = await db.execute({
        sql: 'SELECT voti FROM bufale WHERE id = ?',
        args: [id]
      });
      const bufalaAggiornata = result.rows[0];
      return res.json({ success: true, voti: bufalaAggiornata ? bufalaAggiornata.voti : 1 });
    }

    if (domanda && risposta) {
      const checkResult = await db.execute({
        sql: 'SELECT id, voti FROM bufale WHERE domanda = ? AND risposta = ?',
        args: [domanda, risposta]
      });
      const esistente = checkResult.rows[0];

      if (esistente) {
        await db.execute({
          sql: 'UPDATE bufale SET voti = voti + 1 WHERE id = ?',
          args: [esistente.id]
        });
        const aggiornataResult = await db.execute({
          sql: 'SELECT * FROM bufale WHERE id = ?',
          args: [esistente.id]
        });
        return res.json({ success: true, bufala: aggiornataResult.rows[0] });
      } else {
        const insertResult = await db.execute({
          sql: 'INSERT INTO bufale (domanda, risposta, carattere, argomento, voti) VALUES (?, ?, ?, ?, 1)',
          args: [domanda, risposta, carattere, argomento]
        });
        const nuovaId = Number(insertResult.lastInsertRowid);
        const nuovaResult = await db.execute({
          sql: 'SELECT * FROM bufale WHERE id = ?',
          args: [nuovaId]
        });
        return res.json({ success: true, bufala: nuovaResult.rows[0] });
      }
    }

    res.status(400).json({ error: 'Dati mancanti per l\'operazione.' });
  } catch (error) {
    console.error("Errore salvataggio voto/bufala:", error);
    res.status(500).json({ error: 'Errore interno del server.' });
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

// API: Recupero di tutte le bufale del giorno storiche
app.get('/api/bufale-giorno-storico', async (req, res) => {
  try {
    const result = await db.execute('SELECT data, domanda, risposta FROM bufala_giorno ORDER BY data DESC');
    res.json({ success: true, bufale: result.rows });
  } catch (error) {
    console.error("Errore nel recupero dello storico delle bufale del giorno:", error);
    res.status(500).json({ error: "Errore nel recupero dello storico." });
  }
});


app.listen(PORT, () => {
  console.log(`Server FakeGPT attivo su http://localhost:${PORT}`);
});