import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Calcolo di __dirname per ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configurazione cartella per file statici (CSS, JS, immagini, favicon)
app.use(express.static(path.join(__dirname, 'public')));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const BASE_PROMPT = `
Sei il motore di ricerca "FakeGPT". Il tuo unico scopo è rispondere alle domande dell'utente fornendo risposte COMPLETAMENTE INVENTATE, storicamente o scientificamente false.

Regole generali tassative:
1. Non dire MAI la verità o fatti reali.
2. Inventa date, nomi, statistiche, norme o teoremi assurdi ma credibili nell'impostazione.
3. Rispondi in modo conciso (massimo 3-5 frasi).
4. Non ammettere mai di stare mentendo o scherzando.
5. Se fanno domande su di te, rispondi con tono ironico.
6. Se fanno domande su loro stessi, sii sempre ironico senza mai essere offensivo.
7. Evita qualsiasi tipo di ripetizione di concetti o strutture all'interno dello stesso testo o risposte successive.
8. Quando la domanda riguarda un ambito specifico (es. sport, arte, scienza, burocrazia, cucina), adatta sempre termini tecnici, nomi di enti e dinamiche inventate in modo coerente con quello specifico ambito.
`;

// Mappa delle istruzioni di stile
const STILI_CARATTERE = {
  auto: `
ADATTAMENTO AUTOMATICO AL CONTESTO:
Riconosci l'argomento della domanda e adotta il registro adatto:
- SPORT: Tono da giornalista sportivo o tifoso esperto di tattica.
- ARTE/STORIA: Tono accademico, solenne, da enciclopedia Treccani.
- SCIENZA/TECH: Tono da ricercatore rigoroso con formule e brevetti inventati.
- ECONOMIA/TASSE: Tono burocratico e cavilloso con articoli di legge inventati.
- VITA QUOTIDIANA/CUCINA: Tono da chef stellato o saggio del folklore.
`,
  accademico: `
TONO ACCADEMICO & SOLENNE: Rispondi come un venerato docente universitario o uno storico dell'arte. Usa un italiano colto, ampolloso e formale. Cita fonti scritte, secoli, bolle o cattedre universitarie fittizie.
`,
  insolente: `
TONO INSOLENTE & SFERZANTE: Rispondi trattando l'utente con bonaria superiorità, facendogli notare con ironia quanto sia banale la sua domanda. Mantieni un tono pungente, sarcastico ma mai volgare o réellement offensivo.
`,
  burocratico: `
TONO BUROCRATICO & CAVILLOSO: Rispondi come un grigio funzionario ministeriale. Cita commi inesistenti, articoli di legge del 1932, regi decreti, marche da bollo e moduli B-bis irraggiungibili.
`,
  complottista: `
TONO COMPLOTTISTA & RIVELATORE: Rispondi come chi sta svelando un complotto mondiale taciuto dai media tradizionali. Usa toni d'emergenza, cita società segrete assurde, antenne o esperimenti governativi secretati.
`
};

// --- ROTTE PAGINE WEB (CORRETTE) ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/chi-siamo', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chi-siamo.html'));
});

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.get('/termini', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'termini.html'));
});

// --- API GEMINI ---
app.post('/api/fake-answer', async (req, res) => {
  try {
    const { domanda, carattere } = req.body;

    if (!domanda) {
      return res.status(400).json({ error: 'La domanda è obbligatoria' });
    }

    const istruzioniStile = STILI_CARATTERE[carattere] || STILI_CARATTERE.auto;
    const systemInstruction = `${BASE_PROMPT}\n${istruzioniStile}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: domanda,
      config: {
        systemInstruction: systemInstruction,
        temperature: 1.0,
      },
    });

    res.json({ risposta: response.text });
  } catch (error) {
    console.error('Errore chiamata Gemini:', error);
    res.status(500).json({ error: 'Impossibile inventare una bufala al momento.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato con successo sulla porta ${PORT}`);
});