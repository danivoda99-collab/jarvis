// Ce face din agenți o echipă: personalitatea fiecăruia, tabla pe care își lasă note unul altuia
// și nota săptămânii (câte ture a făcut din câte trebuia, erorile, câte propuneri i-a aprobat Daniel).
// Fără date de clienți: notele sunt scurte, tăiate la 200 de caractere, iar laptopul le scrie fără nume de clienți.

import { command } from "@/lib/cereri";

export const IDURI = ["paznic", "suport", "secretar", "manager", "evenimente", "whatsapp", "imbunatatire", "trader"] as const;
export type IdEchipa = (typeof IDURI)[number];
export const eAgent = (id: unknown): id is IdEchipa => typeof id === "string" && (IDURI as readonly string[]).includes(id);

// Personalitatea: un fel de a fi, o vorbă a lui și forma de pe orbită (folosită de ecranul „Echipa”).
export const PERSONALITATI: Record<IdEchipa, { fire: string; motto: string; forma: string }> = {
  paznic: { fire: "Veteranul calm care nu doarme", motto: "Totul e în ordine. Te anunț dacă se mișcă ceva.", forma: "scut" },
  suport: { fire: "Mecanicul răbdător", motto: "Am găsit unde scârțâie. Reparația e gata, aștept să zici tu.", forma: "cheie" },
  secretar: { fire: "Ordonat până la manie, cu umor sec", motto: "Trei termene săptămâna asta. Unul e mâine, nu te speria.", forma: "carte" },
  manager: { fire: "Antrenorul care știe pe toată lumea pe nume", motto: "Merită un telefon azi. Oamenii simt când îi vezi.", forma: "steag" },
  whatsapp: { fire: "Ochii de pe turn: tăcută până contează", motto: "Nimic urgent. Ți-am lăsat chaturile necitite.", forma: "ochi" },
  evenimente: { fire: "Energicul echipei", motto: "Postarea de vineri e gata și arată bine. Dăm drumul?", forma: "scanteie" },
  imbunatatire: { fire: "Perfecționistul care ține minte tot", motto: "Ai cerut asta de 4 ori. Hai s-o facem automat.", forma: "spirala" },
  trader: { fire: "Jucătorul rece care nu pariază pe speranță", motto: "Pe hârtie deocamdată. Cifrele vorbesc, nu eu.", forma: "moneda" },
};

// ——— Tabla echipei: notele dintre agenți ———
export type Nota = { id: string; de: IdEchipa; pentru: IdEchipa | "toti"; text: string; t: string; citita?: boolean };
const TABLA = "argus:echipa:tabla";
const TABLA_MAX = 60;

export async function lasaNota(de: unknown, pentru: unknown, text: unknown): Promise<Nota | null> {
  if (!eAgent(de) || !(eAgent(pentru) || pentru === "toti") || de === pentru) return null;
  const curat = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!curat) return null;
  const nota: Nota = { id: crypto.randomUUID(), de, pentru: pentru as Nota["pentru"], text: curat, t: new Date().toISOString() };
  await command("LPUSH", TABLA, JSON.stringify(nota));
  await command("LTRIM", TABLA, 0, TABLA_MAX - 1);
  return nota;
}

export async function citesteTabla(): Promise<Nota[]> {
  const brut = await command<string[]>("LRANGE", TABLA, 0, TABLA_MAX - 1).catch(() => [] as string[]);
  return (brut ?? []).flatMap((x) => {
    try {
      return [JSON.parse(x) as Nota];
    } catch {
      return [];
    }
  });
}

// Notele necitite pentru un agent; cu `marcheaza`, le trece ca citite (laptopul le citește înainte de tură).
export async function notePentru(id: IdEchipa, marcheaza: boolean): Promise<Nota[]> {
  const toate = await citesteTabla();
  const ale = toate.filter((n) => (n.pentru === id || (n.pentru === "toti" && n.de !== id)) && !n.citita);
  if (marcheaza && ale.length) {
    const ids = new Set(ale.filter((n) => n.pentru === id).map((n) => n.id));
    const noi = toate.map((n) => (ids.has(n.id) ? { ...n, citita: true } : n));
    await command("DEL", TABLA);
    if (noi.length) await command("RPUSH", TABLA, ...noi.map((n) => JSON.stringify(n)));
  }
  return ale;
}

// ——— Nota săptămânii ———
// Când ar trebui să lucreze fiecare (ora României). Cei porniți la cerere sau neporniți încă n-au „ture așteptate”.
const ORAR: Partial<Record<IdEchipa, { ore: number[]; zile: "toate" | "lucru" }>> = {
  secretar: { ore: [9, 13, 18], zile: "toate" },
  manager: { ore: [9], zile: "lucru" },
};

