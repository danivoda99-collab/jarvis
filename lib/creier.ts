import Anthropic from "@anthropic-ai/sdk";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { QueueError, command, queueReady } from "@/lib/cereri";
import { parseSse, visiblePart, type Bloc } from "@/lib/creier-format";

// Creierul lui Argus pe abonamentul de pe laptop: telefonul întreabă aici, cererea pleacă la Claude Code de pe laptop
// (prin Upstash, pe un canal ascultat de punte), iar răspunsul vine înapoi pe bucăți. API-ul plătit rămâne doar rezervă.
// Laptopul ascultă canalul direct la Upstash (fără să țină o funcție Vercel deschisă), deci preia cererea pe loc.

export const CANAL = "argus:creier:cereri";
const JOB = (id: string) => `argus:creier:cerere:${id}`;
const REPLY = (id: string) => `argus:creier:r:${id}`;
// Pusă de laptop când s-a terminat limita abonamentului: cât există, cererile merg direct pe rezervă.
const PAUZA = "argus:creier:pauza";
const STARE = "argus:creier:stare";
// O bucată de cerere (pozele pot fi mari; Upstash are limită pe mărimea unei comenzi).
const PART = 400_000;

export type Motiv = "coada" | "oprit" | "lent" | "limita" | "logat" | "eroare" | "intrerupt";

export class LaptopError extends Error {
  constructor(
    public motiv: Motiv,
    message: string,
    // A apucat să trimită text spre telefon: nu mai putem trece curat pe rezervă.
    public started = false,
  ) {
    super(message);
  }
}

// De ce n-a răspuns laptopul, spus omenește (apare doar dacă nici rezerva nu merge).
export function motivText(error: LaptopError): string {
  switch (error.motiv) {
    case "oprit":
      return "Laptopul nu răspunde (oprit, adormit sau fără internet).";
    case "lent":
      return "Laptopul n-a răspuns la timp.";
    case "limita":
      return error.message || "S-a terminat limita abonamentului Claude de pe laptop.";
    case "logat":
      return "Claude de pe laptop nu mai e logat.";
    case "coada":
      return "Legătura cu laptopul (coada) nu merge.";
    case "intrerupt":
      return "Răspunsul laptopului s-a întrerupt.";
    default:
      return error.message || "Claude de pe laptop a dat eroare.";
  }
}

export type Intrebare = {
  // Instrucțiunile fixe (aceleași la fiecare cerere, ca procesul de pe laptop să rămână treaz cu ele).
  sistem: string;
  // Ce se schimbă: conversația, memoria, pozele.
  continut: Bloc[];
  // „mare” = modelul cel mai bun (cererile lui Daniel); „mic” = modelul rapid (pagina de ajutor).
  nivel?: "mare" | "mic";
  // Are voie să caute pe internet.
  web?: boolean;
};

type Limits = { ackMs?: number; idleMs?: number; totalMs?: number; onDelta?: (text: string) => void };

function rest() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

// Ce primește puntea ca să asculte canalul: întâi o cheie restrânsă doar la canalul creierului; dacă baza de date
// nu știe de chei restrânse, cheia obișnuită (laptopul are oricum acces la toată coada prin aplicație).
export async function laptopAccess(full = false): Promise<{ url: string; token: string; canal: string; fel: "restrans" | "complet" } | null> {
  const config = rest();
  if (!config) return null;
  if (!full) {
    try {
      const secret = process.env.SESSION_SECRET;
      if (!secret) throw new Error("fără secret");
      const pass = createHmac("sha256", secret).update("argus:creier:acl").digest("hex");
      await command("ACL", "SETUSER", "creier", "reset", "on", `>${pass}`, "~argus:creier:*", "&argus:creier:*", "+get", "+set", "+del", "+publish", "+subscribe", "+ping");
      const token = await command<string>("ACL", "RESTTOKEN", "creier", pass);
      if (typeof token === "string" && token.length > 20) return { url: config.url, token, canal: CANAL, fel: "restrans" };
    } catch {
      // mai jos, cheia obișnuită
    }
  }
  return { url: config.url, token: config.token, canal: CANAL, fel: "complet" };
}

export async function noteSource(sursa: "api" | "laptop" | "rezerva" | "nimic", motiv?: string) {
  await command("SET", STARE, JSON.stringify({ sursa, motiv, cand: new Date().toISOString() }), "EX", 60 * 60 * 24 * 14).catch(() => undefined);
}

export async function brainState() {
  const [stare, pauza] = await Promise.all([command<string | null>("GET", STARE).catch(() => null), command<string | null>("GET", PAUZA).catch(() => null)]);
  return { stare: stare ? (JSON.parse(stare) as { sursa: string; motiv?: string; cand: string }) : null, pauza };
}

type Event = { t: "a" } | { t: "p" } | { t: "x"; n: number; d: string } | { t: "end"; text: string } | { t: "err"; motiv?: Motiv; text?: string };

