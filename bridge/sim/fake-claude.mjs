#!/usr/bin/env node
// Claude Code de probă: imită -p json și stream-json; comportamentul vine din cuvinte-cheie din prompt.
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const stream = args.includes("stream-json");
const allowed = args[args.indexOf("--allowedTools") + 1] ?? "";
const disallowed = args[args.indexOf("--disallowedTools") + 1] ?? "";
const kind = args.includes("--permission-prompt-tool") ? "wa" : "work";
const mcpConfig = args.includes("--mcp-config") ? args[args.indexOf("--mcp-config") + 1] : "";
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "";
const id = Math.random().toString(36).slice(2, 7);
const note = (...p) => appendFileSync(process.env.SIM_LOG, [Date.now(), id, stream ? "stream" : "json", kind, model, ...p].join(" | ") + "\n");
note("start", `computerDenied=${disallowed.includes("claude-in-chrome__computer")} batchDenied=${disallowed.includes("browser_batch")}`);

// Întreabă lacătul (ca Claude Code cu --permission-prompt-tool) dacă are voie la o unealtă.
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
async function askGate(calls) {
  if (!mcpConfig) return "fără lacăt";
  const server = JSON.parse(readFileSync(mcpConfig, "utf8")).mcpServers.argus_gate;
  const child = spawn(server.command, server.args);
  let buffer = "";
  const waiting = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) { const m = JSON.parse(line); waiting.get(m.id)?.(m); }
  });
  let next = 1;
  const rpc = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  await rpc("initialize", { protocolVersion: "2025-06-18" });
  const out = [];
  for (const [tool, input] of calls) {
    const reply = await rpc("tools/call", { name: "approve", arguments: { tool_name: tool, input } });
    out.push(`${input.action ?? tool.split("__").pop()}:${input.text ?? ""}=${JSON.parse(reply.result.content[0].text).behavior}`);
  }
  child.kill();
  return out.join(", ");
}
const C = "mcp__claude-in-chrome__computer";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function answer(content) {
  const has = (k) => content.includes(k);
  if (has("Pregătire, nu e o cerere")) { await sleep(1500); return { result: "gata" }; }
  if (has("Google Calendar evenimentele")) return { result: "[]" };
  if (has("Verificare automată pentru alerte")) return { result: "ALERTA\n- mail:ana-contract | Ana îți cere contractul până mâine.\n- buget:mancare | Mâncarea e la 95% din buget.\nrând fără format" };
  if (has("SIM_CRASHALL") || (has("SIM_CRASH") && stream)) { process.stderr.write("Error: simulated crash\n"); note("crash"); process.exit(1); }
  if (has("SIM_HANG")) { note("hang"); await sleep(1e9); }
  if (has("SIM_LIMIT")) return { result: "Claude AI usage limit reached · resets 3am (Europe/Bucharest)", is_error: true };
  if (has("SIM_ONCE")) {
    const { existsSync, writeFileSync } = await import("node:fs");
    const flag = process.env.SIM_LOG + ".once";
    if (!existsSync(flag)) { writeFileSync(flag, "1"); return { result: "API Error: 529 {\"type\":\"overloaded_error\"}", is_error: true }; }
  }
  if (has("SIM_ERROR")) return { result: "API Error: 529 overloaded", is_error: true };
  if (has("SIM_SLOW")) await sleep(3000); else await sleep(300);
  if (has("SIM_CONFIRM") && !has("a apăsat Da")) return { result: 'Am pregătit mesajul.\nCONFIRMARE: {"titlu": "Trimit pe WhatsApp lui Jess: Salut", "text": "Salut", "destinatar": "Jess"}' };
  if (has("SIM_VIZ")) return { result: 'Echipa e la 70%.\nVIZUAL: {"cifre": [{"eticheta": "Analize", "valoare": "14"}], "progres": [{"eticheta": "Analize", "valoare": 14, "maxim": 20}]}\nAtât.' };
  if (has("SIM_BADVIZ")) return { result: 'Gata.\nVIZUAL: {"cifre": [ broken' };
  if (has("a apăsat Da")) {
    const gate = await askGate([[C, { action: "type", text: "Jess" }], [C, { action: "key", text: "Enter" }], [C, { action: "type", text: "Salut" }], [C, { action: "type", text: "Altceva" }], [C, { action: "type", text: "S" }], [C, { action: "type", text: "Jes" }], [C, { action: "key", text: "ctrl+v" }], ["mcp__claude_ai_Gmail__send_message", {}]]);
    note("gate-send", gate);
    return { result: "Trimis pe WhatsApp. Lacăt: " + gate };
  }
  if (has("SIM_GATE_READ")) {
    const gate = await askGate([[C, { action: "screenshot" }], [C, { action: "left_click" }], [C, { action: "type", text: "Salut" }], ["mcp__claude_ai_Gmail__send_message", {}]]);
    note("gate-read", gate);
    return { result: "Citit. Lacăt: " + gate };
  }
  return { result: "Făcut." };
}
const emit = (r) => process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "s-" + id, is_error: false, ...r }) + "\n");
if (stream) {
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\n");
  let buf = "";
  let queue = Promise.resolve();
  process.stdin.on("data", (c) => {
    buf += c;
    const lines = buf.split("\n"); buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const content = JSON.parse(line).message.content;
      note("msg", content.slice(-60).replace(/\n/g, " "));
      queue = queue.then(() => answer(content)).then(emit);
    }
  });
  process.stdin.on("end", () => queue.then(() => process.exit(0)));
} else {
  let all = "";
  process.stdin.on("data", (c) => (all += c));
  process.stdin.on("end", async () => { note("msg", all.slice(-60).replace(/\n/g, " ")); emit(await answer(all)); });
}
