import { command } from "@/lib/cereri";

// „Anunță-mă când…”: lucruri pe care laptopul le verifică singur, din când în când, până se întâmplă.
// Când condiția e îndeplinită, laptopul pune rezultatul în coadă și telefonul primește notificare.

export type Urmarire = {
  id: string;
  ce: string; // ce urmărim, în cuvintele lui Daniel
  conditie: string; // când îl anunțăm
  stare: "activă" | "îndeplinită" | "oprită" | "expirată";
  intervalMin: number;
  pana: string; // ISO, după care nu mai verificăm
  creat: string;
  verificat?: string;
  ultimul?: string; // ce a găsit la ultima verificare
};

const KEY = "argus:urmariri";
export const MAX_ACTIVE = 5;

export async function listUrmariri(): Promise<Urmarire[]> {
  const value = await command<string | null>("GET", KEY);
  const all = value ? (JSON.parse(value) as Urmarire[]) : [];
  const now = new Date().toISOString();
  return all.map((item) => (item.stare === "activă" && item.pana < now ? { ...item, stare: "expirată" as const } : item));
}

async function save(all: Urmarire[]) {
  // Păstrăm cele active și ultimele 20 terminate.
  const active = all.filter((item) => item.stare === "activă");
  const done = all.filter((item) => item.stare !== "activă").slice(-20);
  await command("SET", KEY, JSON.stringify([...done, ...active]));
}

export async function addUrmarire(ce: string, conditie: string, intervalMin: number, zile: number) {
  const all = await listUrmariri();
  if (all.filter((item) => item.stare === "activă").length >= MAX_ACTIVE) {
    throw new Error(`Sunt deja ${MAX_ACTIVE} urmăriri active; oprește una întâi.`);
  }
  const now = new Date();
  const item: Urmarire = {
    id: crypto.randomUUID().slice(0, 8),
    ce,
    conditie,
    stare: "activă",
    intervalMin: Math.min(24 * 60, Math.max(30, intervalMin)),
    pana: new Date(now.getTime() + Math.min(30, Math.max(1, zile)) * 86_400_000).toISOString(),
    creat: now.toISOString(),
  };
  await save([...all, item]);
  return item;
}

export async function updateUrmarire(id: string, change: Partial<Pick<Urmarire, "stare" | "verificat" | "ultimul">>) {
  const all = await listUrmariri();
  const item = all.find((entry) => entry.id === id);
  if (!item) return null;
  Object.assign(item, change);
  await save(all);
  return item;
}
