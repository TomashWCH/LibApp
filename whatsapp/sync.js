// whatsapp/sync.js
//
// Etap 2: codzienne podsumowanie wybranych grup WhatsApp.
// Uruchamiane po synchronizacji Librusa (.github/workflows/sync.yml).
//
//   1. łączy się z WhatsAppem na sparowanej sesji (zapisanej w Firestore)
//   2. odbiera wiadomości, które czekały, gdy urządzenie było offline
//   3. dla każdej skonfigurowanej grupy streszcza je przez Gemini
//   4. zapisuje streszczenia do users/{uid}.whatsapp.summaries.<SUFFIX>
//
// Konfiguracja grup: sekret WHATSAPP_GROUPS (JSON), np.
//   [{"name":"Nazwa grupy","child":"DZIECKO1"}]
// "child" to końcówka sekretów dziecka z users.config.json (secretSuffix).
//
// W logach nie wypisujemy nazw grup, numerów ani treści wiadomości.
// Surowe wiadomości trafiają do bazy (waPending) TYLKO na czas streszczania —
// po udanym streszczeniu są usuwane.

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
  isJidGroup,
} from "@whiskeysockets/baileys";
import { useFirestoreAuthState } from "./auth-firestore.js";
import { normName, toEntry, mergeMessages, pruneEntries } from "./lib.js";
import { summarizeGroup } from "./gemini.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTLE_MS = 6000; // cisza po ostatniej wiadomości, zanim uznamy odbiór za zakończony
const MAX_WAIT_MS = 75000; // twardy limit na połączenie i odbiór
const TZ = "Europe/Warsaw";

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ---------- Konfiguracja ----------
if (!process.env.FIREBASE_SERVICE_ACCOUNT) fail("Brak sekretu FIREBASE_SERVICE_ACCOUNT.");
if (!process.env.WHATSAPP_GROUPS) {
  console.log("Brak sekretu WHATSAPP_GROUPS — pomijam moduł WhatsApp.");
  process.exit(0);
}
if (!process.env.GEMINI_API_KEY) fail("Brak sekretu GEMINI_API_KEY.");

const { users } = JSON.parse(
  readFileSync(path.join(__dirname, "..", "scripts", "users.config.json"), "utf-8")
);
const owner = users.find((u) => u.firestoreUid && !u.firestoreUid.startsWith("WKLEJ_TU_"));
if (!owner) fail("W scripts/users.config.json nie ma uzupełnionego firestoreUid.");

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});
const db = admin.firestore();
const { Timestamp, FieldValue } = admin.firestore;
const userDocRef = db.collection("users").doc(owner.firestoreUid);
const pendingRef = db.collection("waPending").doc(owner.firestoreUid);

const setWhatsapp = (patch) => userDocRef.set({ whatsapp: patch }, { merge: true });

let wanted;
try {
  wanted = JSON.parse(process.env.WHATSAPP_GROUPS);
  if (!Array.isArray(wanted) || wanted.length === 0) throw new Error("pusta lista");
  for (const g of wanted) if (!g?.name || !g?.child) throw new Error("brak pola name lub child");
} catch (err) {
  await setWhatsapp({ sync: { status: "error", at: Timestamp.now(), error: `Sekret WHATSAPP_GROUPS jest niepoprawny (${err.message}).` } }).catch(() => {});
  fail(`Sekret WHATSAPP_GROUPS jest niepoprawny (${err.message}).`);
}
const childName = (suffix) => owner.children?.find((c) => c.secretSuffix === suffix)?.name ?? suffix;

// ---------- Połączenie i odbiór wiadomości ----------
async function connectAndCollect(auth, version, logger) {
  const byJid = new Map(); // jid grupy -> [{ id, ts, from, text }] (tylko w pamięci)

  return new Promise((resolve, reject) => {
    let sock;
    let opened = false;
    let settled = false;
    let restarts = 0;
    let settleTimer = null;
    let pendingDone = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(settleTimer);
      clearTimeout(hardTimer);
      resolve({ sock, byJid });
    };
    const abort = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(settleTimer);
      clearTimeout(hardTimer);
      try { sock?.end(undefined); } catch {}
      reject(err);
    };

    const hardTimer = setTimeout(() => {
      if (!opened) return abort(new Error("Nie udało się połączyć z WhatsAppem w limicie czasu."));
      console.warn("Limit czasu odbioru — kontynuuję z tym, co udało się zebrać.");
      finish();
    }, MAX_WAIT_MS);

    const start = () => {
      sock = makeWASocket({
        version,
        logger,
        auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, logger) },
        browser: Browsers.ubuntu("Chrome"),
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });

      sock.ev.on("creds.update", auth.saveCreds);

      sock.ev.on("messages.upsert", ({ messages }) => {
        for (const m of messages) {
          const jid = m.key?.remoteJid;
          if (!jid || !isJidGroup(jid)) continue;
          const entry = toEntry(m);
          if (!entry) continue;
          if (!byJid.has(jid)) byJid.set(jid, []);
          byJid.get(jid).push(entry);
        }
        if (pendingDone && !settled) {
          clearTimeout(settleTimer);
          settleTimer = setTimeout(finish, SETTLE_MS);
        }
      });

      sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, receivedPendingNotifications } = update;
        if (connection === "open") opened = true;
        if (receivedPendingNotifications && !pendingDone) {
          pendingDone = true;
          settleTimer = setTimeout(finish, SETTLE_MS);
        }
        if (connection === "close" && !settled) {
          const status = lastDisconnect?.error?.output?.statusCode;
          if (status === DisconnectReason.restartRequired && restarts++ < 2) return start();
          if (status === DisconnectReason.loggedOut) {
            return abort(new Error("WhatsApp odrzucił sesję (401). Uruchom Sparuj WhatsApp od nowa."));
          }
          const reason = lastDisconnect?.error?.message;
          abort(new Error(`Połączenie z WhatsAppem zostało zamknięte (kod ${status ?? "?"}${reason ? `: ${reason}` : ""}).`));
        }
      });
    };

    start();
  });
}

