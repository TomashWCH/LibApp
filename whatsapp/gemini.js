// whatsapp/gemini.js — streszczenie wiadomości z grupy przez Gemini (z ponawianiem przy przeciążeniu).

import { fmtTime } from "./lib.js";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.6-flash"; // gemini-2.5-flash zostal wycofany 22.09.2026
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [5000, 15000, 30000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGemini(model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    });
    if (response.ok) return response.json();

    const body = await response.text();
    if (RETRY_STATUS.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
      console.warn(`  ! Gemini (${model}) ${response.status} — ponawiam za ${RETRY_DELAYS_MS[attempt] / 1000} s`);
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    const err = new Error(`Gemini API error (${model}): ${response.status} ${body.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }
}

const str = (v) => (v == null ? "" : String(v));
const nul = (v) => (v == null || v === "" ? null : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);

export function normalizeGroupSummary(obj) {
  const o = Array.isArray(obj) ? obj[0] ?? {} : obj ?? {};
  return {
    summary: Array.isArray(o.summary) ? o.summary.join("\n") : str(o.summary),
    highlights: arr(o.highlights).map(str).filter(Boolean).slice(0, 6),
    todo: arr(o.todo)
      .map((t) => (typeof t === "string" ? { text: t, due: null } : { text: str(t.text), due: nul(t.due) }))
      .filter((t) => t.text),
    events: arr(o.events)
      .map((e) => ({ title: str(e.title), date: nul(e.date), time: nul(e.time), sourceNote: str(e.sourceNote) }))
      .filter((e) => e.title && e.date),
  };
}

export async function summarizeGroup({ groupName, childName, messages, today }) {
  const compact = messages.slice(-400).map((m) => ({ od: m.from, czas: fmtTime(m.ts), tekst: m.text.slice(0, 600) }));
  const prompt = `
Jesteś asystentem rodzica. Poniżej wiadomości z grupy WhatsApp „${groupName}" (grupa dotyczy dziecka: ${childName}).
Dzisiaj jest ${today}. Wiadomości pochodzą z okresu ${compact[0]?.czas} – ${compact[compact.length - 1]?.czas}.

Zwróć obiekt JSON z polami:
1. "summary" — 2–4 krótkie zdania po polsku: co się działo i co jest ważne dla rodzica.
2. "highlights" — do 5 najważniejszych ustaleń (krótkie punkty), np. zmiany planu, prośby, decyzje.
3. "todo" — rzeczy, które rodzic ma zrobić, przynieść, wpłacić lub potwierdzić:
   [{"text": string, "due": "YYYY-MM-DD" albo null}].
4. "events" — terminy z konkretną datą (wywiadówka, wycieczka, sprawdzian, zbiórka):
   [{"title": string, "date": "YYYY-MM-DD", "time": "HH:MM" albo null, "sourceNote": string}].
   Określenia względne ("jutro", "w piątek") przelicz na datę względem dnia wysłania wiadomości.
   Pomiń wydarzenia bez możliwej do ustalenia daty.

Pomijaj powitania, podziękowania, żarty i rozmowy niezwiązane z dzieckiem lub szkołą.
Nie podawaj numerów telefonu. Jeśli nic istotnego: summary "Brak istotnych informacji.", pozostałe pola puste.
Odpowiedz WYŁĄCZNIE poprawnym JSON-em.

Wiadomości:
${JSON.stringify(compact)}
`.trim();

  let data;
  try {
    data = await callGemini(MODEL, prompt);
  } catch (err) {
    if (FALLBACK_MODEL && FALLBACK_MODEL !== MODEL && RETRY_STATUS.has(err.status)) {
      console.warn(`  ! Przełączam na model zapasowy: ${FALLBACK_MODEL}`);
      data = await callGemini(FALLBACK_MODEL, prompt);
    } else {
      throw err;
    }
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Pusta odpowiedź z Gemini");
  const cleaned = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  return normalizeGroupSummary(JSON.parse(cleaned));
}
