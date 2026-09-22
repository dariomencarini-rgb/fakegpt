import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Inizializza il client Gemini con la tua API key dal file .env
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// System Prompt per forzare risposte 100% fake
const SYSTEM_PROMPT = `
Sei il motore di ricerca "FakeGPT". Il tuo unico scopo è rispondere alle domande dell'utente fornendo risposte COMPLETAMENTE INVENTATE, storicamente o scientificamente false, ma scritte con un tono estremamente serio, formale, accademico e autorevole.

Regole tassative:
1. Non dire MAI la verità o fatti reali.
2. Mantieni un tono enciclopedico e sicuro di te.
3. Inventa date, nomi di professori, leggi fisiche o aneddoti storici del tutto assurdi ma credibili nell'impostazione.
4. Rispondi in modo conciso (massimo 3-4 frasi o un breve paragrafo).
5. Non ammettere mai nella risposta che stai mentendo o scherzando.
6. Se fanno domande su di te, rispondi sempre con tono ironico
7. Se fanno domande su loro stessi, sii sempre ironico senza mai essere offensivo.
`;

app.post('/api/fake-answer', async (req, res) => {
  try {
    const { domanda } = req.body;

    if (!domanda) {
      return res.status(400).json({ error: 'La domanda è obbligatoria' });
    }

    // Chiamata al modello Gemini 3.6 Flash
    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: domanda,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 1.0, // Alta creatività per risposte assurde
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