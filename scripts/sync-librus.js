// scripts/sync-librus.js
//
// Uruchamiane cyklicznie przez GitHub Actions (.github/workflows/sync.yml).
// Dla każdego użytkownika (rodzica) z users.config.json i każdego jego dziecka:
//   1. loguje się do Librusa (login/hasło dziecka z sekretów GitHub Actions)
//   2. pobiera: oceny, uwagi, terminarz, wiadomości i ogłoszenia
//   3. wysyła dane do Gemini z prośbą o podział na sekcje:
//      oceny / uwagi / wydarzenia / wiadomości + krótkie streszczenie
//   4. zapisuje wynik do Firestore: users/{uid}.librus.children.<SUFFIX>
//
// Błąd dla jednego dziecka NIE przerywa synchronizacji pozostałych.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import Librus from "librus-api";
import * as cheerio from "cheerio";
import admin from "firebase-admin";
import fetch from "node-fetch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Ustawienia ----------
const NEW_DAYS = 7; // co uznajemy za "nowe" (oceny, uwagi, wiadomości)
// Numer wersji instrukcji dla Gemini przy wychwytywaniu zadań z wiadomości (punkt 8 w promptcie).
// Zwiększ tę liczbę za każdym razem, gdy zmienisz tamtą instrukcję — wiadomości oznaczone jako
// "sprawdzone" pod STARĄ wersją dostaną wtedy jeszcze jedną szansę z nowym, lepszym poleceniem,
// zamiast zostać pominięte na zawsze tylko dlatego, że raz już (niedoskonale) je sprawdzono.
const TODO_SCAN_VERSION = 2;
const EVENTS_AHEAD_DAYS = 60; // jak daleko w przód szukamy wydarzeń (kalendarz w appce)
const TZ = "Europe/Warsaw";

// ---------- Firebase Admin ----------
// Sekret GitHub Actions FIREBASE_SERVICE_ACCOUNT musi zawierać CAŁĄ zawartość
// pliku JSON klucza konta serwisowego.
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// ---------- Konfiguracja użytkowników ----------
const usersConfigPath = path.join(__dirname, "users.config.json");
const { users } = JSON.parse(readFileSync(usersConfigPath, "utf-8"));

