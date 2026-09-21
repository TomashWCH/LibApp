// scripts/sync-librus.js
//
// Uruchamiane cyklicznie przez GitHub Actions (.github/workflows/sync.yml).
// Dla każdego użytkownika (rodzica) z users.config.json i każdego jego dziecka:
//   1. loguje się do Librusa (login/hasło dziecka z sekretów GitHub Actions)
//   2. pobiera: nieprzeczytane wiadomości/ogłoszenia, oceny, terminarz
//   3. wysyła zebrane dane do Gemini z prośbą o zwięzłe podsumowanie PL
//      + wykrycie terminów, które mogłyby trafić do kalendarza
//   4. zapisuje wynik do Firestore (users/{uid}) + historię synchronizacji
//
// Podsumowania wszystkich dzieci są łączone w jedno (librus.summary), z nagłówkiem
// przy każdym dziecku, oraz zapisywane osobno w librus.children.<SUFFIX>.
// Błąd dla jednego dziecka NIE przerywa synchronizacji pozostałych.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Librus from "librus-api";
import admin from "firebase-admin";
import fetch from "node-fetch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Firebase Admin ----------
// Sekret GitHub Actions FIREBASE_SERVICE_ACCOUNT musi zawierać CAŁĄ zawartość
// pliku JSON klucza konta serwisowego (Firebase Console -> Ustawienia projektu
// -> Konta usługi -> Generuj nowy klucz prywatny).
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// ---------- Konfiguracja użytkowników ----------
const usersConfigPath = path.join(__dirname, "users.config.json");
const { users } = JSON.parse(readFileSync(usersConfigPath, "utf-8"));

// ---------- Gemini ----------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite"; // szybki, tani; nazwę można zmienić tu lub sekretem/zmienną GEMINI_MODEL
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

async function summarizeWithGemini(rawData, childName) {
  const prompt = `
Jesteś asystentem podsumowującym dziennik elektroniczny Librus dla rodzica.
Dane dotyczą dziecka: ${childName}.
Na podstawie poniższych surowych danych JSON przygotuj:

1. "summary" — zwięzłe podsumowanie po polsku (kilka punktów), TYLKO to co istotne:
   nowe oceny (z przedmiotem), ważne wiadomości/ogłoszenia (o czym, od kogo),
   nadchodzące wydarzenia z terminarza. Pomiń rzeczy nieistotne/rutynowe.
   Jeśli czegoś nie ma (np. brak nowych ocen), pomiń tę sekcję, nie pisz "brak danych".

2. "detectedEvents" — tablica obiektów { "title": string, "date": "YYYY-MM-DD",
   "time": "HH:MM" albo null, "sourceNote": string } dla wszystkich konkretnych
   dat/terminów, które warto by dodać do kalendarza (sprawdziany, wywiadówki,
   wycieczki, terminy oddania czegoś itp.). Jeśli nic nie znaleziono, pusta tablica.

Odpowiedz WYŁĄCZNIE poprawnym JSON-em w formacie:
{"summary": "...", "detectedEvents": [...]}

Dane wejściowe:
${JSON.stringify(rawData).slice(0, 30000)}
`.trim();

  const response = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Pusta odpowiedź z Gemini");

  return JSON.parse(text);
}

// ---------- Librus ----------
async function fetchLibrusData(login, password) {
  const client = new Librus();
  await client.authorize(login, password);

  const [announcements, grades, calendar] = await Promise.all([
    client.inbox.listAnnouncements().catch(() => []),
    client.info.getGrades().catch(() => []),
    client.calendar.getCalendar().catch(() => []),
  ]);

  // Ostatnie wiadomości z folderu odebranych (folder 5 = odebrane)
  const inboxList = await client.inbox.listInbox(5).catch(() => []);

  return { announcements, grades, calendar, inboxList };
}

// ---------- Główna pętla ----------
function toText(value) {
  if (Array.isArray(value)) return value.join("\n");
  return String(value ?? "");
}

// Pobiera i streszcza dane jednego dziecka.
async function syncChild(child) {
  const loginEnv = `LIBRUS_LOGIN_${child.secretSuffix}`;
  const passEnv = `LIBRUS_PASSWORD_${child.secretSuffix}`;
  const login = process.env[loginEnv];
  const password = process.env[passEnv];

  if (!login || !password) {
    throw new Error(`Brak sekretów ${loginEnv} / ${passEnv} w GitHub Actions`);
  }

  console.log(`[${child.name}] Logowanie do Librusa...`);
  const rawData = await fetchLibrusData(login, password);

  console.log(`[${child.name}] Generowanie podsumowania (Gemini)...`);
  const { summary, detectedEvents } = await summarizeWithGemini(
    {
      announcements: rawData.announcements,
      grades: rawData.grades,
      calendar: rawData.calendar,
      inbox: rawData.inboxList,
    },
    child.name
  );

  return {
    summary: toText(summary),
    detectedEvents: Array.isArray(detectedEvents) ? detectedEvents : [],
  };
}

// Łączy wyniki dzieci w jedno podsumowanie i jedną listę terminów.
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
      r.detectedEvents.map((ev) => ({
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
  for (const r of okResults) {
    childrenData[r.child.secretSuffix] = {
      name: r.child.name,
      summary: r.summary,
      detectedEvents: r.detectedEvents,
      updatedAt: now,
    };
  }

  const status = failed.length === 0 ? "ok" : "error";

  console.log(`[${user.displayName}] Zapis do Firestore...`);
  await userDocRef.set(
    {
      displayName: user.displayName,
      librus: { summary, detectedEvents, children: childrenData, updatedAt: now },
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