function partiRo(d: Date) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Bucharest", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short", hour12: false }).formatToParts(d);
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  return { an: Number(g("year")), luna: Number(g("month")), zi: Number(g("day")), ora: Number(g("hour")) % 24, ziSapt: g("weekday") };
}

// Săptămâna (luni–duminică) în care cade o dată, ca „2026-11-09” = lunea ei.
function lunea(d: Date) {
  const { an, luna, zi, ziSapt } = partiRo(d);
  const index = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(ziSapt);
  const l = new Date(Date.UTC(an, luna - 1, zi - index));
  return l.toISOString().slice(0, 10);
}
const cheieScor = (luni: string) => `argus:echipa:scor:${luni}`;

export async function numara(id: unknown, camp: "ture" | "erori" | "aprobate" | "refuzate") {
  if (!eAgent(id)) return;
  const k = cheieScor(lunea(new Date()));
  await command("HINCRBY", k, `${id}:${camp}`, 1);
  await command("EXPIRE", k, 60 * 60 * 24 * 40);
}

// Câte ture trebuia să facă de luni până acum (o tură contează după ce i-a trecut ora de start + 1).
function asteptate(id: IdEchipa, luni: string, pana: Date) {
  const o = ORAR[id];
  if (!o) return 0;
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const zi = new Date(`${luni}T12:00:00Z`);
    zi.setUTCDate(zi.getUTCDate() + i);
    const ziua = zi.getUTCDay();
    if (o.zile === "lucru" && (ziua === 0 || ziua === 6)) continue;
    const data = zi.toISOString().slice(0, 10);
    const azi = partiRo(pana);
    const dataAzi = `${azi.an}-${String(azi.luna).padStart(2, "0")}-${String(azi.zi).padStart(2, "0")}`;
    if (data > dataAzi) break;
    n += o.ore.filter((h) => data < dataAzi || azi.ora >= h + 1).length;
  }
  return n;
}

export type Scor = { nota: number | null; ture: number; asteptate: number; erori: number; aprobate: number; refuzate: number; inUrma: boolean; istoric: (number | null)[] };

function calculeaza(c: { ture: number; asteptate: number; erori: number; aprobate: number; refuzate: number }): number | null {
  if (!c.ture && !c.asteptate && !c.erori && !c.aprobate && !c.refuzate) return null;
  const punct = c.asteptate ? Math.min(1, c.ture / c.asteptate) : 1;
  const fiab = c.ture + c.erori ? c.ture / (c.ture + c.erori) : 1;
  const util = c.aprobate + c.refuzate ? c.aprobate / (c.aprobate + c.refuzate) : 0.75;
  return Math.round(10 * (0.6 * punct + 0.2 * fiab + 0.2 * util) * 10) / 10;
}

async function citesteSaptamana(luni: string) {
  const brut = await command<string[] | Record<string, string> | null>("HGETALL", cheieScor(luni)).catch(() => null);
  const m: Record<string, number> = {};
  if (Array.isArray(brut)) for (let i = 0; i < brut.length; i += 2) m[brut[i]] = Number(brut[i + 1]) || 0;
  else if (brut) for (const [k, v] of Object.entries(brut)) m[k] = Number(v) || 0;
  return m;
}

// Nota fiecăruia pe săptămâna asta, plus ultimele 3 săptămâni întregi (ca să se vadă cine rămâne în urmă).
export async function scoruri(): Promise<Record<IdEchipa, Scor>> {
  const acum = new Date();
  const luni = lunea(acum);
  const trecute = [1, 2, 3].map((k) => {
    const d = new Date(`${luni}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 7 * k);
    return d.toISOString().slice(0, 10);
  });
  const [curenta, ...vechi] = await Promise.all([luni, ...trecute].map(citesteSaptamana));
  const out = {} as Record<IdEchipa, Scor>;
  for (const id of IDURI) {
    const c = (m: Record<string, number>, luniS: string, pana: Date) => ({
      ture: m[`${id}:ture`] ?? 0,
      erori: m[`${id}:erori`] ?? 0,
      aprobate: m[`${id}:aprobate`] ?? 0,
      refuzate: m[`${id}:refuzate`] ?? 0,
      asteptate: asteptate(id, luniS, pana),
    });
    const acumC = c(curenta, luni, acum);
    const istoric = vechi.map((m, i) => {
      const sfarsit = new Date(`${trecute[i]}T12:00:00Z`);
      sfarsit.setUTCDate(sfarsit.getUTCDate() + 6);
      sfarsit.setUTCHours(21, 59);
      return calculeaza(c(m, trecute[i], sfarsit));
    });
    out[id] = { ...acumC, nota: calculeaza(acumC), istoric, inUrma: istoric.every((n) => n !== null && n < 6) };
  }
  return out;
}
