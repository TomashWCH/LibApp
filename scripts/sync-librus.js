// scripts/sync-librus.js
//
// Uruchamiane cyklicznie przez GitHub Actions (.github/workflows/sync.yml).
// Dla każdego użytkownika z users.config.json:
//   1. loguje się do Librusa (login/hasło z sekretów GitHub Actions)
//   2. pobiera: nieprzeczytane wiadomości/ogłoszenia, oceny, terminarz
//   3. wysyła zebrane dane do Gemini z prośbą o zwięzłe podsumowanie PL
//      + wykrycie terminów, które mogłyby trafić do kalendarza
//   4. zapisuje wynik do Firestore (users/{uid}) + historię synchronizacji
//
// Błąd dla jednego użytkownika NIE przerywa synchronizacji pozostałych.

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
const GEMINI_MODEL = "gemini-2.0-flash"; // szybki i mieści się w darmowym limicie
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

async function summarizeWithGemini(rawData) {
  const prompt = `
Jesteś asystentem podsumowującym dziennik elektroniczny Librus dla rodzica/ucznia.
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
async function syncUser(user) {
  const loginEnv = `LIBRUS_LOGIN_${user.secretSuffix}`;
  const passEnv = `LIBRUS_PASSWORD_${user.secretSuffix}`;
  const login = process.env[loginEnv];
  const password = process.env[passEnv];

  const userDocRef = db.collection("users").doc(user.firestoreUid);
  const syncHistoryRef = userDocRef.collection("syncHistory").doc();
  const startedAt = admin.firestore.Timestamp.now();

  if (!login || !password) {
    throw new Error(
      `Brak sekretów ${loginEnv} / ${passEnv} w GitHub Actions dla użytkownika ${user.displayName}`
    );
  }

  console.log(`[${user.displayName}] Logowanie do Librusa...`);
  const rawData = await fetchLibrusData(login, password);

  console.log(`[${user.displayName}] Generowanie podsumowania (Gemini)...`);
  const { summary, detectedEvents } = await summarizeWithGemini({
    announcements: rawData.announcements,
    grades: rawData.grades,
    calendar: rawData.calendar,
    inbox: rawData.inboxList,
  });

  console.log(`[${user.displayName}] Zapis do Firestore...`);
  await userDocRef.set(
    {
      displayName: user.displayName,
      librus: {
        summary,
        detectedEvents,
        updatedAt: admin.firestore.Timestamp.now(),
      },
      lastSync: {
        status: "ok",
        timestamp: admin.firestore.Timestamp.now(),
      },
    },
    { merge: true }
  );

  await syncHistoryRef.set({
    startedAt,
    finishedAt: admin.firestore.Timestamp.now(),
    status: "ok",
    module: "librus",
  });
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
      await syncUser(user);
      results.push({ user: user.displayName, status: "ok" });
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

  // Jeśli WSZYSCY użytkownicy się wysypali, niech workflow zakończy się błędem
  // (żeby GitHub Actions wysłał Ci powiadomienie mailem o nieudanym uruchomieniu)
  if (results.length > 0 && results.every((r) => r.status === "error")) {
    process.exit(1);
  }
}

main();
