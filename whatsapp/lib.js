// whatsapp/lib.js — czyste funkcje pomocnicze (bez sieci i bazy), dzięki temu łatwe do testowania.

import { normalizeMessageContent, toNumber } from "@whiskeysockets/baileys";

const TZ = "Europe/Warsaw";

// Nazwy grup porównujemy bez różnic w wielkości liter, spacjach i rodzaju myślnika.
export function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// Zamienia wiadomość WhatsApp na krótki tekst (albo null, gdy nie ma czego streszczać).
export function extractText(msg) {
  const content = normalizeMessageContent(msg?.message);
  if (!content) return null;

  const withCaption = (label, caption) => (caption ? `${label} ${caption}` : label);

  if (content.conversation) return content.conversation;
  if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
  if (content.imageMessage) return withCaption("[zdjęcie]", content.imageMessage.caption);
  if (content.videoMessage) return withCaption("[film]", content.videoMessage.caption);
  if (content.documentMessage) {
    const name = content.documentMessage.fileName;
    return withCaption(`[dokument${name ? ": " + name : ""}]`, content.documentMessage.caption);
  }
  if (content.audioMessage) return "[wiadomość głosowa]";
  if (content.pollCreationMessage || content.pollCreationMessageV3) {
    const poll = content.pollCreationMessage || content.pollCreationMessageV3;
    return `[ankieta: ${poll.name ?? ""}]`;
  }
  return null; // reakcje, naklejki, wiadomości systemowe itp.
}

export function fmtTime(tsSeconds) {
  return new Date(tsSeconds * 1000).toLocaleString("sv-SE", { timeZone: TZ }).slice(0, 16); // YYYY-MM-DD HH:MM
}

// Z surowej wiadomości Baileysa robi { id, ts, from, text } albo null.
export function toEntry(msg) {
  const text = extractText(msg);
  if (!text || !text.trim()) return null;
  const raw = msg.messageTimestamp;
  const ts = typeof raw === "number" ? raw : raw ? toNumber(raw) : Math.floor(Date.now() / 1000);
  const participant = msg.key?.participant || "";
  const from = msg.key?.fromMe
    ? "Ja"
    : msg.pushName || (participant ? `…${participant.split("@")[0].slice(-4)}` : "ktoś");
  return { id: msg.key?.id, ts, from, text: text.trim().slice(0, 800) };
}

// Łączy zaległe wiadomości z nowymi, bez duplikatów, od najstarszej.
export function mergeMessages(oldList, newList, cap = 500) {
  const seen = new Set();
  const out = [];
  for (const m of [...(oldList || []), ...(newList || [])]) {
    if (!m || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.slice(-cap);
}

// Zostawia wpisy z ostatnich `hours` godzin, maksymalnie `max` sztuk.
export function pruneEntries(entries, nowMs, hours = 72, max = 8) {
  const limit = nowMs - hours * 3600 * 1000;
  return (entries || [])
    .filter((e) => (e.atMs ?? 0) >= limit)
    .sort((a, b) => a.atMs - b.atMs)
    .slice(-max);
}

// ---------- Lista "Do zrobienia" (zadania wykryte w grupach) ----------
export function cyrb53(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const isoRe = /^\d{4}-\d{2}-\d{2}$/;

export function addDaysISO(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

export const todoId = (text, due) =>
  "t" + cyrb53(normName(text).replace(/[^\p{L}\p{N} ]/gu, "") + "|" + (due || "")).toString(32);

// Łączy zapisane zadania z nowymi (bez duplikatów) i usuwa stare:
// z terminem sprzed ponad 7 dni albo dodane ponad 45 dni temu.
export function mergeTodos(existing, incoming, nowMs, todayISO, max = 60) {
  const map = new Map();
  for (const t of existing || []) if (t?.id) map.set(t.id, t);
  for (const t of incoming || []) {
    const text = String(t?.text ?? "").trim();
    if (!text) continue;
    const due = isoRe.test(t?.due ?? "") ? t.due : null;
    const id = todoId(text, due);
    if (!map.has(id)) map.set(id, { id, text: text.slice(0, 200), due, addedAtMs: nowMs });
  }
  const dropBefore = addDaysISO(todayISO, -7);
  const oldest = nowMs - 45 * 24 * 3600 * 1000;
  return [...map.values()]
    .filter((t) => (!t.due || t.due >= dropBefore) && (t.addedAtMs ?? nowMs) >= oldest)
    .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || (a.addedAtMs ?? 0) - (b.addedAtMs ?? 0))
    .slice(0, max);
}