// Ascultă canalul de răspuns (SSE la Upstash) și dă evenimentele pe rând; `next` se oprește singur după `ms`.
async function listen(channel: string, signal: AbortSignal) {
  const config = rest();
  if (!config) throw new LaptopError("coada", "");
  const open = (method: "POST" | "GET") =>
    fetch(`${config.url}/subscribe/${encodeURIComponent(channel)}`, {
      method,
      headers: { Authorization: `Bearer ${config.token}`, Accept: "text/event-stream" },
      cache: "no-store",
      signal,
    });
  let response = await open("POST");
  if (!response.ok || !response.body) response = await open("GET");
  if (!response.ok || !response.body) throw new LaptopError("coada", `canalul a răspuns ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const queue: { kind: string; payload: string }[] = [];
  let reading: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  // Următorul rând din flux sau null dacă trec `ms` fără nimic (citirea începută rămâne în așteptare pentru data viitoare).
  const next = async (ms: number): Promise<{ kind: string; payload: string } | null> => {
    const until = Date.now() + ms;
    for (;;) {
      const ready = queue.shift();
      if (ready) return ready;
      const left = until - Date.now();
      if (left <= 0) return null;
      reading ??= reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([reading, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), left)))]);
      clearTimeout(timer);
      if (chunk === null) return null;
      reading = null;
      if (chunk.done) throw new LaptopError("coada", "canalul s-a închis");
      pending += decoder.decode(chunk.value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseSse(line);
        if (parsed) queue.push(parsed);
      }
    }
  };
  return { next };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Întreabă laptopul și întoarce textul brut al răspunsului. Aruncă LaptopError când laptopul nu poate răspunde;
// cine cheamă decide dacă trece pe rezervă.
export async function askLaptop(intrebare: Intrebare, limits: Limits = {}): Promise<string> {
  const { ackMs = 5_000, idleMs = 25_000, totalMs = 100_000, onDelta } = limits;
  if (!queueReady()) throw new LaptopError("coada", "");
  const started = Date.now();
  const id = randomUUID();
  const abort = new AbortController();
  let sent = 0;
  try {
    const pauza = await command<string | null>("GET", PAUZA);
    if (pauza) throw new LaptopError("limita", pauza === "1" ? "" : pauza);
    const channel = await listen(REPLY(id), abort.signal);
    // Abonarea e confirmată de un prim rând; dacă nu vine, mergem oricum mai departe după o clipă.
    await channel.next(1_500).then((first) => {
      if (first && first.kind === "message") throw new LaptopError("coada", "rând neașteptat pe canal");
    });
    const body = JSON.stringify({ id, creat: started, nivel: intrebare.nivel ?? "mare", web: intrebare.web !== false, sistem: intrebare.sistem, continut: intrebare.continut });
    const parts = Math.ceil(body.length / PART);
    for (let part = 0; part < parts; part += 1) {
      await command("SET", `${JOB(id)}:${part}`, body.slice(part * PART, (part + 1) * PART), "EX", 300);
    }
    // Câți ascultă canalul: zero înseamnă că puntea de pe laptop nu e conectată acum (mai încercăm puțin: se poate reconecta).
    let heard = 0;
    for (let tries = 0; tries < 8 && heard === 0; tries += 1) {
      if (tries) await sleep(500);
      heard = await command<number>("PUBLISH", CANAL, JSON.stringify({ id, parti: parts }));
    }
    if (!heard) throw new LaptopError("oprit", "");

    let raw = "";
    let gap = false;
    let acked = false;
    let last = Date.now();
    for (;;) {
      const now = Date.now();
      if (now - started > totalMs) throw new LaptopError("lent", "", sent > 0);
      const wait = acked ? idleMs - (now - last) : ackMs - (now - last);
      const line = wait > 0 ? await channel.next(Math.min(wait, totalMs - (now - started) + 50)) : null;
      if (!line) {
        if (Date.now() - last >= (acked ? idleMs : ackMs)) throw new LaptopError(acked ? "lent" : "oprit", "", sent > 0);
        continue;
      }
      if (line.kind !== "message") continue;
      let event: Event;
      try {
        event = JSON.parse(line.payload) as Event;
      } catch {
        continue;
      }
      last = Date.now();
      acked = true;
      if (event.t === "x" && typeof event.d === "string") {
        // O bucată pierdută pe drum: nu mai dăm text pe sărite, așteptăm răspunsul întreg de la final.
        if (gap || event.n !== raw.length) {
          gap = true;
          continue;
        }
        raw += event.d;
        const visible = visiblePart(raw);
        if (onDelta && visible.length > sent) {
          onDelta(visible.slice(sent));
          sent = visible.length;
        }
      } else if (event.t === "end") {
        const text = typeof event.text === "string" ? event.text : raw;
        if (!text.trim()) throw new LaptopError("eroare", "Claude de pe laptop a răspuns gol.", sent > 0);
        // Dacă ce s-a spus deja nu e începutul răspunsului final, telefonul ar repeta sau ar sări: mai bine eroare clară.
        if (sent > 0 && !visiblePart(text).startsWith(visiblePart(raw).slice(0, sent))) throw new LaptopError("intrerupt", "", true);
        return text;
      } else if (event.t === "err") {
        throw new LaptopError(event.motiv ?? "eroare", String(event.text ?? "").slice(0, 300), sent > 0);
      }
    }
  } catch (caught) {
    if (caught instanceof LaptopError) throw caught;
    if (caught instanceof QueueError) throw new LaptopError("coada", caught.message, sent > 0);
    throw new LaptopError("coada", caught instanceof Error ? caught.message : "", sent > 0);
  } finally {
    abort.abort();
  }
}

export function toolId() {
  return `toolu_lap_${randomBytes(12).toString("hex")}`;
}

export function creditGone(caught: unknown) {
  return caught instanceof Anthropic.APIError && /credit balance|credits|billing|access is turned off|usage limits/i.test(String(caught.message ?? "") + JSON.stringify(caught.error ?? ""));
}

// API-ul fără credit sau cu cheia respinsă: 10 minute mergem direct pe laptop, apoi îl încercăm iar (poate s-a adăugat credit).
const API_PAUSE = "argus:creier:api-oprit";
export async function apiPaused() {
  return command<string | null>("GET", API_PAUSE).catch(() => null);
}
export async function rememberApiFailure(caught: unknown) {
  if (creditGone(caught) || caught instanceof Anthropic.AuthenticationError || caught instanceof Anthropic.PermissionDeniedError) {
    await command("SET", API_PAUSE, new Date().toISOString(), "EX", 600).catch(() => undefined);
  }
}
