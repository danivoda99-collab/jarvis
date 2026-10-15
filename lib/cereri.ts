// Coada de cereri dintre Argus și Claude de pe laptop, ținută în Upstash Redis (Vercel → Storage).
// Argus pune cererea, laptopul o preia, o face și scrie rezultatul înapoi.

export type Status = "nouă" | "în lucru" | "așteaptă confirmare" | "confirmată" | "refuzată" | "gata" | "eroare";

export type Cerere = {
  id: string;
  titlu: string;
  cerere: string;
  status: Status;
  creat: string;
  actualizat: string;
  rezultat?: string;
  // Ce vrea Claude să facă și are nevoie de „Da” (un mail, un mesaj): textul exact și destinatarul.
  confirmare?: { titlu: string; text: string; destinatar?: string; tabel?: string[][] };
  sesiune?: string;
};

const LIST = "argus:cereri";
const KEEP = 50;

function redis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

export function queueReady() {
  return redis() !== null;
}

export class QueueError extends Error {}

async function command<T>(...args: (string | number)[]): Promise<T> {
  const config = redis();
  if (!config) throw new QueueError("Coada nu e pornită: în Vercel → Storage trebuie conectat Upstash Redis.");
  const response = await fetch(config.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  const data = (await response.json().catch(() => ({}))) as { result?: T; error?: string };
  if (!response.ok || data.error) throw new QueueError("Coada nu răspunde. Mai încearcă.");
  return data.result as T;
}

const key = (id: string) => `argus:cerere:${id}`;

export async function listCereri(): Promise<Cerere[]> {
  const ids = await command<string[]>("LRANGE", LIST, 0, KEEP - 1);
  if (!ids.length) return [];
  const values = await command<(string | null)[]>("MGET", ...ids.map(key));
  return values.filter((value): value is string => Boolean(value)).map((value) => JSON.parse(value) as Cerere);
}

export async function getCerere(id: string): Promise<Cerere | null> {
  const value = await command<string | null>("GET", key(id));
  return value ? (JSON.parse(value) as Cerere) : null;
}

export async function saveCerere(cerere: Cerere) {
  // 30 de zile e destul ca istoric; coada nu crește la nesfârșit.
  await command("SET", key(cerere.id), JSON.stringify(cerere), "EX", 60 * 60 * 24 * 30);
}

export async function addCerere(titlu: string, text: string): Promise<Cerere> {
  const now = new Date().toISOString();
  const cerere: Cerere = { id: crypto.randomUUID(), titlu, cerere: text, status: "nouă", creat: now, actualizat: now };
  await saveCerere(cerere);
  await command("LPUSH", LIST, cerere.id);
  await command("LTRIM", LIST, 0, KEEP - 1);
  return cerere;
}
