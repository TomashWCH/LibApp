// whatsapp/auth-firestore.js
//
// Przechowuje sesję WhatsApp (dane logowania + klucze Signal) w Firestore,
// bo GitHub Actions nie ma trwałego dysku między uruchomieniami.
//
// Układ w bazie (klient appki NIE ma do tego dostępu — reguły Firestore
// pozwalają czytać tylko users/{uid}, a waAuth jest domyślnie zablokowane):
//   waAuth/{ownerUid}            -> { creds: "<JSON>", updatedAt }
//   waAuth/{ownerUid}/keys/{id}  -> { v: "<JSON>" }

import admin from "firebase-admin";
import { proto, initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";

const fixId = (s) => String(s).replace(/\//g, "__").replace(/:/g, "-");
const BATCH_LIMIT = 400;

export async function useFirestoreAuthState(db, ownerUid) {
  const base = db.collection("waAuth").doc(ownerUid);
  const keysCol = base.collection("keys");

  const snap = await base.get();
  const stored = snap.exists ? snap.data()?.creds : null;
  const creds = stored ? JSON.parse(stored, BufferJSON.reviver) : initAuthCreds();

  // Śledzimy zapisy w toku, żeby przed zakończeniem procesu móc na nie poczekać.
  const pending = new Set();
  const track = (promise) => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
    return promise;
  };

  const keys = {
    get: async (type, ids) => {
      const data = {};
      if (ids.length === 0) return data;
      const refs = ids.map((id) => keysCol.doc(fixId(`${type}-${id}`)));
      const docs = await db.getAll(...refs);
      docs.forEach((doc, i) => {
        let value = doc.exists ? JSON.parse(doc.data().v, BufferJSON.reviver) : null;
        if (type === "app-state-sync-key" && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        data[ids[i]] = value;
      });
      return data;
    },
    set: async (data) => {
      const ops = [];
      for (const type in data) {
        for (const id in data[type]) {
          const value = data[type][id];
          ops.push({ ref: keysCol.doc(fixId(`${type}-${id}`)), value });
        }
      }
      const run = async () => {
        for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
          const batch = db.batch();
          for (const { ref, value } of ops.slice(i, i + BATCH_LIMIT)) {
            if (value) batch.set(ref, { v: JSON.stringify(value, BufferJSON.replacer) });
            else batch.delete(ref);
          }
          await batch.commit();
        }
      };
      await track(run());
    },
  };

  const saveCreds = () =>
    track(
      base.set(
        {
          creds: JSON.stringify(creds, BufferJSON.replacer),
          updatedAt: admin.firestore.Timestamp.now(),
        },
        { merge: true }
      )
    );

  const flush = () => Promise.allSettled([...pending]);

  return { state: { creds, keys }, saveCreds, flush };
}
