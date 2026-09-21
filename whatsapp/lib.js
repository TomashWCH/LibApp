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
