// notify/notify.js
//
// Powiadomienia push (Web Push, bez zewnętrznych usług). Uruchamiane po synchronizacjach
// w .github/workflows/sync.yml oraz ręcznie w .github/workflows/notify-test.yml.
//
//   1. przy pierwszym uruchomieniu tworzy klucze VAPID (zapisane w Firestore, klient ich nie widzi)
//      i publikuje klucz publiczny w users/{uid}.pushPublicKey — appka używa go do zapisu urządzenia
//   2. porównuje aktualne dane z odciskiem z poprzedniego przebiegu i wysyła powiadomienia
//      o nowych ocenach, uwagach, sprawdzianach, zadaniach i wiadomościach
//   3. o 7:xx wysyła poranne podsumowanie (dziś), o 19:xx wieczorne (jutro),
//      a w niedzielę o 19:xx przegląd tygodnia
//
// W logach nie wypisujemy treści powiadomień ani imion.
//
// Zmienne pomocnicze do ręcznych testów:
//   NOTIFY_TEST=1              — wyślij tylko powiadomienie testowe
//   NOTIFY_DIGEST=morning|evening|week — wyślij wskazane podsumowanie teraz

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import admin from "firebase-admin";
import webpush from "web-push";
import { snapshotOf, diffNotifications, buildDigest, warsawNow } from "./logic.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!process.env.FIREBASE_SERVICE_ACCOUNT) fail("Brak sekretu FIREBASE_SERVICE_ACCOUNT.");

const { users } = JSON.parse(readFileSync(path.join(__dirname, "..", "scripts", "users.config.json"), "utf-8"));
const owner = users.find((u) => u.firestoreUid && !u.firestoreUid.startsWith("WKLEJ_TU_"));
if (!owner) fail("W scripts/users.config.json nie ma uzupełnionego firestoreUid.");

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const { Timestamp, FieldValue } = admin.firestore;

const uid = owner.firestoreUid;
const userRef = db.collection("users").doc(uid);
const prefsDoc = (name) => userRef.collection("prefs").doc(name);
const stateRef = db.collection("waNotify").doc(uid);
const vapidRef = db.collection("waNotify").doc(`vapid-${uid}`);

async function ensureVapid() {
  const snap = await vapidRef.get();
  let keys = snap.exists ? snap.data() : null;
  if (!keys?.publicKey || !keys?.privateKey) {
    const fresh = webpush.generateVAPIDKeys();
    keys = { publicKey: fresh.publicKey, privateKey: fresh.privateKey };
    await vapidRef.set({ ...keys, createdAt: Timestamp.now() });
    console.log("Utworzono klucze VAPID.");
  }
  const user = (await userRef.get()).data() || {};
  if (user.pushPublicKey !== keys.publicKey) await userRef.set({ pushPublicKey: keys.publicKey }, { merge: true });
  webpush.setVapidDetails(
    process.env.WEBPUSH_SUBJECT ||
      (process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : "mailto:libapp@example.com"),
    keys.publicKey,
    keys.privateKey
  );
}

async function sendAll(subs, payloads) {
  const dead = new Set();
  let sent = 0;
  for (const [id, sub] of Object.entries(subs)) {
    for (const p of payloads) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify({ url: "./", ...p }), { TTL: 6 * 3600, urgency: "normal" });
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) { dead.add(id); break; }
        console.warn(`  ! push do urządzenia ${id}: ${err.statusCode || err.message}`);
      }
    }
  }
  for (const id of dead) await prefsDoc("push").set({ subs: { [id]: FieldValue.delete() } }, { merge: true });
  if (dead.size) console.log(`Usunięto nieaktualne urządzenia: ${dead.size}.`);
  return sent;
}

async function main() {
  await ensureVapid();

  const pushDoc = (await prefsDoc("push").get()).data() || {};
  const subs = Object.fromEntries(Object.entries(pushDoc.subs || {}).filter(([, s]) => s && s.endpoint && s.keys));
  const subCount = Object.keys(subs).length;
  console.log(`Urządzeń z włączonymi powiadomieniami: ${subCount}.`);

  if (process.env.NOTIFY_TEST) {
    const sent = await sendAll(subs, [{ title: "Test powiadomień", body: "Jeśli to widzisz, powiadomienia z serwera działają.", tag: "test" }]);
    console.log(`Test: wysłano ${sent}.`);
    return;
  }

  const userData = (await userRef.get()).data() || {};
  const prefsState = (await prefsDoc("state").get()).data() || {};
  const names = prefsState.names || {};
  const done = Array.isArray(prefsState.done) ? prefsState.done : [];

  const state = (await stateRef.get()).data() || {};
  const now = warsawNow(process.env.NOTIFY_NOW ? new Date(process.env.NOTIFY_NOW) : new Date()); // NOTIFY_NOW: tylko do testów
  const payloads = [];

  // 1) nowości
  const news = diffNotifications(state.snapshot, userData, names);
  payloads.push(...news);
  console.log(`Nowości do powiadomienia: ${news.length}${state.snapshot ? "" : " (pierwszy przebieg — tylko zapamiętuję stan)"}.`);

  // 2) podsumowania
  const patch = {};
  let kind = process.env.NOTIFY_DIGEST || null;
  if (!kind) {
    if (now.hour === 7 && state.lastMorning !== now.today) kind = "morning";
    else if (now.hour === 19 && now.weekday === 0 && state.lastWeek !== now.today) kind = "week";
    else if (now.hour === 19 && now.weekday !== 0 && state.lastEvening !== now.today) kind = "evening";
  }
  if (kind) {
    const digest = buildDigest(kind, userData, { today: now.today, done, names });
    if (digest) payloads.push(digest);
    if (!process.env.NOTIFY_DIGEST) patch[kind === "morning" ? "lastMorning" : kind === "week" ? "lastWeek" : "lastEvening"] = now.today;
    console.log(`Podsumowanie (${kind}): ${digest ? "jest co pokazać" : "nic do pokazania"}.`);
  }

  const sent = subCount ? await sendAll(subs, payloads) : 0;
  console.log(`Wysłano powiadomień: ${sent} (${payloads.length} treści × ${subCount} urządzeń).`);

  await stateRef.set({ ...patch, snapshot: snapshotOf(userData), updatedAt: Timestamp.now() }, { merge: true });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("BŁĄD:", err.message);
    process.exit(1);
  });