// ---------- Godzina i dzień tygodnia w Warszawie (do przeglądu tygodnia) ----------
function warsawNowParts(date = new Date()) {
  const hour = Number(date.toLocaleString("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).slice(0, 2)) % 24;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    date.toLocaleDateString("en-US", { timeZone: TZ, weekday: "short" })
  );
  return { hour, weekday }; // weekday: 0 = niedziela
}

// ---------- Daty ----------
function isoInWarsaw(date) {
  return date.toLocaleDateString("sv-SE", { timeZone: TZ }); // YYYY-MM-DD
}
function shiftDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
const pad2 = (n) => String(n).padStart(2, "0");

// "2026-9-5" -> "2026-09-05"; zwraca null, gdy nie da się odczytać
function normalizeDay(text) {
  const m = String(text ?? "").match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[1]}-${pad2(m[2])}-${pad2(m[3])}` : null;
}

// ---------- Gemini ----------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite"; // nazwę można zmienić tu albo zmienną GEMINI_MODEL
// Model zapasowy — używany, gdy główny jest przeciążony mimo ponowień (503/429/5xx).
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.6-flash"; // gemini-2.5-flash zostal wycofany 22.09.2026
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [5000, 15000, 30000, 60000]; // 5 prob: od razu, po 5 s, 15 s, 30 s, 60 s
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wywołuje Gemini; przy chwilowych błędach (np. 503 "high demand") ponawia z przerwami.
async function callGemini(model, promptOrParts) {
  const parts = Array.isArray(promptOrParts) ? promptOrParts : [{ text: promptOrParts }];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    });
    if (response.ok) return response.json();

    const body = await response.text();
    if (RETRY_STATUS.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
      const wait = RETRY_DELAYS_MS[attempt];
      console.warn(
        `  ! Gemini (${model}) odpowiedział ${response.status} — ponawiam za ${wait / 1000} s (${attempt + 1}/${RETRY_DELAYS_MS.length})`
      );
      await sleep(wait);
      continue;
    }
    const err = new Error(`Gemini API error (${model}): ${response.status} ${body}`);
    err.status = response.status;
    throw err;
  }
}

function toText(value) {
  if (Array.isArray(value)) return value.join("\n");
  return String(value ?? "");
}
const asArray = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v == null ? "" : String(v));
const nul = (v) => (v == null || v === "" ? null : String(v));

// Ujednolica odpowiedź modelu, żeby appka zawsze dostawała ten sam kształt danych.
function normalizeAi(obj) {
  const o = Array.isArray(obj) ? obj[0] ?? {} : obj ?? {};
  return {
    summary: toText(o.summary),
    insights: {
      grades: nul(o.gradeInsight),
      remarks: nul(o.remarkPattern),
    },
    sections: {
      grades: asArray(o.grades).map((g) => ({
        subject: str(g.subject),
        grade: str(g.grade),
        date: nul(g.date),
        note: str(g.note),
      })),
      remarks: asArray(o.remarks).map((r) => ({
        text: str(r.text),
        teacher: str(r.teacher),
        date: nul(r.date),
        type: nul(r.type),
      })),
      // Pełna historia uwag (bez ograniczenia do "since") — osobne pole, żeby nie zmieniać
      // znaczenia "remarks" używanego gdzie indziej jako "nowe z ostatnich 7 dni".
      remarksAll: asArray(o.remarksAll).map((r) => ({
        text: str(r.text),
        teacher: str(r.teacher),
        date: nul(r.date),
        type: nul(r.type),
      })),
      // Rzeczy do zrobienia/przyniesienia wyłowione z treści wiadomości (nie z tematu) — osobno
      // od "remarksAll", bo to zupełnie inna kategoria (prośba nauczyciela, nie uwaga o dziecku).
      todo: asArray(o.todo).map((t) => ({
        text: str(t.text),
        due: nul(t.due),
      })),
      events: asArray(o.events)
        .map((e) => ({
          title: str(e.title),
          date: nul(e.date),
          time: nul(e.time),
          sourceNote: str(e.sourceNote),
        }))
        .filter((e) => e.title),
      messages: asArray(o.messages).map((m) => ({
        from: str(m.from),
        subject: str(m.subject),
        date: nul(m.date),
        unread: Boolean(m.unread),
        kind: str(m.kind) || "wiadomość",
      })),
    },
  };
}

async function summarizeWithGemini(rawData, childName, today, since, gradeTrends) {
  const prompt = `
Jesteś asystentem podsumowującym dziennik elektroniczny Librus dla rodzica.
Dane dotyczą dziecka: ${childName}.
Dzisiaj jest ${today} (strefa ${TZ}). Za "nowe" uznawaj rzeczy od ${since} (ostatnie ${NEW_DAYS} dni).

Z poniższych danych JSON przygotuj obiekt z polami:

1. "summary" — 2–4 krótkie zdania po polsku: co najważniejszego się wydarzyło
   i co nadchodzi. Jeśli nic istotnego: "Brak istotnych nowości."

2. "grades" — nowe oceny (od ${since}): [{"subject": string, "grade": string,
   "date": "YYYY-MM-DD" albo null, "note": string}]. Data i kategoria są zwykle
   w polu "opis" oceny. "note" to krótka kategoria/komentarz albo "".

3. "remarks" — uwagi z tekstu strony "uwagi_tekst" (od ${since}):
   [{"text": string, "teacher": string, "date": "YYYY-MM-DD" albo null,
   "type": "negatywna" | "pozytywna" | "informacja" | null}].
   Tekst strony zawiera też menu i inne elementy — ignoruj je.

3b. "remarksAll" — DOKŁADNIE to samo co punkt 3, ale bez ograniczenia do "${since}":
    zgłoś WSZYSTKIE uwagi, jakie znajdziesz w tekście strony "uwagi_tekst",
    niezależnie od daty. Ten sam kształt obiektów co w punkcie 3.

4. "events" — nadchodzące wydarzenia od dziś do ${EVENTS_AHEAD_DAYS} dni w przód
   z terminarza, ogłoszeń ORAZ wiadomości (sprawdziany, wycieczki, wywiadówki, terminy oddania):
   [{"title": string, "date": "YYYY-MM-DD", "time": "HH:MM" albo null,
   "sourceNote": string}]. Bez duplikatów. Nie zgaduj dat — pomiń wydarzenie bez daty.
   WAŻNE przy sprawdzianach/kartkówkach: jeśli nauczyciel w wiadomości napisał, z czego
   będzie sprawdzian (zakres materiału, rozdziały, zagadnienia), wpisz to W CAŁOŚCI do
   "sourceNote" — nie skracaj, nie streszczaj do kilku słów. To najważniejsza informacja
   dla rodzica przy tym wydarzeniu.

5. "messages" — wiadomości nieprzeczytane lub z ostatnich ${NEW_DAYS} dni oraz ogłoszenia:
   [{"from": string, "subject": string, "date": string albo null,
   "unread": true/false, "kind": "wiadomość" | "ogłoszenie"}].

6. "gradeInsight" — string albo null. Jedno krótkie zdanie po polsku o zauważalnym
   trendzie w ocenach, na podstawie pola "trendy_ocen" poniżej (już policzonych
   zmian średniej w ostatnich 30 dniach per przedmiot). Wybierz najbardziej
   znaczący trend (największa zmiana, zwłaszcza spadek). Jeśli "trendy_ocen"
   jest puste, ustaw null. Nie wymyślaj liczb spoza "trendy_ocen".

7. "remarkPattern" — string albo null. Jeśli w polu "remarks" (patrz punkt 3)
   znajdziesz 3 lub więcej wpisów, jedno krótkie zdanie po polsku opisujące,
   co się powtarza (np. podobny powód, ten sam nauczyciel, częstotliwość).
   W przeciwnym razie null.

Puste sekcje zwracaj jako []. Odpowiedz WYŁĄCZNIE poprawnym JSON-em.

Dane wejściowe:
${JSON.stringify(rawData)}

Trendy ocen (już policzone, do punktu 6):
${JSON.stringify(gradeTrends)}
`.trim();

  let data;
  try {
    data = await callGemini(GEMINI_MODEL, prompt);
  } catch (err) {
    const canFallback =
      GEMINI_FALLBACK_MODEL &&
      GEMINI_FALLBACK_MODEL !== GEMINI_MODEL &&
      RETRY_STATUS.has(err.status);
    if (!canFallback) throw err;
    console.warn(`  ! Przełączam na model zapasowy: ${GEMINI_FALLBACK_MODEL}`);
    data = await callGemini(GEMINI_FALLBACK_MODEL, prompt);
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Pusta odpowiedź z Gemini");

  const cleaned = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  return normalizeAi(JSON.parse(cleaned));
}

// ---------- Librus ----------
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(tr|p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

// Biblioteka do Librusa liczy miesiące od dzisiejszego dnia miesiąca, więc gdy miesiąc
// docelowy ma mniej dni niż dziś (np. dziś 31., a cel to luty), data "przeskoczy".
// Zwracamy tylko miesiące, dla których to nie grozi.
function safeMonthsAhead(now, count) {
  const out = [];
  for (let k = 1; k <= count; k++) {
    const target = new Date(now.getFullYear(), now.getMonth() + k, 1);
    const daysInTarget = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    if (daysInTarget >= now.getDate()) {
      out.push({ month: target.getMonth() + 1, year: target.getFullYear() });
    }
  }
  return out;
}

// ---------- Plan lekcji, zadania domowe, szczęśliwy numerek (bez Gemini — parsowanie wprost) ----------
const cleanText = (v, max = 120) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

const DAY_KEYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function addDaysISO(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}
function mondayOf(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // poniedziałek = 0
  return addDaysISO(iso, -dow);
}

// Wynik getTimetable ({ hours, table: { Monday: [komórki...], ... } }) -> [{ date, lessons: [...] }]
function parseTimetable(res, mondayISO) {
  const hours = asArray(res?.hours).map((h) => cleanText(h, 40));
  const out = [];
  for (let i = 0; i < 7; i++) {
    const lessons = [];
    asArray(res?.table?.[DAY_KEYS[i]]).forEach((cell, idx) => {
      if (!cell || !cell.title) return;
      const h = hours[idx] || "";
      const time = h.match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/);
      const nr = h.match(/^\s*(\d{1,2})\b/);
      lessons.push({
        nr: nr ? Number(nr[1]) : idx + 1,
        time: time ? `${time[1]}-${time[2]}` : "",
        title: cleanText(cell.title, 90),
        flag: cleanText(cell.flag, 60),
      });
    });
    if (lessons.length) out.push({ date: addDaysISO(mondayISO, i), lessons });
  }
  return out;
}

// ---------- Pełna treść wiadomości (żeby czytać je w appce, bez przełączania do Librusa) ----------
// Rozpoznanie sprawdzianu/kartkówki po tytule w terminarzu — używa tego samego EXAM_RE,
// które jest już zdefiniowane niżej (przegląd tygodnia), żeby nie trzymać dwóch wzorców.
// Ile szczegółów pojedynczych wpisów terminarza (z polem "Opis") pobieramy max w jednej
// synchronizacji — to osobne zapytanie na KAŻDY wpis, więc ograniczamy do sprawdzianów
// i rozsądnej liczby, żeby nie wydłużać synchronizacji bez potrzeby.
const EXAM_DETAIL_LIMIT = 25;
const MESSAGE_BODY_LIMIT = 20; // ile wiadomości max pobieramy w jednej synchronizacji (nieprzeczytane najpierw)
const MESSAGE_BODY_CONCURRENCY = 3;

// ---------- Załączniki PDF: pobranie i streszczenie przez Gemini (z pamięcią wyników) ----------
const PDF_NEW_LIMIT = 3; // ile NOWYCH załączników max analizujemy w jednej synchronizacji (biblioteka do Librusa bywa tu wolna/kapryśna)
const STUDY_MATERIAL_NEW_LIMIT = 5; // ile NOWYCH materiałów do nauki generujemy max w jednej synchronizacji — raz wygenerowany zapamiętujemy na stałe, więc to tylko koszt pierwszego pojawienia się sprawdzianu
const PDF_MAX_BYTES = 15 * 1024 * 1024; // limit wielkości pliku wysyłanego do Gemini
const PDF_TIMEOUT_MS = 25000; // twardy limit czasu na pobranie JEDNEGO załącznika — nie blokujemy reszty synchronizacji


function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`przekroczono limit czasu (${label})`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Biblioteka do Librusa zwraca plik jako strumień (czasem Buffer/string) — ujednolicamy do Buffer.
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return Promise.resolve(data);
  if (typeof data === "string") return Promise.resolve(Buffer.from(data, "binary"));
  if (data && typeof data.on === "function") {
    return new Promise((resolve, reject) => {
      const chunks = [];
      data.on("data", (c) => chunks.push(c));
      data.on("end", () => resolve(Buffer.concat(chunks)));
      data.on("error", reject);
    });
  }
  return Promise.reject(new Error("nieznany format odpowiedzi pliku"));
}

// Pobiera i streszcza JEDEN załącznik PDF. Nigdy nie rzuca dalej — przy jakimkolwiek
// problemie (pobranie, rozmiar, format, Gemini) zwraca null, a wiadomość zostaje bez analizy.
async function analyzePdfAttachment(client, path, name) {
  if (!/\.pdf$/i.test(String(name || ""))) return null;
  let buf;
  try {
    const raw = await withTimeout(client.inbox.getFile(path), PDF_TIMEOUT_MS, `pobieranie ${name}`);
    buf = await toBuffer(raw);
  } catch (err) {
    console.warn(`  ! nie udało się pobrać załącznika "${name}": ${err.message}`);
    return null;
  }
  if (buf.length === 0 || buf.length > PDF_MAX_BYTES) {
    console.warn(`  ! pomijam załącznik "${name}" — nieprawidłowy lub zbyt duży rozmiar (${buf.length} B)`);
    return null;
  }
  if (buf.slice(0, 4).toString("latin1") !== "%PDF") {
    console.warn(`  ! pomijam załącznik "${name}" — to nie jest plik PDF`);
    return null;
  }

  const prompt = `
Poniższy plik PDF to załącznik do wiadomości ze szkolnego dziennika elektronicznego
(zgoda, zbiórka, informacja od nauczyciela itp.). Wyciągnij PO POLSKU z tego dokumentu:

1. "opis" — jedno krótkie zdanie, czego dokument dotyczy.
2. "termin" — "YYYY-MM-DD" jeśli w dokumencie jest konkretna data, albo null.
3. "kwota" — kwota do zapłaty jako string (np. "25 zł") jeśli jest, albo null.
4. "doZrobienia" — string albo null: co rodzic/uczeń ma zrobić lub przynieść
   (np. podpisać i oddać, przynieść strój). Krótko, jedno zdanie.

Jeśli dokumentu nie da się sensownie streścić (np. nieczytelny skan), ustaw
wszystkie pola poza "opis" na null, a "opis" na "Nie udało się odczytać dokumentu."

Odpowiedz WYŁĄCZNIE poprawnym JSON-em z dokładnie tymi czterema polami.
`.trim();

  const parts = [{ text: prompt }, { inlineData: { mimeType: "application/pdf", data: buf.toString("base64") } }];
  try {
    let data;
    try {
      data = await withTimeout(callGemini(GEMINI_MODEL, parts), PDF_TIMEOUT_MS, `analiza ${name}`);
    } catch (err) {
      const canFallback = GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL && RETRY_STATUS.has(err.status);
      if (!canFallback) throw err;
      data = await withTimeout(callGemini(GEMINI_FALLBACK_MODEL, parts), PDF_TIMEOUT_MS, `analiza ${name}`);
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    const cleaned = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
    const p = JSON.parse(cleaned);
    return {
      opis: cleanText(p.opis, 200),
      termin: normalizeDay(p.termin),
      kwota: cleanText(p.kwota, 30) || null,
      doZrobienia: cleanText(p.doZrobienia, 200) || null,
    };
  } catch (err) {
    console.warn(`  ! nie udało się przeanalizować załącznika "${name}": ${err.message}`);
    return null;
  }
}

// Pobiera pełną treść wybranych wiadomości (limit + kilka równolegle). Błąd pojedynczej
// wiadomości nie przerywa reszty — po prostu nie będzie miała treści do podglądu w appce.
// attachmentCache: Map "messageId:nazwaPliku" -> wcześniej policzona analiza PDF (żeby nie
// płacić za to samo dwa razy przy każdej synchronizacji).
async function fetchMessageBodies(client, wiadomosciZrodlo, attachmentCache = new Map()) {
  const candidates = wiadomosciZrodlo
    .filter((m) => Number.isFinite(m.id))
    .sort((a, b) => Number(!!a.read) - Number(!!b.read)) // nieprzeczytane (read: false) najpierw
    .slice(0, MESSAGE_BODY_LIMIT);

  const out = [];
  let i = 0;
  let failed = 0;
  let pdfBudget = PDF_NEW_LIMIT;
  const worker = async () => {
    while (i < candidates.length) {
      const m = candidates[i++];
      try {
        const full = await client.inbox.getMessage(5, m.id); // 5 = folder "Odebrane" (potwierdzone wprost z menu folderów — "6" z biblioteki było błędne, to "Wysłane")
        const files = asArray(full?.files);
        const zalaczniki = [];
        for (const f of files) {
          const name = cleanText(f?.name, 100);
          if (!name) continue;
          const cacheKey = `${m.id}:${name}`;
          let analysis = attachmentCache.get(cacheKey) ?? null;
          if (!analysis && pdfBudget > 0 && /\.pdf$/i.test(name) && f?.path) {
            pdfBudget--;
            analysis = await analyzePdfAttachment(client, f.path, name);
          }
          zalaczniki.push({ name, analysis });
        }
        out.push({
          id: m.id,
          od: cleanText(m.user, 80),
          temat: cleanText(m.title, 160),
          data: cleanText(m.date, 30),
          nieprzeczytana: !m.read,
          tresc: cleanText(full?.content, 4000),
          zalaczniki,
        });
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: MESSAGE_BODY_CONCURRENCY }, worker));

  if (failed) console.warn(`  ! nie udało się pobrać treści ${failed} wiadomości (temat/nadawca zostają widoczne, bez pełnego tekstu)`);
  return out;
}

// ---------- Trendy ocen (JS, bez Gemini) — do wplecenia w istniejący prompt podsumowania ----------
// Do średniej liczą się oceny z cyfrą, których nauczyciel nie wyłączył ze średniej (jak w Librusie).
function computeGradeTrends(gradeList, today) {
  const countable = (g) => !g.final && g.inAvg !== false && g.num != null;
  const bySubject = new Map();
  for (const g of gradeList) {
    if (!countable(g)) continue;
    if (!bySubject.has(g.subject)) bySubject.set(g.subject, []);
    bySubject.get(g.subject).push(g);
  }
  const wavg = (list) => {
    let sw = 0, sum = 0;
    for (const g of list) { const w = g.weight || 1; sw += w; sum += g.num * w; }
    return sw ? sum / sw : null;
  };
  const since30 = addDaysISO(today, -30);
  const out = [];
  for (const [subject, list] of bySubject) {
    const now = wavg(list.filter((g) => g.date && g.date <= today));
    const before = wavg(list.filter((g) => g.date && g.date <= since30));
    if (now == null || before == null) continue;
    const delta = Math.round((now - before) * 100) / 100;
    if (Math.abs(delta) >= 0.4) out.push({ subject, avgNow: Math.round(now * 100) / 100, deltaOstatnie30dni: delta });
  }
  return out.sort((a, b) => Math.abs(b.deltaOstatnie30dni) - Math.abs(a.deltaOstatnie30dni)).slice(0, 3);
}

// ---------- Pełna lista ocen (bez Gemini) ----------
function infoField(info, label) {
  const m = String(info ?? "").match(new RegExp(`${label}\\s*:\\s*([^\\n]*)`, "i"));
  return m ? m[1].trim() : "";
}

// Oceny z całego roku -> [{ id, subject, value, base, num, weight, inAvg, final, date, sem, category, teacher, comment }]
// num: wartość liczbowa (plus = +0,5, minus = -0,25); base: 1–6; final: ocena śródroczna/roczna/przewidywana.
// Oceny bez cyfry (np. literowe F, W, B, D, P) trafiają na listę z base = null: są widoczne, ale nie liczą się do średniej.
function makeGrade(subjectName, g) {
  if (!cleanText(subjectName, 1)) {
    console.warn(`  ! nie ustalono przedmiotu dla oceny "${g.value}" (id=${g.id ?? "brak"}) - trafi jako "Inne oceny"`);
  }
  const value = cleanText(g.value, 6);
  const m = value.match(/^([1-6])([+-])?$/);
  const base = m ? Number(m[1]) : null;
  const num = m ? base + (m[2] === "+" ? 0.5 : m[2] === "-" ? -0.25 : 0) : null;
  const category = cleanText(infoField(g.info, "Kategoria"), 60);
  const date = normalizeDay(infoField(g.info, "Data"));
  const weight = parseInt(infoField(g.info, "Waga"), 10);
  const month = date ? Number(date.slice(5, 7)) : null;
  return {
    id: Number.isFinite(g.id) && g.id > 0 ? g.id : null, // id=0 to placeholder Librusa (dekoracja), nie prawdziwa ocena
    subject: cleanText(subjectName, 60) || "Inne oceny",
    value,
    base,
    num,
    weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
    inAvg: !/^\s*nie/i.test(infoField(g.info, "Licz do średniej")),
    final: /(śródroczn|roczn|przewidywan)/i.test(category),
    date,
    sem: month == null ? 0 : month >= 2 && month <= 8 ? 2 : 1, // przybliżenie: II semestr od lutego
    category,
    teacher: cleanText(infoField(g.info, "Nauczyciel"), 60),
    comment: cleanText(infoField(g.info, "Komentarz"), 140),
  };
}

// subjects: wynik biblioteki (oceny z głównej tabeli); boxes: wszystkie pola ocen ze strony (także z innych tabel)
function buildGradeList(subjects, boxes = []) {
  const seen = new Set();
  const out = [];
  const add = (subjectName, g) => {
    const key = Number.isFinite(g.id) ? g.id : `${subjectName}|${g.value}|${g.info}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(makeGrade(subjectName, g));
  };
  for (const s of asArray(subjects)) {
    if (!s?.name) continue;
    for (const sem of asArray(s.semester)) for (const g of asArray(sem?.grades)) add(s.name, g);
  }
  for (const b of asArray(boxes)) {
    // Prawdziwa ocena zawsze ma albo numeryczny identyfikator (link do szczegolow oceny),
    // albo nazwe przedmiotu. Pole bez jednego i drugiego to zwykle cos innego znalezione
    // przy okazji na stronie (np. legenda kolorow ze skala ocen) - pomijamy je.
    if (b && cleanText(b.value, 6) && ((Number.isFinite(b.id) && b.id > 0) || cleanText(b.subject || b.section, 60))) {
      add(b.subject || b.section, b);
    }
  }
  return out
    .sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")))
    .slice(-600);
}

