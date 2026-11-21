// Starea echipei de agenți, pe scurt: cine lucrează, la ce, câte lucruri așteaptă Da-ul lui Daniel și dacă laptopul merge.
// O folosesc widgetul de pe iPhone (cu o cheie a lui, fără sesiune) și ecranul „Echipa”. Fără date de clienți: doar
// numele agenților, câteva cuvinte despre ce fac și cifre. Laptopul trimite ce face fiecare agent după fiecare tură.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { command, laptopAway, listCereri } from "@/lib/cereri";
import { PERSONALITATI, citesteTabla, numara, scoruri } from "@/lib/echipa-viata";

export const AGENTI = [
  { id: "paznic", nume: "Paznicul" },
  { id: "suport", nume: "Suportul Voda" },
  { id: "secretar", nume: "Secretarul" },
  { id: "manager", nume: "Managerul" },
  { id: "evenimente", nume: "Evenimente" },
  { id: "whatsapp", nume: "Santinela WhatsApp" },
  { id: "imbunatatire", nume: "Îmbunătățirea" },
  { id: "trader", nume: "Traderul" },
] as const;

export type IdAgent = (typeof AGENTI)[number]["id"];
export type StareAgent = "lucreaza" | "asteapta" | "ok" | "liber" | "pauza" | "cazut";
export type Agent = { id: IdAgent; nume: string; stare: StareAgent; face: string; ultima?: string };

const AGENTI_KEY = "argus:echipa:agenti";
const CHEIE_KEY = "argus:echipa:cheie";
const PAZNIC_KEY = "argus:paznic:stare";
const STARI: StareAgent[] = ["lucreaza", "asteapta", "ok", "liber", "pauza", "cazut"];

// Ce trimite laptopul: { secretar: { stare, face, ultima }, … }. Textul se taie scurt, ca să nu ajungă nimic lung pe ecran.
export async function salveazaAgenti(body: unknown) {
  const vechi = await citesteAgenti();
  const intrare = (body && typeof body === "object" ? body : {}) as Record<string, { stare?: string; face?: string; ultima?: string; tura?: string }>;
  for (const { id } of AGENTI) {
    const nou = intrare[id];
    if (!nou) continue;
    // Sfârșitul unei ture intră în nota săptămânii: „ok” = a făcut-o, „eroare” = n-a mers.
    if (nou.tura === "ok") await numara(id, "ture").catch(() => undefined);
    if (nou.tura === "eroare") await numara(id, "erori").catch(() => undefined);
    vechi[id] = {
      stare: STARI.includes(nou.stare as StareAgent) ? (nou.stare as StareAgent) : "liber",
      face: String(nou.face ?? "").replace(/\s+/g, " ").slice(0, 60),
      ultima: nou.ultima && !Number.isNaN(Date.parse(nou.ultima)) ? new Date(nou.ultima).toISOString() : new Date().toISOString(),
    };
  }
  await command("SET", AGENTI_KEY, JSON.stringify(vechi));
}

async function citesteAgenti(): Promise<Record<string, { stare: StareAgent; face: string; ultima?: string }>> {
  try {
    return JSON.parse((await command<string | null>("GET", AGENTI_KEY)) ?? "{}");
  } catch {
    return {};
  }
}

export async function stareEchipa() {
  const [salvati, cereri, away, paznicBrut, paznicUltima, tabla, scor] = await Promise.all([
    citesteAgenti(),
    listCereri(),
    laptopAway(),
    command<string | null>("GET", PAZNIC_KEY),
    command<string | null>("GET", "argus:paznic:ultima").catch(() => null),
    citesteTabla().catch(() => []),
    scoruri().catch(() => null),
  ]);
  // Laptopul e jos de cel puțin 20 de minute: agenții de pe el sunt în pauză (nu mint că lucrează).
  const laptopCazut = away !== null && away >= 20;
  let probleme: { titlu: string }[] = [];
  try {
    probleme = Object.values(JSON.parse(paznicBrut ?? "{}") as Record<string, { titlu: string }>);
  } catch {
    probleme = [];
  }
  const decizii = cereri.filter((c) => c.status === "așteaptă confirmare");
  const agenti: Agent[] = AGENTI.map(({ id, nume }) => {
    const s = salvati[id];
    if (id === "paznic") {
      if (probleme.length) return { id, nume, stare: "cazut", face: probleme[0].titlu.slice(0, 60), ultima: new Date().toISOString() };
      // Fără nicio tură în ultima jumătate de oră, paznicul e oprit (cron-job.org nu-l mai cheamă).
      const viu = paznicUltima && Date.now() - Date.parse(paznicUltima) < 30 * 60_000;
      return { id, nume, stare: viu ? "ok" : "liber", face: viu ? "Totul merge" : "Oprit", ultima: paznicUltima ?? s?.ultima };
    }
    if (laptopCazut) return { id, nume, stare: "pauza", face: "În pauză până revine laptopul", ultima: s?.ultima };
    return { id, nume, stare: s?.stare ?? "liber", face: s?.face || "Liber", ultima: s?.ultima };
  });
  return {
    acum: new Date().toISOString(),
    laptop: laptopCazut ? { cazut: true, minute: away } : { cazut: false },
    probleme: probleme.map((p) => p.titlu.slice(0, 80)),
    deDecis: decizii.length,
    // Doar titlurile scurte, pentru widgetul mic; textul exact rămâne în aplicație.
    decizii: decizii.slice(0, 3).map((c) => (c.confirmare?.titlu || c.titlu).slice(0, 60)),
    agenti: agenti.map((a) => ({ ...a, ...PERSONALITATI[a.id], scor: scor?.[a.id] ?? null })),
    // Ultimele note dintre agenți (fără date de clienți), pentru ecranul „Echipa”.
    tabla: tabla.slice(0, 12).map(({ de, pentru, text, t }) => ({ de, pentru, text, t })),
  };
}

// Cheia widgetului: se face singură prima dată, iar „Schimbă cheia” o înlocuiește (widgetul vechi nu mai vede nimic).
export async function cheieWidget(noua = false): Promise<string> {
  if (!noua) {
    const existenta = await command<string | null>("GET", CHEIE_KEY);
    if (existenta) return existenta;
  }
  const cheie = randomBytes(24).toString("base64url");
  await command("SET", CHEIE_KEY, cheie);
  return cheie;
}

export async function cheieBuna(candidat: string | null): Promise<boolean> {
  if (!candidat) return false;
  const cheie = await command<string | null>("GET", CHEIE_KEY);
  if (!cheie) return false;
  const a = Buffer.from(candidat);
  const b = Buffer.from(cheie);
  return a.length === b.length && timingSafeEqual(a, b);
}