// ---------- Rozpoznanie grup ----------
async function resolveGroupIds(sock, storedGroups) {
  const result = new Map(); // suffix -> { id, name }
  const find = (list, name) => list.find((g) => normName(g.name) === normName(name));

  for (const g of wanted) {
    const hit = find(storedGroups, g.name);
    if (hit) result.set(g.child, { id: hit.id, name: hit.name });
  }

  if (result.size < wanted.length) {
    // Któraś grupa nie jest na zapisanej liście — pobieramy aktualną listę z WhatsAppa.
    const all = await sock.groupFetchAllParticipating();
    const live = Object.values(all).map((x) => ({ id: x.id, name: x.subject || "", size: x.participants?.length ?? 0 }));
    for (const g of wanted) {
      if (result.has(g.child)) continue;
      const hit = find(live, g.name);
      if (hit) result.set(g.child, { id: hit.id, name: hit.name });
    }
    await setWhatsapp({ groups: live.sort((a, b) => a.name.localeCompare(b.name, "pl")) }).catch(() => {});
  }
  return result;
}

// ---------- Główna logika ----------
async function main() {
  const startedAt = Timestamp.now();
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });

  const auth = await useFirestoreAuthState(db, owner.firestoreUid);
  if (!auth.state.creds.registered) {
    throw new Error("WhatsApp nie jest sparowany. Uruchom najpierw Sparuj WhatsApp.");
  }

  const userData = (await userDocRef.get()).data() || {};
  const wa = userData.whatsapp || {};
  const storedGroups = Array.isArray(wa.groups) ? wa.groups : [];
  const summaries = wa.summaries || {};

  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  const logger = pino({ level: "silent" });

  console.log("Łączę z WhatsAppem i odbieram wiadomości...");
  const { sock, byJid } = await connectAndCollect(auth, version, logger);

  const groupStatus = {};
  let hadError = false;

  try {
    const resolved = await resolveGroupIds(sock, storedGroups);

    // 1) zaległe wiadomości + nowe -> zapis do bazy przed streszczaniem (żeby nic nie przepadło)
    const pendingDoc = (await pendingRef.get()).data() || {};
    const toSummarize = [];
    for (const g of wanted) {
      const target = resolved.get(g.child);
      if (!target) {
        groupStatus[g.child] = "not_found";
        hadError = true;
        console.warn(`[${g.child}] Nie znaleziono grupy o skonfigurowanej nazwie.`);
        continue;
      }
      const fresh = byJid.get(target.id) || [];
      const merged = mergeMessages(pendingDoc[g.child], fresh);
      console.log(`[${g.child}] nowych wiadomości: ${fresh.length}, do streszczenia: ${merged.length}`);
      if (merged.length === 0) {
        groupStatus[g.child] = "ok";
        continue;
      }
      pendingDoc[g.child] = merged;
      toSummarize.push({ ...g, target, messages: merged });
    }
    if (toSummarize.length > 0) {
      const pendingPatch = {};
      for (const t of toSummarize) pendingPatch[t.child] = t.messages;
      await pendingRef.set(pendingPatch, { merge: true });
    }

    // 2) streszczanie
    for (const t of toSummarize) {
      try {
        const result = await summarizeGroup({
          groupName: t.target.name,
          childName: childName(t.child),
          messages: t.messages,
          today,
        });
        const nowMs = Date.now();
        const entry = { atMs: nowMs, at: Timestamp.now(), messageCount: t.messages.length, ...result };
        const previous = summaries[t.child]?.entries || [];
        const entries = pruneEntries([...previous, entry], nowMs);
        await setWhatsapp({ summaries: { [t.child]: { groupName: t.target.name, entries } } });
        await pendingRef.set({ [t.child]: FieldValue.delete() }, { merge: true });
        groupStatus[t.child] = "ok";
      } catch (err) {
        hadError = true;
        groupStatus[t.child] = "error";
        console.error(`[${t.child}] BŁĄD streszczania: ${err.message}`);
      }
    }
  } finally {
    await auth.flush();
    try { sock.end(undefined); } catch {}
  }

  await setWhatsapp({
    sync: {
      status: hadError ? "error" : "ok",
      at: Timestamp.now(),
      startedAt,
      groups: groupStatus,
      error: hadError
        ? Object.entries(groupStatus)
            .filter(([, s]) => s !== "ok")
            .map(([k, s]) => `${childName(k)}: ${s === "not_found" ? "nie znaleziono grupy" : "błąd streszczania"}`)
            .join("; ")
        : FieldValue.delete(),
    },
  });

  console.log(`Gotowe. Status: ${hadError ? "z błędami" : "ok"}.`);
  process.exit(hadError ? 1 : 0);
}

main().catch(async (err) => {
  console.error("BŁĄD:", err.message);
  try {
    await setWhatsapp({ sync: { status: "error", at: Timestamp.now(), error: err.message } });
  } catch {}
  process.exit(1);
});