// Wszystkie pola ocen na stronie ocen (biblioteka czyta tylko główną tabelę, więc oceny z innych
// tabel — np. literowe — mogłyby zostać pominięte). Zwraca też przedmiot i nagłówek tabeli.
function fetchAllGradeBoxes(client) {
  return client._mapper("przegladaj_oceny/uczen", "table.decorated span.grade-box", ($, el) => {
    const $el = $(el);
    const a = $el.find("a").first();
    const clean = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
    const value = clean(a.length ? a.text() : $el.text());
    // przedmiot = pierwsza komórka wiersza, która nie zawiera pól ocen (zwykle druga, a w innych tabelach pierwsza)
    const cells = $el.closest("tr").children("td").toArray();
    let subject = "";
    for (const idx of [1, 0, 2, 3]) {
      const c = cells[idx];
      if (!c) continue;
      const t = clean($(c).text());
      if (t && t.length <= 60 && $(c).find("span.grade-box").length === 0) { subject = t; break; }
    }
    return {
      id: parseInt(String(a.attr("href") || "").split("/").pop(), 10),
      value,
      info: String(a.attr("title") || "").replace(/<\s*br\s*\/?\s*>/gi, "\n"),
      subject,
      section: clean($el.closest("table").find("th").first().text()).slice(0, 40),
    };
  });
}

// ---------- Plan lekcji z API Synergii (gateway/api/2.0) ----------
// Nowy układ Librusa (panel ucznia) nie ma już starej tabeli planu, więc pobieramy dane z tego samego API,
// z którego korzysta przeglądarka. Wymaga sesji utworzonej przez client.authorize().
const GATEWAY = "https://synergia.librus.pl/gateway/api/2.0";

async function apiGet(client, pathAndQuery) {
  const res = await client.caller.get(`${GATEWAY}/${pathAndQuery}`, { headers: { Accept: "application/json" } });
  let data = res.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { throw new Error("API zwróciło nie-JSON (sesja mogła nie zadziałać)"); }
  }
  return data;
}

const hhmm = (v) => {
  const m = String(v ?? "").match(/(\d{1,2}):(\d{2})/);
  return m ? `${pad2(m[1])}:${m[2]}` : "";
};

// Słowniki (przedmioty, nauczyciele, sale) — pobierane tylko wtedy, gdy wpis planu ma same identyfikatory.
async function loadLookups(client) {
  const grab = async (path, key) => {
    try {
      const d = await apiGet(client, path);
      return Object.fromEntries(asArray(d?.[key]).map((x) => [String(x.Id), x]));
    } catch {
      return {};
    }
  };
  const [subjects, users, classrooms] = await Promise.all([grab("Subjects", "Subjects"), grab("Users", "Users"), grab("Classrooms", "Classrooms")]);
  return { subjects, users, classrooms };
}

