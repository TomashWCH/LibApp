// LibApp — backend for the natural-language school search.
// Gemini never gets direct Firestore access. It can only request the controlled
// search_school_data tool below, which searches the already synchronized data
// belonging to the authenticated LibApp account.

import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";

initializeApp();
const db = getFirestore();

const PROJECT_ID = process.env.GCLOUD_PROJECT || "libapp-31f52";
const OWNER_UID = process.env.LIBAPP_OWNER_UID || "0mlgSYJpp7fSoCdl4BmTSSZId9s2";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.6-flash";
const API_KEY = process.env.GEMINI_API_KEY;
const TZ = "Europe/Warsaw";

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [1000, 3000, 7000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const arr = (v) => Array.isArray(v) ? v : [];
const str = (v) => v == null ? "" : String(v);

function normalize(s) {
  return str(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function todayISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}

function daysFromToday(n) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

function safeDate(value) {
  const s = str(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function pushDoc(out, doc) {
  if (!doc || !doc.text) return;
  const text = str(doc.text).replace(/\s+/g, " ").trim().slice(0, 1200);
  if (!text) return;
  out.push({
    source: doc.source || "Librus",
    child: doc.child || "",
    date: safeDate(doc.date),
    time: str(doc.time) || null,
    title: str(doc.title) || null,
    text,
  });
}

// Builds a small, searchable index from the existing Firestore document.
// WhatsApp raw history is intentionally not stored in users/{uid}; the query
// therefore searches its AI summaries, highlights, todos and extracted events.
function buildIndex(data) {
  const out = [];
  const children = data?.librus?.children || {};
  const waSummaries = data?.whatsapp?.summaries || {};
  const waTodos = data?.whatsapp?.todos || {};

  for (const [childKey, child] of Object.entries(children)) {
    const childName = str(child?.name || childKey);
    const sections = child?.sections || {};
    const extra = child?.extra || {};

    for (const e of arr(sections.events)) {
      pushDoc(out, { source: "Librus", child: childName, date: e.date, time: e.time, title: e.title, text: `${e.title || "Termin"}${e.sourceNote ? ` — ${e.sourceNote}` : ""}` });
    }
    for (const g of arr(sections.grades)) {
      pushDoc(out, { source: "Librus", child: childName, date: g.date, title: g.subject, text: `Ocena: ${g.subject || ""} ${g.grade || g.value || ""}${g.note ? ` — ${g.note}` : ""}` });
    }
    for (const r of arr(sections.remarks)) {
      pushDoc(out, { source: "Librus", child: childName, date: r.date, title: "Uwaga", text: `${r.text || ""}${r.teacher ? ` — ${r.teacher}` : ""}` });
    }
    for (const m of arr(sections.messages)) {
      pushDoc(out, { source: "Librus", child: childName, date: m.date, title: m.subject, text: `${m.subject || "Wiadomość"}${m.from ? ` — ${m.from}` : ""}` });
    }
    for (const a of arr(sections.announcements)) {
      pushDoc(out, { source: "Librus", child: childName, date: a.date, title: a.tytul || a.title, text: `${a.tytul || a.title || "Ogłoszenie"} ${a.tresc || a.content || ""}` });
    }
    for (const h of arr(extra.homework)) {
      pushDoc(out, { source: "Librus", child: childName, date: h.date || h.due, title: "Zadanie domowe", text: JSON.stringify(h) });
    }
    for (const t of arr(extra.timetable)) {
      pushDoc(out, { source: "Librus", child: childName, date: t.date, time: t.time, title: t.subject || t.name || "Lekcja", text: JSON.stringify(t) });
    }

    const wa = waSummaries[childKey];
    if (wa) {
      for (const entry of arr(wa.entries)) {
        const date = str(entry.atMs) ? new Date(Number(entry.atMs)).toLocaleDateString("en-CA", { timeZone: TZ }) : null;
        const text = [entry.summary, ...arr(entry.highlights)].filter(Boolean).join(". ");
        pushDoc(out, { source: "WhatsApp", child: childName, date, title: wa.groupName || "Grupa WhatsApp", text });
        for (const ev of arr(entry.events)) {
          pushDoc(out, { source: "WhatsApp", child: childName, date: ev.date, time: ev.time, title: ev.title, text: `${ev.title}${ev.sourceNote ? ` — ${ev.sourceNote}` : ""}` });
        }
        for (const todo of arr(entry.todo)) {
          pushDoc(out, { source: "WhatsApp", child: childName, date: todo.due, title: "Do zrobienia", text: todo.text });
        }
      }
    }
    for (const todo of arr(waTodos[childKey])) {
      pushDoc(out, { source: "WhatsApp", child: childName, date: todo.due, title: "Do zrobienia", text: todo.text });
    }
  }

  // A few global fields are useful for questions such as "co dziś".
  for (const ev of arr(data?.librus?.detectedEvents)) {
    pushDoc(out, { source: "Librus", child: ev.child, date: ev.date, time: ev.time, title: ev.title, text: ev.title });
  }

  return out;
}

function searchIndex(index, args = {}) {
  const query = normalize(args.query);
  if (!query) return [];

  const qTokens = [...new Set(query.split(/\s+/).filter((x) => x.length >= 2))];
  const source = str(args.source).toLowerCase();
  const child = normalize(args.child);
  const from = safeDate(args.date_from) || null;
  const to = safeDate(args.date_to) || null;
  const terms = new Set(qTokens);

  const scored = [];
  for (const item of index) {
    if (source && source !== "all" && item.source.toLowerCase() !== source) continue;
    if (child && !normalize(item.child).includes(child)) continue;
    if (from && item.date && item.date < from) continue;
    if (to && item.date && item.date > to) continue;

    const hay = normalize([item.title, item.text, item.child, item.source].filter(Boolean).join(" "));
    const title = normalize(item.title);
    let score = 0;
    for (const token of terms) {
      if (title.includes(token)) score += 5;
      else if (hay.includes(token)) score += 2;
    }
    if (!score) continue;
    if (item.date && item.date >= todayISO()) score += 1;
    scored.push({ score, item });
  }

  scored.sort((a, b) => b.score - a.score || String(a.item.date || "9999").localeCompare(String(b.item.date || "9999")));
  const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 12);
  return scored.slice(0, limit).map(({ item }) => item);
}

const toolDeclaration = {
  functionDeclarations: [{
    name: "search_school_data",
    description: "Przeszukuje zsynchronizowane dane szkolne rodzica z Librusa i WhatsAppa. Użyj tego narzędzia przed odpowiedzią na pytania o terminy, zbiórki, wycieczki, oceny, uwagi, wiadomości, zadania lub ustalenia rodziców.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "Najważniejsze słowa z pytania, np. 'zbiórka wycieczka' albo 'sprawdzian angielski'." },
        child: { type: "STRING", description: "Imię dziecka, jeśli pytanie dotyczy konkretnego dziecka; inaczej pomiń." },
        source: { type: "STRING", enum: ["all", "Librus", "WhatsApp"], description: "Źródło danych. Domyślnie all." },
        date_from: { type: "STRING", description: "Opcjonalnie YYYY-MM-DD." },
        date_to: { type: "STRING", description: "Opcjonalnie YYYY-MM-DD." },
        limit: { type: "INTEGER", description: "1-12, zwykle 6-8." },
      },
      required: ["query"],
    },
  }],
};

async function gemini(model, contents, tools = undefined) {
  if (!API_KEY) throw new Error("Brak GEMINI_API_KEY w konfiguracji funkcji.");
  const body = {
    contents,
    generationConfig: { temperature: 0.15 },
    ...(tools ? { tools } : {}),
  };
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return response.json();
    const raw = await response.text();
    if (RETRY_STATUS.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    const err = new Error(`Gemini API error ${response.status}: ${raw.slice(0, 500)}`);
    err.status = response.status;
    throw err;
  }
}

async function geminiWithFallback(contents, tools) {
  try {
    return await gemini(MODEL, contents, tools);
  } catch (err) {
    if (FALLBACK_MODEL && FALLBACK_MODEL !== MODEL && RETRY_STATUS.has(err.status)) {
      return gemini(FALLBACK_MODEL, contents, tools);
    }
    throw err;
  }
}

function answerPrompt(question, data, results) {
  return `Jesteś LibApp — rzeczowym asystentem rodzica. Odpowiadasz PO POLSKU.

Pytanie rodzica:
${question}

Wyniki wyszukiwania w zsynchronizowanych danych:
${JSON.stringify(results)}

Zasady:
- Odpowiadaj tylko na podstawie wyników wyszukiwania.
- Nie wymyślaj brakujących godzin, dat, miejsc ani szczegółów.
- Jeśli wyników brak lub są niejednoznaczne, powiedz to wprost i wskaż, czego brakuje.
- Przy terminie podaj datę i godzinę, jeśli są w danych.
- Jeśli są informacje z Librusa i WhatsAppa dotyczące tego samego zdarzenia, połącz je w jedną odpowiedź i zaznacz oba źródła.
- Możesz podać dziecko, grupę i źródło, jeśli pomaga to uniknąć nieporozumienia.
- Nie ujawniaj danych technicznych, identyfikatorów Firestore ani numerów telefonów.
- Odpowiedź ma być krótka: zwykle 1-4 zdania. Jeśli pytanie wymaga listy, użyj krótkich punktów.

Dzisiejsza data: ${todayISO()}.
Użytkownik jest zalogowany do konta LibApp: ${data.displayName || "rodzic"}.`;
}

export const askSchool = onCall({
  region: "europe-central2",
  timeoutSeconds: 60,
  memory: "256MiB",
  invoker: "public",
}, async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Zaloguj się do LibApp.");
  if (request.auth.uid !== OWNER_UID) throw new HttpsError("permission-denied", "To konto nie ma dostępu do danych LibApp.");

  const question = str(request.data?.question).trim();
  if (!question || question.length > 500) throw new HttpsError("invalid-argument", "Pytanie musi mieć od 1 do 500 znaków.");

  const snap = await db.collection("users").doc(OWNER_UID).get();
  if (!snap.exists) throw new HttpsError("failed-precondition", "Brak zsynchronizowanych danych.");
  const data = snap.data() || {};
  const index = buildIndex(data);

  const firstContents = [{ role: "user", parts: [{ text: `Pytanie rodzica: ${question}\n\nNajpierw zdecyduj, jakie dane szkolne trzeba znaleźć. Jeśli potrzebujesz danych z Librusa lub WhatsAppa, użyj narzędzia search_school_data. Nie odpowiadaj z wiedzy ogólnej.` }] }];
  let first;
  try {
    first = await geminiWithFallback(firstContents, [toolDeclaration]);
  } catch (err) {
    console.error("askSchool Gemini planning error", err);
    throw new HttpsError("unavailable", "Nie udało się skontaktować z asystentem. Spróbuj ponownie.");
  }

  const parts = first.candidates?.[0]?.content?.parts || [];
  const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

  // Awaryjnie: jeśli model nie wywołał narzędzia, wykonujemy szerokie wyszukiwanie
  // po całym pytaniu zamiast pozwalać mu zgadywać.
  const toolCalls = calls.length ? calls : [{ name: "search_school_data", args: { query: question, limit: 8 } }];
  const toolResults = [];
  for (const call of toolCalls.slice(0, 2)) {
    if (call.name !== "search_school_data") continue;
    const results = searchIndex(index, call.args || {});
    toolResults.push({ name: call.name, args: call.args || {}, results });
  }

  const flattened = [];
  const seen = new Set();
  for (const tr of toolResults) {
    for (const r of tr.results) {
      const key = JSON.stringify([r.source, r.child, r.date, r.time, r.title, r.text]);
      if (seen.has(key)) continue;
      seen.add(key);
      flattened.push(r);
    }
  }

  const secondContents = [
    ...firstContents,
    { role: "model", parts: parts.length ? parts : [{ text: "Wyszukuję dane." }] },
    ...toolResults.map((tr) => ({ role: "user", parts: [{ functionResponse: { name: tr.name, response: { results: tr.results } } }] })),
    { role: "user", parts: [{ text: answerPrompt(question, data, flattened) }] },
  ];

  let final;
  try {
    final = await geminiWithFallback(secondContents);
  } catch (err) {
    console.error("askSchool Gemini answer error", err);
    throw new HttpsError("unavailable", "Nie udało się przygotować odpowiedzi. Spróbuj ponownie.");
  }

  const answer = final.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
  if (!answer) throw new HttpsError("unavailable", "Asystent zwrócił pustą odpowiedź.");

  return {
    answer,
    sources: flattened.slice(0, 8).map((r) => ({ source: r.source, child: r.child, date: r.date, time: r.time, title: r.title })),
    generatedAt: new Date().toISOString(),
    projectId: PROJECT_ID,
  };
});
