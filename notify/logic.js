// notify/logic.js — czyste funkcje: wykrywanie nowości i budowanie treści powiadomień (bez sieci i bazy).

const TZ = "Europe/Warsaw";

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

const arr = (v) => (Array.isArray(v) ? v : []);
const isoRe = /^\d{4}-\d{2}-\d{2}$/;

export function shiftISO(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

// { today: "YYYY-MM-DD", hour: 0-23, weekday: 0 (niedziela) - 6 } w czasie polskim
export function warsawNow(date = new Date()) {
  const iso = date.toLocaleDateString("sv-SE", { timeZone: TZ });
  const hour = Number(date.toLocaleString("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).slice(0, 2)) % 24;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(date.toLocaleDateString("en-US", { timeZone: TZ, weekday: "short" }));
  return { today: iso, hour, weekday: wd };
}

export const examLabel = (title) =>
  /kartk/i.test(title || "") ? "kartkówka" : /sprawdzian|klasówk|\btest\b|egzamin|dyktando/i.test(title || "") ? "sprawdzian" : "";

const shortDate = (iso) => {
  if (!isoRe.test(iso || "")) return iso || "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("pl-PL", { weekday: "short", day: "numeric", month: "short" });
};
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

export const gradeKey = (g) => (g.id != null ? `g${g.id}` : `${g.subject}|${g.date}|${g.value}`);

// Wszystkie terminy dziecka: z Librusa i wykryte w grupie WhatsApp (bez duplikatów).
export function allEvents(userData, key) {
  const c = userData?.librus?.children?.[key] || {};
  const out = arr(c.sections?.events).map((e) => ({ ...e }));
  const seen = new Set(out.map((e) => `${e.title}|${e.date}|${e.time || ""}`));
  for (const en of arr(userData?.whatsapp?.summaries?.[key]?.entries)) {
    for (const ev of arr(en.events)) {
      const k = `${ev.title}|${ev.date}|${ev.time || ""}`;
      if (!seen.has(k)) { seen.add(k); out.push({ ...ev }); }
    }
  }
  return out;
}

// Zadania do zrobienia (te same identyfikatory co w appce, żeby uwzględnić odhaczone).
export function todoItems(userData) {
  const items = [];
  for (const key of arr(userData?.librus?.childOrder)) {
    const c = userData?.librus?.children?.[key];
    if (!c) continue;
    for (const t of arr(userData?.whatsapp?.todos?.[key])) {
      items.push({ id: `${key}:${t.id}`, kind: "wa", text: t.text, due: t.due || null, key });
    }
    for (const h of arr(c.extra?.homework)) {
      items.push({
        id: `${key}:hw:${cyrb53(`${h.subject}|${h.title}|${h.to}`).toString(32)}`,
        kind: "hw",
        text: `${h.subject ? h.subject + ": " : ""}${h.title}`,
        due: isoRe.test(h.to || "") ? h.to : null,
        key,
      });
    }
  }
  return items;
}

// Odcisk aktualnego stanu — do porównania z poprzednim przebiegiem.
export function snapshotOf(userData) {
  const children = {};
  for (const key of arr(userData?.librus?.childOrder)) {
    const c = userData?.librus?.children?.[key];
    if (!c) continue;
    children[key] = {
      grades: arr(c.extra?.gradeList).map(gradeKey),
      remarks: arr(c.sections?.remarks).map((r) => `${r.date}|${String(r.text || "").slice(0, 50)}`),
      exams: allEvents(userData, key).filter((e) => examLabel(e.title)).map((e) => `${e.date}|${e.title}`),
      messages: arr(c.sections?.messages).map((m) => `${m.from}|${m.subject}|${m.date}`),
      todos: todoItems(userData).filter((t) => t.key === key).map((t) => t.id),
    };
  }
  return { children };
}

// Nowości względem poprzedniego odcisku -> lista powiadomień. Bez poprzedniego odcisku: nic (pierwszy przebieg).
export function diffNotifications(prev, userData, names = {}) {
  if (!prev?.children) return [];
  const out = [];
  const nameOf = (key) => (names[key] || "").trim() || userData?.librus?.children?.[key]?.name || key;
  let messageCount = 0, firstMessage = "";

  for (const key of arr(userData?.librus?.childOrder)) {
    const c = userData?.librus?.children?.[key];
    const before = prev.children[key];
    if (!c || !before) continue; // nowe dziecko lub brak danych — nie zalewamy powiadomieniami
    const name = nameOf(key);

    const oldGrades = new Set(before.grades);
    const newGrades = arr(c.extra?.gradeList).filter((g) => !oldGrades.has(gradeKey(g)));
    if (newGrades.length) {
      const body = newGrades.slice(0, 3).map((g) => `${clip(g.subject, 18)}: ${g.value}${g.category ? ` (${clip(g.category, 22)})` : ""}`).join("; ") + (newGrades.length > 3 ? ` (+${newGrades.length - 3})` : "");
      out.push({ title: newGrades.length === 1 ? `${name}: nowa ocena` : `${name}: ${newGrades.length} nowe oceny`, body, tag: `grades-${key}` });
    }

    const oldRemarks = new Set(before.remarks);
    const newRemarks = arr(c.sections?.remarks).filter((r) => !oldRemarks.has(`${r.date}|${String(r.text || "").slice(0, 50)}`));
    if (newRemarks.length) {
      out.push({ title: `${name}: ${newRemarks.length === 1 ? "nowa uwaga" : `${newRemarks.length} nowe uwagi`}`, body: "Otwórz appkę, aby przeczytać.", tag: `remarks-${key}` });
    }

    const oldExams = new Set(before.exams);
    const newExams = allEvents(userData, key).filter((e) => examLabel(e.title) && !oldExams.has(`${e.date}|${e.title}`));
    if (newExams.length) {
      const e = newExams[0];
      out.push({ title: `${name}: nowy termin`, body: `${clip(e.title, 60)} — ${shortDate(e.date)}${e.time ? ` ${e.time}` : ""}${newExams.length > 1 ? ` (+${newExams.length - 1})` : ""}`, tag: `exams-${key}` });
    }

    const oldTodos = new Set(before.todos);
    const newTodos = todoItems(userData).filter((t) => t.key === key && !oldTodos.has(t.id));
    if (newTodos.length) {
      const t = newTodos[0];
      out.push({ title: `${name}: do zrobienia`, body: `${clip(t.text, 90)}${t.due ? ` — do ${shortDate(t.due)}` : ""}${newTodos.length > 1 ? ` (+${newTodos.length - 1})` : ""}`, tag: `todos-${key}` });
    }

    const oldMsgs = new Set(before.messages);
    for (const m of arr(c.sections?.messages)) {
      if (!oldMsgs.has(`${m.from}|${m.subject}|${m.date}`)) { messageCount++; if (!firstMessage) firstMessage = `${clip(m.subject, 60)}${m.from ? ` — ${clip(m.from, 25)}` : ""}`; }
    }
  }
  if (messageCount) out.push({ title: messageCount === 1 ? "Nowa wiadomość w Librusie" : `${messageCount} nowe wiadomości w Librusie`, body: firstMessage, tag: "messages" });

  if (out.length > 5) {
    const rest = out.length - 4;
    return [...out.slice(0, 4), { title: `I ${rest} innych nowości`, body: "Otwórz appkę, aby zobaczyć wszystko.", tag: "more" }];
  }
  return out;
}

// Podsumowanie: "morning" (dziś), "evening" (jutro) lub "week" (najbliższe 7 dni od jutra).
export function buildDigest(kind, userData, { today, done = [], names = {} } = {}) {
  const doneSet = new Set(done);
  const nameOf = (key) => (names[key] || "").trim() || userData?.librus?.children?.[key]?.name || key;
  const from = kind === "morning" ? today : shiftISO(today, 1);
  const days = kind === "week" ? Array.from({ length: 7 }, (_, i) => shiftISO(from, i)) : [from];

  const lines = [];
  let exams = 0, tasks = 0, events = 0;
  for (const key of arr(userData?.librus?.childOrder)) {
    for (const e of allEvents(userData, key)) {
      if (!days.includes(e.date)) continue;
      const lab = examLabel(e.title);
      if (lab) exams++; else events++;
      lines.push({ sort: `${e.date} ${e.time || "99"}`, text: `${nameOf(key)}: ${clip(e.title, 50)}${e.time ? ` ${e.time}` : ""}${kind === "week" ? ` (${shortDate(e.date)})` : ""}` });
    }
    for (const t of todoItems(userData).filter((x) => x.key === key && x.due && days.includes(x.due) && !doneSet.has(x.id))) {
      tasks++;
      lines.push({ sort: `${t.due} 98`, text: `${nameOf(key)}: ${t.kind === "hw" ? "zadanie" : "do zrobienia"} — ${clip(t.text, 50)}` });
    }
  }
  if (!lines.length) return null;
  lines.sort((a, b) => a.sort.localeCompare(b.sort));

  if (kind === "week") {
    const parts = [exams && `sprawdziany i kartkówki: ${exams}`, tasks && `zadania: ${tasks}`, events && `terminy: ${events}`].filter(Boolean);
    return { title: "Przegląd tygodnia", body: `Przed nami: ${parts.join(", ")}.`, tag: "digest-week" };
  }
  const shown = lines.slice(0, 3).map((l) => l.text);
  const more = lines.length > 3 ? ` (+${lines.length - 3})` : "";
  return { title: kind === "morning" ? "Dzień dobry! Dziś w szkole" : "Na jutro", body: shown.join("\n") + more, tag: `digest-${kind}` };
}
