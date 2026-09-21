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
import Librus from "librus-api";
import admin from "firebase-admin";
import fetch from "node-fetch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Ustawienia ----------
const NEW_DAYS = 7; // co uznajemy za "nowe" (oceny, uwagi, wiadomości)
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
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash";
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [5000, 15000, 30000]; // 4 próby: od razu, po 5 s, 15 s, 30 s
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wywołuje Gemini; przy chwilowych błędach (np. 503 "high demand") ponawia z przerwami.
async function callGemini(model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
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

async function summarizeWithGemini(rawData, childName, today, since) {
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

4. "events" — nadchodzące wydarzenia od dziś do ${EVENTS_AHEAD_DAYS} dni w przód
   z terminarza i ogłoszeń (sprawdziany, wycieczki, wywiadówki, terminy oddania):
   [{"title": string, "date": "YYYY-MM-DD", "time": "HH:MM" albo null,
   "sourceNote": string}]. Bez duplikatów. Nie zgaduj dat — pomiń wydarzenie bez daty.

5. "messages" — wiadomości nieprzeczytane lub z ostatnich ${NEW_DAYS} dni oraz ogłoszenia:
   [{"from": string, "subject": string, "date": string albo null,
   "unread": true/false, "kind": "wiadomość" | "ogłoszenie"}].

Puste sekcje zwracaj jako []. Odpowiedz WYŁĄCZNIE poprawnym JSON-em.

Dane wejściowe:
${JSON.stringify(rawData)}
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

async function fetchLibrusData(login, password, today, since, until) {
  const client = new Librus();
  // UWAGA: biblioteka połyka błędy logowania, dlatego niżej sprawdzamy, czy
  // Librus w ogóle zwrócił jakiekolwiek dane.
  await client.authorize(login, password);

  const failures = [];
  const safe = (label, promise, fallback) =>
    promise.catch((err) => {
      failures.push(label);
      console.warn(`  ! ${label}: ${err.message}`);
      return fallback;
    });

  const now = new Date();
  const monthsAhead = safeMonthsAhead(now, 2); // kolejne 2 miesiące (okno 60 dni)

  const [subjects, announcements, calendarThis, calendarNext, inbox, remarksHtml] =
    await Promise.all([
      safe("oceny", client.info.getGrades(), []),
      safe("ogłoszenia", client.inbox.listAnnouncements(), []),
      safe("terminarz", client.calendar.getCalendar(), []),
      Promise.all(
        monthsAhead.map(({ month, year }) =>
          safe(`terminarz ${year}-${pad2(month)}`, client.calendar.getCalendar(month, year), [])
        )
      ),
      safe("wiadomości", client.inbox.listInbox(6), []), // 6 = odebrane
      safe(
        "uwagi",
        client.caller.get("https://synergia.librus.pl/uwagi").then((r) => r.data),
        ""
      ),
    ]);

  const calendarAll = [calendarThis, calendarNext]
    .flat(Infinity)
    .filter((e) => e && e.title);

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

  const wiadomosci = asArray(inbox)
    .filter((m) => !m.read || (normalizeDay(m.date) ?? "9999") >= since)
    .slice(0, 30)
    .map((m) => ({ od: m.user, temat: m.title, data: m.date, nieprzeczytana: !m.read }));

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

  return { grades, terminarz, wiadomosci, ogloszenia, uwagiTekst };
}

// ---------- Synchronizacja ----------
// Pobiera i streszcza dane jednego dziecka.
async function syncChild(child) {
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
  const raw = await fetchLibrusData(login, password, today, since, until);

  console.log(`[${child.name}] Generowanie podsumowania (Gemini)...`);
  return summarizeWithGemini(
    {
      oceny: raw.grades,
      terminarz: raw.terminarz,
      wiadomosci: raw.wiadomosci,
      ogloszenia: raw.ogloszenia,
      uwagi_tekst: raw.uwagiTekst,
    },
    child.name,
    today,
    since
  );
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

  const results = [];
  for (const child of children) {
    try {
      results.push({ child, ok: true, ...(await syncChild(child)) });
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
          sections: r.sections,
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

  return status;
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

    try {
      const status = await syncUser(user);
      results.push({ user: user.displayName, status });
    } catch (err) {
      console.error(`[${user.displayName}] BŁĄD:`, err.message);
      results.push({ user: user.displayName, status: "error", error: err.message });

      // Zapisujemy błąd do Firestore, żeby appka mogła pokazać status synchronizacji
      try {
        const userDocRef = db.collection("users").doc(user.firestoreUid);
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
  }

  console.log("Podsumowanie synchronizacji:", results);

  // Jeśli cokolwiek się nie udało (nawet jedno dziecko), workflow kończy się błędem,
  // żeby GitHub Actions wysłał Ci powiadomienie mailem o nieudanym uruchomieniu.
  if (results.some((r) => r.status === "error")) {
    process.exit(1);
  }
}

main();