const personName = (p) => cleanText([p?.FirstName, p?.LastName].filter(Boolean).join(" "), 40);

// Wynik Timetables?weekStart=... -> [{ date, lessons: [{ nr, time, title, teacher, room, flag }] }]
function parseApiTimetable(json, lookups = {}) {
  const tt = json?.Timetable ?? {};
  const days = [];
  for (const [date, slots] of Object.entries(tt)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const lessons = [];
    for (const slot of asArray(slots)) {
      for (const e of asArray(slot)) {
        if (!e || typeof e !== "object") continue;
        const subj = e.Subject?.Name ? e.Subject : lookups.subjects?.[String(e.Subject?.Id)] ?? e.Subject ?? {};
        const teacher = e.Teacher?.LastName ? e.Teacher : lookups.users?.[String(e.Teacher?.Id)] ?? e.Teacher ?? {};
        const room = e.Classroom?.Name ?? e.Classroom?.Symbol ?? lookups.classrooms?.[String(e.Classroom?.Id)]?.Name ?? lookups.classrooms?.[String(e.Classroom?.Id)]?.Symbol ?? "";
        const title = cleanText(subj.Name || e.OrgSubject?.Name || subj.Short || "", 90);
        if (!title && !e.LessonNo) continue;
        const from = hhmm(e.HourFrom), to = hhmm(e.HourTo);
        const nr = Number(e.LessonNo ?? e.SubjectNo);
        lessons.push({
          nr: Number.isFinite(nr) ? nr : lessons.length + 1,
          time: from && to ? `${from}-${to}` : from,
          title: title || "Lekcja",
          teacher: personName(teacher),
          room: cleanText(room, 20),
          flag: e.IsCanceled ? "odwołane" : e.IsSubstitutionClass ? "zastępstwo" : "",
        });
      }
    }
    if (lessons.length) days.push({ date, lessons: lessons.sort((a, b) => a.nr - b.nr) });
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

// Zwraca dni z lekcjami z API; przy błędzie lub pustej odpowiedzi — pusta lista (wtedy działa stary parser).
async function fetchTimetableApi(client, mondayISO, state) {
  const json = await apiGet(client, `Timetables?weekStart=${mondayISO}`);
  if (!state.described) {
    state.described = true;
    const firstDay = Object.values(json?.Timetable ?? {}).find((v) => asArray(v).flat().length);
    const entry = asArray(firstDay).flat()[0];
    console.log(`  plan (API): klucze odpowiedzi: ${Object.keys(json ?? {}).join(",") || "brak"}; wpis: ${entry ? Object.keys(entry).join(",") : "brak wpisów"}`);
  }
  // UWAGA: trzeba sprawdzić WSZYSTKIE pola, które mogą przyjść jako samo id/url bez nazwy
  // (przedmiot, nauczyciel, sala) — wcześniej sprawdzano tylko przedmiot, więc gdy ten akurat
  // przychodził z nazwą, appka nigdy nie dociągała słownika sal, nawet gdy sala go wymagała.
  const needLookups = Object.values(json?.Timetable ?? {}).some((day) =>
    asArray(day).flat().some((e) => (e?.Subject && !e.Subject.Name) || (e?.Teacher && !e.Teacher.LastName) || (e?.Classroom && !e.Classroom.Name && !e.Classroom.Symbol))
  );
  if (needLookups && !state.lookups) state.lookups = await loadLookups(client);
  return parseApiTimetable(json, state.lookups ?? {});
}

// Gdy pole oceny nie ma podpowiedzi (title) z datą i kategorią — np. oceny opisowe/literowe w edukacji
// wczesnoszkolnej — dociągamy szczegóły oceny ze strony szczegółów (max 40, po 3 równolegle).
async function enrichBoxes(client, boxes) {
  const need = asArray(boxes).filter((b) => Number.isFinite(b.id) && !String(b.info || "").trim()).slice(0, 40);
  let i = 0;
  const worker = async () => {
    while (i < need.length) {
      const b = need[i++];
      try {
        const d = await client.info.getGrade(b.id);
        if (d) {
          b.info = [
            `Kategoria: ${cleanText(d.category, 60)}`,
            `Data: ${cleanText(d.date, 30)}`,
            `Nauczyciel: ${cleanText(d.teacher, 60)}`,
            `Licz do średniej: ${d.inAverage === false ? "nie" : "tak"}`,
            `Waga: ${cleanText(d.multiplier, 6)}`,
            `Komentarz: ${cleanText(d.comment, 140)}`,
          ].join("\n");
        }
      } catch {
        /* pojedyncza ocena bez szczegółów nie blokuje reszty */
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return boxes;
}

// ---------- Frekwencja (bez Gemini) ----------
// Biblioteka nie podaje nazwy przedmiotu przy pojedynczej nieobecności (tylko kod typu,
// np. "n" - nieobecność, "u" - usprawiedliwiona, "s" - spóźnienie, "zw" - zwolniony;
// dokładne kody zależą od szkoły), więc liczymy je zbiorczo po dniu i typie.
function buildAbsenceSummary(grouped) {
  const days = [];
  const byType = {};
  let total = 0;
  for (const list of Object.values(grouped || {})) {
    for (const entry of asArray(list)) {
      const date = normalizeDay(entry?.date) ?? cleanText(entry?.date, 20);
      if (!date) continue;
      const counts = {};
      for (const cell of asArray(entry?.table)) {
        const type = cleanText(cell?.type, 10);
        if (!type) continue;
        counts[type] = (counts[type] || 0) + 1;
        byType[type] = (byType[type] || 0) + 1;
        total++;
      }
      if (Object.keys(counts).length) days.push({ date, counts });
    }
  }
  days.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { total, byType, days: days.slice(0, 60) };
}

// Zadania z modułu "Moje zadania". Zwraca [{ subject, title, teacher, type, from, to, status }].
async function fetchHomework(client, today) {
  const subjects = asArray(await client.homework.listSubjects()).filter(Boolean);
  const all = subjects.find((s) => !Number.isFinite(s.id) || s.id <= 0 || /wszystk/i.test(s.name));
  const ids = all
    ? [Number.isFinite(all.id) ? all.id : -1]
    : subjects.map((s) => s.id).filter(Number.isFinite).slice(0, 25);
  const from = addDaysISO(today, -14);
  const to = addDaysISO(today, 45);

  const seen = new Set();
  const rows = [];
  for (const id of ids) {
    for (const r of asArray(await client.homework.listHomework(id, from, to))) {
      if (!r || seen.has(r.id)) continue;
      seen.add(r.id);
      rows.push({
        subject: cleanText(r.subject, 60),
        title: cleanText(r.title, 140),
        teacher: cleanText(r.user, 60),
        type: cleanText(r.type, 40),
        from: normalizeDay(r.from) ?? cleanText(r.from, 20),
        to: normalizeDay(r.to) ?? cleanText(r.to, 20),
        status: cleanText(r.status, 40),
      });
    }
  }
  return rows
    .filter((r) => !isoLike(r.to) || r.to >= addDaysISO(today, -7))
    .sort((a, b) => String(a.to).localeCompare(String(b.to)))
    .slice(0, 60);
}
const isoLike = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ""));

// Firestore nie przyjmuje undefined/NaN — czyścimy przez JSON.
const clean = (v) => JSON.parse(JSON.stringify(v ?? null));

// Pobiera pole "Opis" ze szczegółów pojedynczego wpisu terminarza, czytając i parsując stronę
// SAMODZIELNIE — biblioteka librus-api ma tu błąd (client.calendar.getEvent): zrzuca wszystkie
// etykiety <th> i wszystkie wartości <td> z całej tabeli do dwóch osobnych list i zestawia je
// po kolejności (indeksie), zamiast parować je wiersz po wierszu. Gdy który wiersz ma więcej niż
// jedną komórkę z wartością (np. lekcja dzielona na dwie klasy), wszystko po nim się przesuwa i
// pole "Opis" dostaje wartość z zupełnie innego wiersza. Dlatego parsujemy to sami, wiersz po
// wierszu — odporne na taką nieregularność.
// Zwraca {description, subject, kind} ze szczegółów wpisu terminarza. Przedmiot i rodzaj
// pobieramy stąd TEŻ bezpośrednio (nie tylko opis) — tytuł ze zbiorczej listy kalendarza
// bywa bałaganem ("Nr lekcji: 5 Język niemiecki, kartkówka 5c SP"), więc budujemy czysty
// tytuł sami, zamiast próbować dopasować to do tego, co osobno wymyśli Gemini.
async function fetchEventDescription(client, id) {
  const html = await client.caller.get(`https://synergia.librus.pl/terminarz/szczegoly/${id}`).then((r) => r.data);
  const $ = cheerio.load(html);
  const table = $("table.decorated.medium.center tbody").first();
  const byLabel = {};
  table.find("tr").each((_, tr) => {
    const label = $(tr).find("th").first().text().trim();
    const val = $(tr).find("td").map((__, td) => $(td).text().trim()).get().filter(Boolean).join(" ");
    if (label) byLabel[label] = val;
  });
  return {
    description: cleanText(byLabel["Opis"], 600),
    subject: cleanText(byLabel["Przedmiot"], 90),
    kind: cleanText(byLabel["Rodzaj"], 40),
  };
}

async function fetchLibrusData(login, password, today, since, until, attachmentCache) {
  const client = new Librus();
  // UWAGA: biblioteka połyka błędy logowania, dlatego niżej sprawdzamy, czy
  // Librus w ogóle zwrócił jakiekolwiek dane.
  // Librus (albo połączenie do niego z serwerów GitHuba) bywa wolny — logowanie ma
  // krótki, ustalony limit prób, zanim się poddamy (jak przy Gemini, ale mniej prób,
  // bo to pierwszy krok i nie chcemy niepotrzebnie wydłużać każdej synchronizacji).
  const LOGIN_RETRY_DELAYS_MS = [3000, 8000];
  for (let attempt = 0; ; attempt++) {
    try {
      await client.authorize(login, password);
      break;
    } catch (err) {
      if (attempt >= LOGIN_RETRY_DELAYS_MS.length) throw err;
      const wait = LOGIN_RETRY_DELAYS_MS[attempt];
      console.warn(`  ! logowanie do Librusa: ${err.message} — ponawiam za ${wait / 1000} s (${attempt + 1}/${LOGIN_RETRY_DELAYS_MS.length})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  const failures = [];
  const safe = (label, promise, fallback) =>
    promise.catch((err) => {
      failures.push(label);
      console.warn(`  ! ${label}: ${err.message}`);
      return fallback;
    });

  const now = new Date();
  const monthsAhead = safeMonthsAhead(now, 2); // kolejne 2 miesiące (okno 60 dni)

  const todayISO = isoInWarsaw(now);
  const weekStarts = [mondayOf(todayISO), addDaysISO(mondayOf(todayISO), 7)];
  const apiState = {}; // wspólny stan pobierania planu z API (diagnostyka i słowniki)

  const [subjects, announcements, calendarThis, calendarNext, inbox, remarksHtml, timetableWeeks, homework, lucky, gradeBoxes, absenceGroups] =
    await Promise.all([
      safe("oceny", client.info.getGrades(), []),
      safe("ogłoszenia", client.inbox.listAnnouncements(), []),
      safe("terminarz", client.calendar.getCalendar(), []),
      Promise.all(
        monthsAhead.map(({ month, year }) =>
          safe(`terminarz ${year}-${pad2(month)}`, client.calendar.getCalendar(month, year), [])
        )
      ),
      safe("wiadomości", client.inbox.listInbox(5), []), // 5 = odebrane (sprawdzone wprost w menu folderów na stronie — nie 6, jak zakładała biblioteka)
      safe(
        "uwagi",
        client.caller.get("https://synergia.librus.pl/uwagi").then((r) => r.data),
        ""
      ),
      Promise.all(
        weekStarts.map((monday) =>
          safe(
            `plan lekcji ${monday}`,
            fetchTimetableApi(client, monday, apiState)
              .then((days) => (days.length ? days : Promise.reject(new Error("API bez lekcji"))))
              .catch((apiErr) => {
                console.warn(`  ! plan lekcji (API) ${monday}: ${apiErr.message} — próbuję starej strony`);
                return client.calendar
                  .getTimetable(monday, addDaysISO(monday, 6))
                  .then((res) => parseTimetable(res, monday));
              }),
            []
          )
        )
      ),
      safe("zadania domowe", fetchHomework(client, todayISO), []),
      safe("szczęśliwy numerek", client.info.getLuckyNumber(), null),
      safe("oceny (wszystkie pola)", fetchAllGradeBoxes(client).then((b) => enrichBoxes(client, b)), []),
      safe("frekwencja", client.absence.getAbsences(), {}),
    ]);

  const calendarAll = [calendarThis, calendarNext]
    .flat(Infinity)
    .filter((e) => e && e.title);

  // Opis sprawdzianu/kartkówki (zakres materiału) jest dostępny TYLKO po wejściu w szczegóły
  // pojedynczego wpisu terminarza (osobne zapytanie na każdy) — lista zbiorcza ma tylko tytuł.
  // Pobieramy to bezpośrednio z Librusa (pole "Opis"), bez udziału AI — więc jest w 100% pewne.
  const examEntries = calendarAll
    .filter((e) => Number.isFinite(e.id) && e.id > 0 && EXAM_RE.test(e.title || ""))
    .filter((e) => { const dd = normalizeDay(e.day); return dd && dd >= today && dd <= until; })
    .slice(0, EXAM_DETAIL_LIMIT);
  // Pełne, gotowe wydarzenia sprawdzianów/kartkówek — zbudowane wprost z tego, co pobraliśmy,
  // nie z zestawienia kalendarza (jego "tytuł" bywa nieczytelnym zlepkiem pól) ani przez próbę
  // dopasowania do tego, co osobno wygeneruje Gemini (tytuły się nie zgadzały — stąd zgubiony opis).
  const examEventsBuilt = [];
  if (examEntries.length) {
    const results = await Promise.allSettled(examEntries.map((e) => fetchEventDescription(client, e.id)));
    examEntries.forEach((e, i) => {
      const r = results[i];
      if (r.status === "rejected") { console.warn(`  ! szczegóły terminarza (id ${e.id}): ${r.reason?.message || r.reason}`); return; }
      const { description, subject, kind } = r.value;
      const title = [subject, kind || "sprawdzian"].filter(Boolean).join(", ") || cleanText(e.title, 90);
      examEventsBuilt.push({ date: normalizeDay(e.day), time: null, title, sourceNote: description, examId: e.id });
    });
    console.log(`  terminarz: sprawdzianów do sprawdzenia ${examEntries.length}, zbudowanych ${examEventsBuilt.length} (z opisem ${examEventsBuilt.filter((x) => x.sourceNote).length})`);
  }

  if (
    asArray(subjects).length === 0 &&
    asArray(announcements).length === 0 &&
    asArray(inbox).length === 0 &&
    calendarAll.length === 0
  ) {
    throw new Error(
      "Librus nie zwrócił żadnych danych — logowanie mogło się nie udać (sprawdź login i hasło albo czy Librus nie blokuje logowania z GitHuba)"
    );
  }

  // Oceny: spłaszczone, tylko od daty "since" (data siedzi w polu opisu oceny)
  const grades = asArray(subjects)
    .filter(Boolean)
    .map((s) => ({
      przedmiot: s.name,
      oceny: asArray(s.semester)
        .flatMap((sem) => asArray(sem?.grades))
        .map((g) => ({ ocena: g.value, opis: g.info }))
        .filter((g) => {
          const d = normalizeDay(g.opis);
          return !d || d >= since;
        }),
    }))
    .filter((s) => s.oceny.length > 0);

  // Terminarz: tylko od dziś do +EVENTS_AHEAD_DAYS
  const terminarz = calendarAll
    .map((e) => ({ data: normalizeDay(e.day), tytul: e.title }))
    .filter((e) => e.data && e.data >= today && e.data <= until)
    .sort((a, b) => a.data.localeCompare(b.data))
    .slice(0, 120);

  // Wcześniej appka pomijała wiadomości, które były JEDNOCZEŚNIE przeczytane i starsze niż tydzień —
  // to wykluczało m.in. wiadomości przeczytane wprost na Librusie (nie przez appkę). Skoro appka ma
  // już trwałą pamięć wiadomości (patrz syncChild), bierzemy teraz po prostu najnowsze ze skrzynki,
  // niezależnie od tego, czy ktoś je już przeczytał na Librusie.
  const wiadomosciZrodlo = asArray(inbox).slice(0, 30);
  const wiadomosci = wiadomosciZrodlo.map((m) => ({ od: m.user, temat: m.title, data: m.date, nieprzeczytana: !m.read }));

  const ogloszenia = asArray(announcements)
    .filter((a) => (normalizeDay(a.date) ?? "9999") >= since)
    .slice(0, 10)
    .map((a) => ({
      tytul: a.title,
      od: a.user,
      data: a.date,
      tresc: String(a.content ?? "").slice(0, 400),
    }));

  const uwagiTekst = htmlToText(remarksHtml).slice(0, 12000);

  const messageBodies = await fetchMessageBodies(client, wiadomosciZrodlo, attachmentCache);

  const extra = {
    timetable: asArray(timetableWeeks)
      .flat()
      .filter((d) => d.date >= today && d.date <= addDaysISO(today, 8)),
    homework: asArray(homework),
    luckyNumber: Number.isFinite(lucky) ? lucky : null,
    gradeList: buildGradeList(subjects, gradeBoxes),
    messages: messageBodies,
    absence: buildAbsenceSummary(absenceGroups),
  };
  console.log(`  wiadomości: w skrzynce ${wiadomosciZrodlo.length}, pobrano pełną treść: ${messageBodies.length}`);
  // Diagnostyka bez nazw i treści: ile ocen znalazła biblioteka, ile wszystkie pola i jakie wartości nie są cyframi.
  const letters = {};
  for (const g of extra.gradeList) if (g.base == null) letters[g.value] = (letters[g.value] || 0) + 1;
  console.log(`  oceny: biblioteka ${asArray(subjects).reduce((n, s) => n + asArray(s?.semester).reduce((m, x) => m + asArray(x?.grades).length, 0), 0)}, wszystkie pola ${asArray(gradeBoxes).length}, razem ${extra.gradeList.length}; bez cyfry: ${Object.entries(letters).map(([k, v]) => `${k}×${v}`).join(" ") || "brak"}`);

  return { grades, terminarz, wiadomosci, ogloszenia, uwagiTekst, extra, examEventsBuilt };
}

// ---------- Synchronizacja ----------
// Pobiera i streszcza dane jednego dziecka.
async function syncChild(child, attachmentCache, previousRemarks = [], previousStudyMaterial = [], previousMessages = [], previousMessageTodos = []) {
  const loginEnv = `LIBRUS_LOGIN_${child.secretSuffix}`;
  const passEnv = `LIBRUS_PASSWORD_${child.secretSuffix}`;
  const login = process.env[loginEnv];
  const password = process.env[passEnv];

  if (!login || !password) {
    throw new Error(`Brak sekretów ${loginEnv} / ${passEnv} w GitHub Actions`);
  }

  const nowDate = new Date();
  const today = isoInWarsaw(nowDate);
  const since = isoInWarsaw(shiftDays(nowDate, -NEW_DAYS));
  const until = isoInWarsaw(shiftDays(nowDate, EVENTS_AHEAD_DAYS));

  console.log(`[${child.name}] Logowanie do Librusa i pobieranie danych...`);
  const raw = await fetchLibrusData(login, password, today, since, until, attachmentCache);

  // Wiadomości: dokładamy świeżo pobrane do tych z poprzednich synchronizacji (po id), żeby
  // wiadomość raz pokazana w appce nie zniknęła, gdy stanie się jednocześnie "przeczytana i stara"
  // i przestanie się mieścić w oknie, jakie appka pobiera na bieżąco. Limit 60, żeby nie rosło
  // bez końca przez cały rok szkolny.
  const freshMsgIds = new Set(raw.extra.messages.map((m) => m.id));
  const keptOldMsgs = previousMessages.filter((m) => m?.id != null && !freshMsgIds.has(m.id));
  raw.extra.messages = [...raw.extra.messages, ...keptOldMsgs].slice(0, 60);
  console.log(`[${child.name}] wiadomości: świeżych ${freshMsgIds.size}, zachowanych ze starszych synchronizacji ${keptOldMsgs.length}, łącznie ${raw.extra.messages.length}`);

  console.log(
    `[${child.name}] oceny: ${raw.extra.gradeList.length}, plan: ${raw.extra.timetable.length} dni, zadania: ${raw.extra.homework.length}, numerek: ${raw.extra.luckyNumber ?? "-"}, frekwencja: ${raw.extra.absence.total} (${Object.entries(raw.extra.absence.byType).map(([k, v]) => `${k}×${v}`).join(" ") || "brak"})`
  );
  const gradeTrends = computeGradeTrends(raw.extra.gradeList, today);
  // Pełna treść wiadomości (nie tylko temat!) do podsumowania ORAZ wychwycenia próśb typu "proszę
  // o przygotowanie na poniedziałek...". Do podsumowania bierzemy świeże (ostatnie NEW_DAYS dni) —
  // stare i tak już są "stare". Ale do wychwytywania próśb bierzemy KAŻDĄ wiadomość, która jeszcze
  // nigdy nie trafiła do Gemini (oznaczana na stałe "scannedByAi"), niezależnie od wieku — inaczej
  // wiadomość, która z jakiegokolwiek powodu (np. dawny błąd z folderem) stała się appce widoczna
  // później niż tydzień od wysłania, nigdy nie zostałaby przez Gemini w ogóle przeczytana.
  const allMsgs = asArray(raw.extra.messages);
  // Dwa NIEZALEŻNE zestawy — wcześniej dzieliły ten sam warunek, co było błędem: wiadomość
  // "świeża" (ostatnie NEW_DAYS dni) wracała do wyłapywania próśb przy KAŻDEJ synchronizacji
  // przez cały tydzień, a Gemini za każdym razem formułowało tę samą prośbę odrobinę inaczej —
  // stąd kilka niemal identycznych zadań zamiast jednego.
  const msgsForSummary = allMsgs.filter((m) => (m.data || "9999") >= since);
  const msgsForTodoScan = allMsgs.filter((m) => m.scannedByAi !== TODO_SCAN_VERSION);
  const wiadomosciZTrescia = msgsForSummary
    .map((m) => ({ od: m.od, temat: m.temat, data: m.data, nieprzeczytana: m.nieprzeczytana, tresc: cleanText(m.tresc, 1200) }));
  console.log(`[${child.name}] Generowanie podsumowania (Gemini)...`);
  const ai = await summarizeWithGemini(
    {
      oceny: raw.grades,
      terminarz: raw.terminarz,
      wiadomosci: wiadomosciZTrescia,
      ogloszenia: raw.ogloszenia,
      uwagi_tekst: raw.uwagiTekst,
    },
    child.name,
    today,
    since,
    gradeTrends
  );

  // Pełna historia uwag: Gemini zgłasza WSZYSTKIE znalezione na stronie "uwagi_tekst" (punkt 3b
  // w promptcie, bez ograniczenia do "since"). Brak naturalnego id (to nie wiadomość z własnym
  // numerem), więc budujemy stabilny klucz z treści — ta sama uwaga da ten sam klucz przy
  // każdej synchronizacji, więc scalanie z poprzednim stanem nie zduplikuje wpisów.
  const remarkKey = (r) => createHash("md5").update(`${r.date || ""}|${r.teacher || ""}|${r.text || ""}`).digest("hex").slice(0, 16);
  const mergedRemarks = new Map();
  for (const r of previousRemarks) if (r?.id != null) mergedRemarks.set(r.id, r);
  for (const r of ai.sections.remarksAll) {
    const id = remarkKey(r);
    mergedRemarks.set(id, { id, date: r.date, teacher: r.teacher, text: r.text, type: r.type });
  }
  raw.extra.remarkList = [...mergedRemarks.values()].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  console.log(`[${child.name}] uwagi: nowo zgłoszone przez Gemini ${ai.sections.remarksAll.length}, łącznie po scaleniu ${raw.extra.remarkList.length}`);
  delete ai.sections.remarksAll; // już przeniesione do extra.remarkList — nie dublujemy w bazie

  // Rzeczy do zrobienia z treści wiadomości: osobne, dzielone na małe partie zapytanie (patrz
  // extractTodosFromMessages) — jeden duży prompt ze wszystkimi wiadomościami naraz zawodził,
  // Gemini gubił część próśb mimo wyraźnej instrukcji "sprawdź każdą". Scalamy z poprzednio
  // znalezionymi (po stabilnym kluczu z treści — nie mamy id wiadomości źródłowej, więc
  // dedupujemy po tekście), żeby ta sama prośba nie pojawiła się dwa razy i żeby nie zniknęła,
  // gdy źródłowa wiadomość z czasem wypadnie poza okno, jakie dostaje Gemini.
  const foundTodos = msgsForTodoScan.length ? await extractTodosFromMessages(child.name, msgsForTodoScan, today) : [];
  for (const m of msgsForTodoScan) m.scannedByAi = TODO_SCAN_VERSION; // każda wiadomość skanowana DOKŁADNIE raz na tę wersję instrukcji
  const todoKey = (t) => createHash("md5").update(`${t.text || ""}|${t.due || ""}`).digest("hex").slice(0, 16);
  const mergedMsgTodos = new Map();
  for (const t of previousMessageTodos) if (t?.id != null) mergedMsgTodos.set(t.id, t);
  for (const t of foundTodos) {
    const id = todoKey(t);
    mergedMsgTodos.set(id, { id, text: t.text, due: t.due });
  }
  raw.extra.messageTodos = [...mergedMsgTodos.values()];
  if (foundTodos.length) console.log(`[${child.name}] z wiadomości do zrobienia: nowo zgłoszone ${foundTodos.length}, łącznie ${raw.extra.messageTodos.length}`);

  // Sprawdziany/kartkówki: zastępujemy to, co na ten dzień ewentualnie zgadło Gemini (z tytułem
  // bywającym bałaganem i bez pewnego zakresu materiału) naszą wersją zbudowaną wprost z Librusa —
  // dopasowanie po tytule zawodziło (Gemini formułuje tytuł inaczej niż zbiorcza lista kalendarza),
  // więc zamiast dopasowywać, po prostu podmieniamy po dacie.
  if (raw.examEventsBuilt?.length) {
    const examDates = new Set(raw.examEventsBuilt.map((e) => e.date));
    ai.sections.events = ai.sections.events.filter((ev) => !(examDates.has(ev.date) && EXAM_RE.test(ev.title || "")));
    ai.sections.events.push(...raw.examEventsBuilt);
  }

  // Materiał do nauki: raz wygenerowany dla danego sprawdzianu (po jego stałym id) zostaje
  // zapamiętany na stałe i tylko dokładany ponownie — generujemy NOWY tylko dla sprawdzianów,
  // których jeszcze nie było, i tylko do limitu na tę jedną synchronizację.
  const prevStudyById = new Map(previousStudyMaterial.filter((m) => m?.id != null).map((m) => [m.id, m]));
  const studyMaterialOut = [];
  let newStudyCount = 0;
  for (const ev of raw.examEventsBuilt || []) {
    if (ev.examId == null) continue;
    const cached = prevStudyById.get(ev.examId);
    if (cached) {
      ev.studyMaterial = { keyPoints: cached.keyPoints, questions: cached.questions };
      studyMaterialOut.push(cached);
    } else if (ev.sourceNote && newStudyCount < STUDY_MATERIAL_NEW_LIMIT) {
      try {
        const [subject, kind] = ev.title.split(", ");
        const material = await generateStudyMaterial(child.name, subject, kind, ev.sourceNote);
        if (material.keyPoints.length || material.questions.length) {
          ev.studyMaterial = material;
          studyMaterialOut.push({ id: ev.examId, date: ev.date, ...material });
          newStudyCount++;
        }
      } catch (err) {
        console.warn(`  ! materiał do nauki (${ev.title}): ${err.message}`);
      }
    }
    delete ev.examId; // pomocnicze tylko tutaj — nie trzeba tego zapisywać do appki
  }
  if (studyMaterialOut.length) {
    raw.extra.studyMaterial = studyMaterialOut;
    console.log(`[${child.name}] materiał do nauki: nowo wygenerowany ${newStudyCount}, łącznie ${studyMaterialOut.length}`);
  }

  return { ...ai, extra: raw.extra };
}

// ---------- Przegląd tygodnia (1 zapytanie do Gemini, tylko w niedzielę wieczorem) ----------
const EXAM_RE = /kartk|sprawdzian|klas[oó]wk|\btest\b|egzamin|dyktand/i;

// Zbiera zwięzłe liczby z już policzonych danych dzieci — bez wysyłania pełnej treści do Gemini.
function buildWeeklyStats(results, today) {
  const since7 = addDaysISO(today, -7);
  const until7 = addDaysISO(today, 7);
  return results
    .filter((r) => r.ok)
    .map((r) => {
      const grades7 = (r.extra.gradeList || []).filter((g) => g.date && g.date >= since7 && !g.final);
      const remarks7 = (r.sections.remarks || []).filter((x) => x.date && x.date >= since7);
      const absence7 = (r.extra.absence?.days || []).filter((d) => d.date >= since7);
      const upcoming = (r.sections.events || []).filter((e) => e.date && e.date > today && e.date <= until7);
      const exams = upcoming.filter((e) => EXAM_RE.test(e.title || ""));
      return {
        dziecko: r.child.name,
        noweOcenyTydzien: grades7.map((g) => ({ przedmiot: g.subject, ocena: g.value })),
        uwagiTydzien: remarks7.length,
        nieobecnosciTydzien: absence7.reduce((n, d) => n + Object.values(d.counts).reduce((a, b) => a + b, 0), 0),
        sprawdzianyPrzedNami: exams.map((e) => ({ tytul: e.title, data: e.date })),
        innychTerminowPrzedNami: upcoming.length - exams.length,
      };
    });
}

// Ile wiadomości naraz prosimy Gemini o przejrzenie pod kątem próśb nauczyciela. Mniejsza partia
// niż "wszystkie naraz" (bywało 17-20) — model przy krótszej liście rzetelniej sprawdza KAŻDĄ
// pozycję, zamiast gubić część z nich przy długiej liście mimo wyraźnej instrukcji.
const TODO_BATCH_SIZE = 5;

// Wyłapuje prośby typu "proszę przynieść/wpłacić/przygotować..." z treści wiadomości — jedno
// zapytanie do Gemini na małą partię wiadomości (patrz TODO_BATCH_SIZE), żeby model rzetelnie
// sprawdził każdą z osobna, zamiast gubić część przy długiej liście naraz.
async function extractTodosFromBatch(childName, batch, today) {
  const prompt = `
Jesteś asystentem rodzica ucznia (imię: ${childName}). Poniżej masz ${batch.length} wiadomości
z dziennika elektronicznego (pole "tresc" to pełna treść, nie tylko temat).

Przejrzyj KAŻDĄ wiadomość z osobna i wypisz rzeczy, które rodzic/uczeń ma ZROBIĆ, PRZYNIEŚĆ,
WPŁACIĆ lub POTWIERDZIĆ. Jedna wiadomość może dać zero, jeden albo więcej wpisów. Jeśli żadna
wiadomość niczego takiego nie zawiera, zwróć pustą listę.

Np. "proszę o przygotowanie na poniedziałek: słoik, balon..." to jeden wpis z
text="Przygotować: słoik, balon, mąka ziemniaczana" i due=najbliższy poniedziałek licząc od
dzisiejszej daty (dziś: ${today}). Jeśli wiadomość nie podaje konkretnego dnia, ustaw due na null.

Odpowiedz WYŁĄCZNIE poprawnym JSON-em: [{"text": string, "due": "YYYY-MM-DD" albo null}]

Wiadomości:
${JSON.stringify(batch)}
`.trim();

  let data;
  try {
    data = await callGemini(GEMINI_MODEL, prompt);
  } catch (err) {
    const canFallback = GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL && RETRY_STATUS.has(err.status);
    if (!canFallback) throw err;
    data = await callGemini(GEMINI_FALLBACK_MODEL, prompt);
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Pusta odpowiedź z Gemini (zadania z wiadomości)");
  const cleaned = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const parsed = JSON.parse(cleaned);
  return asArray(parsed).map((t) => ({ text: str(t.text), due: nul(t.due) })).filter((t) => t.text);
}

async function extractTodosFromMessages(childName, messages, today) {
  const out = [];
  for (let i = 0; i < messages.length; i += TODO_BATCH_SIZE) {
    const batch = messages.slice(i, i + TODO_BATCH_SIZE);
    try {
      out.push(...(await extractTodosFromBatch(childName, batch, today)));
    } catch (err) {
      console.warn(`  ! zadania z wiadomości (partia ${i / TODO_BATCH_SIZE + 1}): ${err.message}`);
    }
  }
  return out;
}

// Materiał do nauki (kluczowe punkty + pytania kontrolne) do konkretnego sprawdzianu/kartkówki.
// UWAGA: appka nie ma dostępu do treści podręcznika — Gemini opiera to na swojej ogólnej wiedzy
// o temacie, nie na dokładnej stronie/rozdziale. To pomoc poglądowa, nie zamiennik podręcznika —
// appka pokazuje to z wyraźnym zastrzeżeniem (patrz index.html).
async function generateStudyMaterial(childName, subject, kind, description) {
  const prompt = `
Jesteś pomocnym korepetytorem przygotowującym ucznia (imię: ${childName}) do ${kind || "sprawdzianu"}
z przedmiotu: ${subject || "nieznany"}.
Zakres, jaki podał nauczyciel: "${description}".

Nie masz dostępu do podręcznika ucznia — oprzyj się na swojej ogólnej wiedzy o tym temacie,
dopasowanej do wieku szkolnego sugerowanego przez nazwę przedmiotu i zakres. Jeśli zakres jest
zbyt ogólny, żeby cokolwiek z niego wywnioskować (np. tylko numer strony bez tematu), zwróć
puste listy.

Odpowiedz WYŁĄCZNIE poprawnym JSON-em PO POLSKU:
{"keyPoints": string[], "questions": string[]}
- "keyPoints": 4-7 krótkich, konkretnych punktów do zapamiętania (nie całe akapity)
- "questions": 3-5 pytań kontrolnych, na które uczeń powinien umieć odpowiedzieć
`.trim();

  let data;
  try {
    data = await callGemini(GEMINI_MODEL, prompt);
  } catch (err) {
    const canFallback = GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL && RETRY_STATUS.has(err.status);
    if (!canFallback) throw err;
    data = await callGemini(GEMINI_FALLBACK_MODEL, prompt);
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Pusta odpowiedź z Gemini (materiał do nauki)");
  const cleaned = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const parsed = JSON.parse(cleaned);
  return {
    keyPoints: asArray(parsed?.keyPoints).map((x) => cleanText(x, 200)).filter(Boolean).slice(0, 7),
    questions: asArray(parsed?.questions).map((x) => cleanText(x, 200)).filter(Boolean).slice(0, 5),
  };
}

async function generateWeeklyReview(userDocRef, results, today) {
  const stats = buildWeeklyStats(results, today);
  if (!stats.length) return;

  const prompt = `
Jesteś ciepłym, rzeczowym asystentem rodzica. Poniżej masz policzone dane o dzieciach
z ostatniego tygodnia (od ${addDaysISO(today, -7)}) i na kolejny (do ${addDaysISO(today, 7)}).
Napisz PO POLSKU krótki, przyjazny przegląd tygodnia dla rodzica, 2-4 zdania łącznie
(nie per dziecko — jeden spójny akapit o obojgu/wszystkich dzieciach). Wspomnij, co
się wydarzyło i na co warto zwrócić uwagę w nadchodzącym tygodniu. Nie wymyślaj
faktów spoza danych. Jeśli dane są bardzo skromne, napisz to krótko i spokojnie.

Odpowiedz WYŁĄCZNIE poprawnym JSON-em: {"text": string}.

Dane:
${JSON.stringify(stats)}
`.trim();

  let data;
  try {
    data = await callGemini(GEMINI_MODEL, prompt);
  } catch (err) {
    const canFallback = GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL && RETRY_STATUS.has(err.status);
    if (!canFallback) throw err;
    data = await callGemini(GEMINI_FALLBACK_MODEL, prompt);
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Pusta odpowiedź z Gemini (przegląd tygodnia)");
  const cleaned = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const parsed = JSON.parse(cleaned);
  const reviewText = toText(parsed?.text).trim();
  if (!reviewText) return;

  await userDocRef.set(
    { weeklyReview: { text: reviewText, dateISO: today, atMs: Date.now() } },
    { merge: true }
  );
  console.log(`[${userDocRef.id}] Przegląd tygodnia zapisany.`);
}

// Łączy wyniki dzieci w jedno podsumowanie i jedną listę terminów
// (zgodność ze starszą wersją appki).
function buildCombined(results) {
  const summary = results
    .map((r) => {
      const body = r.ok
        ? r.summary || "Brak istotnych nowości."
        : `⚠ Nie udało się pobrać danych: ${r.error}`;
      return `── ${r.child.name} ──\n${body}`;
    })
    .join("\n\n");

  const detectedEvents = results
    .filter((r) => r.ok)
    .flatMap((r) =>
      r.sections.events.map((ev) => ({
        ...ev,
        title: `[${r.child.name}] ${ev.title}`,
        child: r.child.name,
      }))
    )
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  return { summary, detectedEvents };
}

// Synchronizuje wszystkie dzieci jednego użytkownika (rodzica).
// Zwraca "ok" albo "error" (gdy któreś dziecko się nie udało, ale inne tak).
// Rzuca błąd tylko wtedy, gdy nie udało się żadne dziecko.
async function syncUser(user) {
  const children = user.children ?? [];
  if (children.length === 0) {
    throw new Error(`Brak listy "children" dla użytkownika ${user.displayName}`);
  }

  const userDocRef = db.collection("users").doc(user.firestoreUid);
  const startedAt = admin.firestore.Timestamp.now();

  // Pamięć wcześniej przeanalizowanych załączników PDF (per dziecko) — żeby nie płacić
  // za tę samą analizę przy każdej synchronizacji. Brak poprzednich danych = pusta pamięć,
  // to normalne przy pierwszym uruchomieniu.
  let previousChildren = {};
  try {
    previousChildren = (await userDocRef.get()).data()?.librus?.children ?? {};
  } catch (err) {
    console.warn(`  ! nie udało się odczytać poprzednich danych (pamięć załączników będzie pusta): ${err.message}`);
  }
  const buildAttachmentCache = (secretSuffix) => {
    const cache = new Map();
    for (const msg of asArray(previousChildren[secretSuffix]?.extra?.messages)) {
      for (const att of asArray(msg?.zalaczniki)) {
        if (att?.name && att?.analysis) cache.set(`${msg.id}:${att.name}`, att.analysis);
      }
    }
    return cache;
  };
  // Uwagi znalezione w poprzednich synchronizacjach — dokładane do nowo znalezionych (nie
  // nadpisywane), żeby raz zauważona uwaga nigdy nie zniknęła, nawet jeśli z czasem wypadnie
  // poza to, co Librus obecnie pokazuje w skrzynce.
  const getPreviousRemarks = (secretSuffix) => asArray(previousChildren[secretSuffix]?.extra?.remarkList);
  // Materiał do nauki wygenerowany wcześniej dla danego sprawdzianu (po jego stałym id z Librusa) —
  // nie generujemy go drugi raz, tylko dokładamy do każdego dnia, aż wydarzenie zniknie z terminarza.
  const getPreviousStudyMaterial = (secretSuffix) => asArray(previousChildren[secretSuffix]?.extra?.studyMaterial);
  // Wiadomości: appka sama oznacza wiadomość jako przeczytaną, gdy pobiera jej treść — a pobiera
  // tylko nieprzeczytane LUB nowsze niż tydzień. Bez pamięci wiadomość, którą appka właśnie
  // pokazała, za tydzień wypadnie z tego okna i zniknie, mimo że wciąż jest na Librusie.
  const getPreviousMessages = (secretSuffix) => asArray(previousChildren[secretSuffix]?.extra?.messages);
  // Rzeczy do zrobienia wyłowione wcześniej z treści wiadomości (np. "przynieś słoik na
  // poniedziałek") — pamiętamy je, żeby nie zniknęły, gdy źródłowa wiadomość wypadnie
  // z okna, jakie appka pokazuje Gemini przy kolejnej synchronizacji.
  const getPreviousMessageTodos = (secretSuffix) => asArray(previousChildren[secretSuffix]?.extra?.messageTodos);

  const results = [];
  for (const child of children) {
    try {
      results.push({ child, ok: true, ...(await syncChild(child, buildAttachmentCache(child.secretSuffix), getPreviousRemarks(child.secretSuffix), getPreviousStudyMaterial(child.secretSuffix), getPreviousMessages(child.secretSuffix), getPreviousMessageTodos(child.secretSuffix))) });
    } catch (err) {
      console.error(`[${child.name}] BŁĄD:`, err.message);
      results.push({ child, ok: false, error: err.message });
    }
  }

  const okResults = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const errorText = failed.map((f) => `${f.child.name}: ${f.error}`).join(" | ");

  if (okResults.length === 0) throw new Error(errorText);

  const { summary, detectedEvents } = buildCombined(results);
  const now = admin.firestore.Timestamp.now();

  const childrenData = {};
  for (const r of results) {
    childrenData[r.child.secretSuffix] = r.ok
      ? {
          name: r.child.name,
          summary: r.summary,
          insights: clean(r.insights),
          sections: r.sections,
          extra: clean(r.extra),
          updatedAt: now,
          lastError: admin.firestore.FieldValue.delete(),
        }
      : {
          // poprzednie dane dziecka zostają, dodajemy tylko informację o błędzie
          name: r.child.name,
          lastError: r.error,
          lastErrorAt: now,
        };
  }

  const status = failed.length === 0 ? "ok" : "error";

  console.log(`[${user.displayName}] Zapis do Firestore...`);
  await userDocRef.set(
    {
      displayName: user.displayName,
      librus: {
        summary,
        detectedEvents,
        childOrder: children.map((c) => c.secretSuffix),
        children: childrenData,
        updatedAt: now,
      },
      lastSync:
        status === "ok"
          ? { status, timestamp: now, error: admin.firestore.FieldValue.delete() }
          : { status, error: errorText, timestamp: now },
    },
    { merge: true }
  );

  await userDocRef.collection("syncHistory").add({
    startedAt,
    finishedAt: admin.firestore.Timestamp.now(),
    status,
    module: "librus",
    children: results.map((r) => ({
      name: r.child.name,
      status: r.ok ? "ok" : "error",
      ...(r.ok ? {} : { error: r.error }),
    })),
  });

  // Przegląd tygodnia: tylko w niedzielę wieczorem (jedno z trzech dziennych uruchomień),
  // i tylko raz danego dnia. Osobne, oszczędne zapytanie do Gemini — błąd nie psuje
  // reszty synchronizacji, która już się zapisała powyżej.
  const { hour, weekday } = warsawNowParts();
  const todayIso = isoInWarsaw(new Date());
  if (weekday === 0 && hour >= 18) {
    try {
      const existing = (await userDocRef.get()).data() || {};
      if (existing.weeklyReview?.dateISO !== todayIso) {
        await generateWeeklyReview(userDocRef, results, todayIso);
      }
    } catch (err) {
      console.warn(`  ! Przegląd tygodnia się nie udał: ${err.message}`);
    }
  }

  return status;
}

// ---------- Zdrowie synchronizacji (do licznika w appce: "ile zaplanowanych uruchomień GitHuba
// faktycznie się odpaliło w ostatnich dniach") ----------
// Zapisujemy wpis dla KAŻDEGO uruchomienia (udanego i nieudanego), ale tylko te ze zdarzenia
// "schedule" liczą się do statystyki — ręczne uruchomienia (Run workflow) by ją zafałszowały.
async function logSyncHealth(userDocRef, status) {
  try {
    const now = Date.now();
    const isScheduled = process.env.GH_EVENT_NAME === "schedule";
    const entry = { atMs: now, dateISO: isoInWarsaw(new Date(now)), isScheduled, status };
    const snap = await userDocRef.get();
    const prev = Array.isArray(snap.data()?.syncHealth) ? snap.data().syncHealth : [];
    const trimmed = [...prev, entry].filter((e) => now - (e.atMs || 0) < 10 * 24 * 3600 * 1000).slice(-60);
    await userDocRef.set({ syncHealth: trimmed }, { merge: true });
  } catch (err) {
    console.warn(`  ! nie udało się zapisać zdrowia synchronizacji: ${err.message}`);
  }
}

async function main() {
  const results = [];

  for (const user of users) {
    if (user.firestoreUid?.startsWith("WKLEJ_TU_")) {
      console.warn(
        `Pomijam ${user.displayName} — nie uzupełniono firestoreUid w users.config.json`
      );
      continue;
    }

    const userDocRef = db.collection("users").doc(user.firestoreUid);
    let runStatus = "error";
    try {
      const status = await syncUser(user);
      runStatus = status;
      results.push({ user: user.displayName, status });
    } catch (err) {
      console.error(`[${user.displayName}] BŁĄD:`, err.message);
      results.push({ user: user.displayName, status: "error", error: err.message });

      // Zapisujemy błąd do Firestore, żeby appka mogła pokazać status synchronizacji
      try {
        await userDocRef.set(
          {
            lastSync: {
              status: "error",
              error: err.message,
              timestamp: admin.firestore.Timestamp.now(),
            },
          },
          { merge: true }
        );
        await userDocRef.collection("syncHistory").add({
          startedAt: admin.firestore.Timestamp.now(),
          finishedAt: admin.firestore.Timestamp.now(),
          status: "error",
          error: err.message,
          module: "librus",
        });
      } catch (writeErr) {
        console.error("Nie udało się zapisać błędu do Firestore:", writeErr.message);
      }
    }
    await logSyncHealth(userDocRef, runStatus);
  }

  console.log("Podsumowanie synchronizacji:", results);

  // Jeśli cokolwiek się nie udało (nawet jedno dziecko), workflow kończy się błędem,
  // żeby GitHub Actions wysłał Ci powiadomienie mailem o nieudanym uruchomieniu.
  if (results.some((r) => r.status === "error")) {
    process.exit(1);
  }
}

main();
