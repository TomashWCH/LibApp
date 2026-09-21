// whatsapp/pair.js
//
// Etap 1: jednorazowe sparowanie WhatsAppa jako "połączone urządzenie".
// Uruchamiane ręcznie z GitHub Actions (.github/workflows/whatsapp-pair.yml).
//
//   1. łączy się z WhatsAppem i prosi o kod parowania dla numeru z sekretu WHATSAPP_PHONE
//   2. zapisuje kod do Firestore (users/{uid}.whatsapp.pairingCode) — appka pokazuje go
//      na pulpicie, dzięki czemu kod NIE ląduje w publicznych logach
//   3. czeka, aż wpiszesz kod w WhatsAppie (Połączone urządzenia)
//   4. zapisuje sesję do Firestore (waAuth/{uid}) i listę grup (users/{uid}.whatsapp.groups)
//
// W logach nie wypisujemy numeru telefonu ani nazw grup.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import admin from "firebase-admin";
import pino from "pino";
import makeWASocket, {
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import { useFirestoreAuthState } from "./auth-firestore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAIRING_TIMEOUT_MS = 5 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ---------- Konfiguracja ----------
if (!process.env.FIREBASE_SERVICE_ACCOUNT) fail("Brak sekretu FIREBASE_SERVICE_ACCOUNT.");
const phone = String(process.env.WHATSAPP_PHONE ?? "").replace(/\D/g, "");
if (phone.length < 8) {
  fail("Brak sekretu WHATSAPP_PHONE (sam numer z kodem kraju, bez plusa i spacji, np. 48XXXXXXXXX).");
}

const { users } = JSON.parse(
  readFileSync(path.join(__dirname, "..", "scripts", "users.config.json"), "utf-8")
);
const owner = users.find((u) => u.firestoreUid && !u.firestoreUid.startsWith("WKLEJ_TU_"));
if (!owner) fail("W scripts/users.config.json nie ma uzupełnionego firestoreUid.");

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});
const db = admin.firestore();
const userDocRef = db.collection("users").doc(owner.firestoreUid);
const { Timestamp, FieldValue } = admin.firestore;

const setWhatsapp = (patch) => userDocRef.set({ whatsapp: patch }, { merge: true });

// ---------- Parowanie ----------
async function main() {
  await setWhatsapp({
    status: "connecting",
    error: FieldValue.delete(),
    pairingCode: FieldValue.delete(),
  });

  const { state, saveCreds, flush } = await useFirestoreAuthState(db, owner.firestoreUid);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  const logger = pino({ level: "silent" });

  if (state.creds.registered) {
    console.log("Ta sesja jest już sparowana — łączę się tylko, żeby odświeżyć listę grup.");
  }

  let sock;
  let codeRequested = false;
  let codeAt = null; // kiedy wygenerowano kod (do diagnostyki)

  const opened = new Promise((resolve, reject) => {
    const start = () => {
      sock = makeWASocket({
        version,
        logger,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: Browsers.ubuntu("Chrome"),
        qrTimeout: 120000, // dłużej niż domyślne 60/20 s — więcej czasu na wpisanie kodu
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });

      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Serwer WhatsAppa jest gotowy na parowanie, gdy przysyła "qr" — wtedy prosimy o kod.
        if (qr && !state.creds.registered && !codeRequested) {
          codeRequested = true;
          try {
            const raw = await sock.requestPairingCode(phone);
            const code = String(raw).match(/.{1,4}/g).join("-");
            codeAt = Date.now();
            await setWhatsapp({
              status: "pairing",
              pairingCode: code,
              pairingAt: Timestamp.now(),
              error: FieldValue.delete(),
            });
            console.log("Kod parowania czeka w appce (pulpit → WhatsApp). Wpisz go w WhatsAppie.");
          } catch (err) {
            reject(err);
          }
        }

        if (connection === "open") resolve();

        if (connection === "close") {
          const status = lastDisconnect?.error?.output?.statusCode;
          if (status === DisconnectReason.restartRequired) {
            // Normalne tuż po wpisaniu kodu: trzeba nawiązać połączenie od nowa.
            start();
          } else if (status === DisconnectReason.loggedOut) {
            reject(new Error("WhatsApp wylogował to urządzenie (401). Uruchom parowanie od nowa."));
          } else {
            const reason = lastDisconnect?.error?.message;
            const since = codeAt ? Math.round((Date.now() - codeAt) / 1000) : null;
            reject(
              new Error(
                `Połączenie z WhatsAppem zostało zamknięte (kod ${status ?? "?"}${reason ? `: ${reason}` : ""}${since != null ? `, ${since} s po wygenerowaniu kodu` : ""}).`
              )
            );
          }
        }
      });
    };
    start();
  });

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Upłynął czas na wpisanie kodu w WhatsAppie.")), PAIRING_TIMEOUT_MS)
  );

  await Promise.race([opened, timeout]);
  console.log("Połączono z WhatsAppem.");

  // Chwila na dokończenie synchronizacji początkowej, zanim zapiszemy sesję i wyjdziemy.
  await sleep(8000);

  let groups = [];
  try {
    const all = await sock.groupFetchAllParticipating();
    groups = Object.values(all)
      .map((g) => ({ id: g.id, name: g.subject || "(bez nazwy)", size: g.participants?.length ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name, "pl"));
    console.log(`Znaleziono grup: ${groups.length}`);
  } catch (err) {
    console.warn(`Nie udało się pobrać listy grup: ${err.message}`);
  }

  await setWhatsapp({
    status: "paired",
    pairedAt: Timestamp.now(),
    groups,
    pairingCode: FieldValue.delete(),
    error: FieldValue.delete(),
  });

  await flush();
  try { sock.end(undefined); } catch {}
  console.log("Gotowe — sesja zapisana.");
  process.exit(0);
}

main().catch(async (err) => {
  console.error("BŁĄD:", err.message);
  try {
    await setWhatsapp({ status: "error", error: err.message, pairingCode: FieldValue.delete() });
  } catch {}
  process.exit(1);
});
