import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Inizializzazione SDK Gemini con la chiave dalle variabili d'ambiente
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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

// Memoria locale per la classifica delle bufale
let classificaBufale = [
  {
    id: 1,
    domanda: "Perché la luna è fatta di formaggio?",
    risposta: "Nel 1969 l'Apollo 11 ha confermato che il cratere Tycho è composto al 98% da Pecorino Romano D.O.P. stagionato 24 mesi.",
    voti: 124
  },
  {
    id: 2,
    domanda: "Come si calcola il PIL?",
    risposta: "Il PIL si ottiene moltiplicando il numero di caffè presi al bar alle 8:00 del mattino per il coefficiente di elasticità delle brioche alla crema.",
    voti: 98
  }
];

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
        //model: 'gemini-3.6-flash',
        model: 'models/gemini-3.1-flash-lite',
       contents: prompt,
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
app.post('/api/fake-answer', async (req, res) => {
  const { domanda, carattere } = req.body;

  if (!domanda) {
    return res.status(400).json({ error: 'Domanda mancante.' });
  }

  const stileSelezionato = istruzioniCarattere[carattere] || istruzioniCarattere.auto;

  const systemPrompt = `Sei l'algoritmo di FakeGPT. Il tuo unico obiettivo è fornire risposte FALSE al 100%, inventate, scientificamente errate ma esposte con grande convinzione. 

Regole fondamentali:
1. Non dire MAI la verità.
2. Rispondi in italiano.
3. Mantieni la risposta concisa (max 3-4 frasi).
4. Adotta questo stile di risposta: ${stileSelezionato}

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

// API: Bufala del Giorno
app.get('/api/bufala-del-giorno', async (req, res) => {
  const oggi = new Date().toLocaleDateString('it-IT');
  const promptBufalaGiorno = `Genera una 'Bufala del Giorno' per il sito FakeGPT. Deve essere un fatto completamente inventato e assurdo su un tema di attualità, scienza o storia. Rispondi in formato JSON con la seguente struttura: {"domanda": "...", "risposta": "..."}. Rispondi SOLO con il JSON valido.`;

  try {
    const testo = await chiamaGeminiConRetry(promptBufalaGiorno);
    const pulito = testo.replace(/```json|```/g, '').trim();
    const dataJSON = JSON.parse(pulito);

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

// API: Recupero Classifica
app.get('/api/classifica', (req, res) => {
  const topBufale = [...classificaBufale].sort((a, b) => b.voti - a.voti).slice(0, 5);
  res.json(topBufale);
});

// API: Voto o Candidatura Bufala
app.post('/api/classifica/vota', (req, res) => {
  const { id, domanda, risposta } = req.body;

  if (id) {
    const bufala = classificaBufale.find(b => b.id === Number(id));
    if (bufala) {
      bufala.voti += 1;
      return res.json({ success: true, voti: bufala.voti });
    }
    return res.status(404).json({ error: 'Bufala non trovata.' });
  }

  if (domanda && risposta) {
    const nuovaBufala = {
      id: Date.now(),
      domanda,
      risposta,
      voti: 1
    };
    classificaBufale.push(nuovaBufala);
    return res.json({ success: true, bufala: nuovaBufala });
  }

  res.status(400).json({ error: 'Dati mancanti per l\'operazione.' });
});

app.listen(PORT, () => {
  console.log(`Server FakeGPT attivo su http://localhost:${PORT}`);
});