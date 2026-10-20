// Lucrează în aplicația Team Vodă prin intrarea „Argus” din scriptul ei (doPost).
// Cheia și adresa stau doar în config.json („teamVoda”: {"url": "...", "secret": "..."}), nu ajung la model.
// Folosire: node team-voda.mjs ping
//           node team-voda.mjs raport '{"name":"…","weekStart":"2026-10-17","values":{"an":2},"cid":"…"}'
//           node team-voda.mjs tel '{"weekStart":"2026-10-24","rows":[{"name":"…","tel":{"an":5,"cons":3,"service":1}}],"cid":"…"}'
//           node team-voda.mjs call '{"fn":"AR_myReports","args":["…",""]}'
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Funcțiile care doar citesc merg fără „Da”; orice altceva are nevoie de lacăt.
const READ_FNS = new Set(["AR_myReports", "AR_mgLista"]);

function fail(message) {
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
}

// Aceeași formă indiferent de ordinea cheilor, ca să comparăm exact ce a confirmat Daniel.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

let config = {};
try {
  config = JSON.parse(readFileSync(join(HERE, "config.json"), "utf8"));
} catch {
  fail("Nu pot citi config.json.");
}
const { url, secret } = config.teamVoda || {};
if (!url || !secret) fail("Intrarea Team Vodă nu e configurată încă (lipsește „teamVoda” din config.json).");

const action = process.argv[2];
if (!["ping", "raport", "tel", "call"].includes(action)) fail("Acțiunea e „ping”, „raport”, „tel” sau „call”.");
let payload;
if (action !== "ping") {
  try {
    payload = JSON.parse(process.argv[3] || "");
  } catch {
    fail("Datele trebuie date ca JSON.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("Datele trebuie să fie un obiect JSON.");
}
if (action === "raport") {
  if (!payload.name || !payload.weekStart || typeof payload.values !== "object") {
    fail("Raportarea are nevoie de name, weekStart (sâmbăta, aaaa-ll-zz) și values.");
  }
  payload.name = String(payload.name).trim();
  payload.values = Object.fromEntries(Object.entries(payload.values).map(([key, value]) => [key, Number(value)]));
}
if (action === "call" && (typeof payload.fn !== "string" || (payload.args !== undefined && !Array.isArray(payload.args)))) {
  fail("„call” are nevoie de fn și args (listă).");
}

const readOnly = action === "ping" || (action === "call" && READ_FNS.has(payload.fn));
if (!readOnly) {
  // Scrierile pleacă doar dacă puntea a deschis lacătul după „Da”, pentru exact această cerere și exact aceste date; lacătul se folosește o dată.
  const gateFile = join(HERE, "gate-teamvoda.json");
  let gate = null;
  try {
    gate = existsSync(gateFile) ? JSON.parse(readFileSync(gateFile, "utf8")) : null;
  } catch {
    gate = null;
  }
  if (!gate || gate.cid !== payload.cid || !(Date.now() < gate.until)) {
    fail("Scrierea pleacă doar după „Da”-ul lui Daniel, pentru cererea confirmată (cid).");
  }
  const { cid, ...data } = payload;
  if (action === "call") data.args = data.args ?? [];
  if (gate.action !== action || canonical(gate.payload) !== canonical(data)) {
    fail("Datele diferă de cele confirmate de Daniel, deci nu pleacă.");
  }
  // Doar raportul folosește cid (aplicația nu-l scrie de două ori); la celelalte nu se trimite.
  if (action !== "raport") payload = data;
  else payload = { ...data, cid };
  try {
    unlinkSync(gateFile);
  } catch {
    // dacă nu se poate scoate, expiră singur
  }
}

// Apps Script răspunde la POST cu o redirecționare spre rezultat; fetch o urmează singur.
const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "text/plain;charset=utf-8" },
  // La „call”, aplicația citește fn și args direct din corp; le punem și în payload, pentru versiunile mai vechi.
  body: JSON.stringify(action === "call" ? { secret, action, fn: payload.fn, args: payload.args ?? [], payload } : { secret, action, payload }),
  redirect: "follow",
}).catch((error) => fail(`Aplicația nu răspunde: ${error.message}`));
const text = await response.text();
try {
  const data = JSON.parse(text);
  console.log(JSON.stringify(data));
  process.exit(data.ok === false ? 1 : 0);
} catch {
  fail(`Răspuns neașteptat de la aplicație (${response.status}).`);
}
