// Trimite o raportare în aplicația Team Vodă, prin intrarea „Argus” din scriptul ei (doPost).
// Cheia și adresa stau doar în config.json („teamVoda”: {"url": "...", "secret": "..."}), nu ajung la model.
// Folosire: node team-voda.mjs ping
//           node team-voda.mjs raport '{"name":"…","weekStart":"2026-10-17","values":{"an":2},"cid":"…"}'
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function fail(message) {
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
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
if (action !== "ping" && action !== "raport") fail("Acțiunea e „ping” sau „raport”.");
let payload;
if (action === "raport") {
  try {
    payload = JSON.parse(process.argv[3] || "");
  } catch {
    fail("Raportarea trebuie dată ca JSON.");
  }
  if (!payload?.name || !(payload.weekStart || payload.periodStart) || typeof payload.values !== "object") {
    fail("Raportarea are nevoie de name, weekStart (sâmbăta, aaaa-ll-zz) și values.");
  }
}

// Raportarea pleacă doar dacă puntea a deschis lacătul pentru exact această cerere, după „Da”; lacătul se folosește o dată.
if (action === "raport") {
  const gateFile = join(HERE, "gate-teamvoda.json");
  let gate = null;
  try {
    gate = existsSync(gateFile) ? JSON.parse(readFileSync(gateFile, "utf8")) : null;
  } catch {
    gate = null;
  }
  if (!gate || gate.cid !== payload.cid || !(Date.now() < gate.until)) {
    fail("Raportarea pleacă doar după „Da”-ul lui Daniel, pentru cererea confirmată (cid).");
  }
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
  body: JSON.stringify({ secret, action, payload }),
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
