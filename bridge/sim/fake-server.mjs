// Server Argus de probă: /api/cereri, /api/memorie, /api/urmariri, în memorie; scrie fiecare schimbare.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const cereri = [{ id: "c0", titlu: "rămasă de ieri", cerere: "x", status: "în lucru", creat: "2026-10-16T20:00:00Z", actualizat: "2026-10-16T20:00:00Z" },
  { id: "c00", titlu: "Cercetare: zboruri", cerere: "x", status: "în lucru", creat: "2026-10-16T20:00:00Z" }];
let downUntil = 0;
let semnal = 0;
const t0 = Date.now();
const note = (...p) => appendFileSync(process.env.SRV_LOG, [((Date.now() - t0) / 1000).toFixed(1), ...p].join(" | ") + "\n");
createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const data = body ? JSON.parse(body) : {};
  const url = new URL(req.url, "http://x");
  const send = (obj, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (url.pathname === "/sim/add") {
    const item = { id: "c" + (cereri.length + 1), titlu: data.titlu, cerere: data.cerere, status: data.status ?? "nouă", creat: new Date().toISOString(), confirmare: data.confirmare };
    cereri.unshift(item); semnal++; note("ADD", item.id, item.status, item.titlu); return send(item);
  }
  if (url.pathname === "/sim/down") { downUntil = Date.now() + Number(url.searchParams.get("ms")); note("DOWN"); return send({}); }
  if (Date.now() < downUntil && url.pathname.startsWith("/api")) return send({ error: "down" }, 503);
  if (url.pathname === "/sim/state") return send({ cereri });
  if (url.pathname === "/api/cereri") {
    if (req.method === "GET") return url.searchParams.get("semnal") ? send({ semnal }) : send({ cereri: cereri.filter((c) => ["nouă", "confirmată", "în lucru", "așteaptă confirmare"].includes(c.status)) });
    if (req.method === "PATCH") {
      const item = cereri.find((c) => c.id === data.id);
      Object.assign(item, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)), { actualizat: new Date().toISOString() });
      semnal++; note("PATCH", item.id, data.status, JSON.stringify(data.rezultat ?? "").slice(0, 90), data.vizual ? "VIZ=" + JSON.stringify(data.vizual) : "");
      return send({ ok: true });
    }
    if (req.method === "POST") { note("POST cereri", data.titlu, JSON.stringify(data.rezultat ?? "").slice(0, 120), data.vizual ? "VIZ=" + JSON.stringify(data.vizual) : ""); return send({ ok: true }); }
  }
  if (url.pathname === "/api/memorie") return send({ fapte: [] });
  if (url.pathname === "/api/urmariri") return send({ urmariri: [] });
  send({ error: "nu" }, 404);
}).listen(4999, () => note("server pornit"));
