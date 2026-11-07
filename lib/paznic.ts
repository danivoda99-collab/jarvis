// Paznicul tehnic: verifică la câteva minute că Argus merge (laptopul, coada, Google, cheile) și îl anunță pe Daniel
// o singură dată când ceva pică, apoi când își revine. Noaptea (23–08) nu sună: notificarea așteaptă în aplicație.

import { awayText, command, laptopAway, listCereri } from "@/lib/cereri";
import { googleHealth } from "@/lib/google";
import { hold, notify } from "@/lib/push";

export type Problema = { cheie: string; titlu: string; text: string };

const STARE = "argus:paznic:stare";
const COADA_VAZUTA = "argus:paznic:coada";
// Cât de des repetă aceeași alertă dacă problema rămâne.
const REPETA_ORE = 6;
const LAPTOP_JOS_MIN = 20;
const NOUA_BLOCATA_MIN = 15;
const IN_LUCRU_BLOCATA_MIN = 90;

const minuteDe = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 60_000);

export function noapte(now = new Date()): boolean {
  const ora = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Europe/Bucharest" }).format(now));
  return ora >= 23 || ora < 8;
}

async function verificaLaptop(): Promise<{ probleme: Problema[]; laptopPornit: boolean }> {
  const away = await laptopAway();
  if (away !== null && away >= LAPTOP_JOS_MIN) {
    return {
      laptopPornit: false,
      probleme: [{ cheie: "laptop", titlu: "Laptopul Argus nu răspunde", text: `De ${awayText(away)}. Verifică dacă e pornit, la încărcat și pe internet.` }],
    };
  }
  return { laptopPornit: away === null, probleme: [] };
}

// Laptopul e pornit, dar nu preia cererile: puntea s-a blocat sau s-a atins limita Claude de pe laptop.
// Trebuie văzută la două verificări la rând: după o pană, laptopul abia pornit are nevoie de un minut să ia ce s-a strâns.
async function verificaCoada(laptopPornit: boolean): Promise<Problema[]> {
  const gasite = laptopPornit ? await cautaInCoada() : [];
  if (!gasite.length) {
    await command("DEL", COADA_VAZUTA);
    return [];
  }
  const dejaVazuta = await command<string | null>("GET", COADA_VAZUTA);
  await command("SET", COADA_VAZUTA, "1", "EX", 30 * 60);
  return dejaVazuta ? gasite : [];
}

async function cautaInCoada(): Promise<Problema[]> {
  const cereri = await listCereri();
  const noua = cereri.find((c) => c.status === "nouă" && minuteDe(c.creat) >= NOUA_BLOCATA_MIN);
  if (noua) {
    return [{ cheie: "coada", titlu: "Argus nu preia cererile", text: `„${noua.titlu}” așteaptă de ${awayText(minuteDe(noua.creat))}. Laptopul e pornit, dar puntea nu lucrează (blocată sau limita Claude atinsă).` }];
  }
  const blocata = cereri.find((c) => c.status === "în lucru" && minuteDe(c.actualizat) >= IN_LUCRU_BLOCATA_MIN);
  if (blocata) {
    return [{ cheie: "coada", titlu: "O cerere stă blocată", text: `„${blocata.titlu}” e în lucru de ${awayText(minuteDe(blocata.actualizat))} fără nicio schimbare.` }];
  }
  return [];
}

async function verificaGoogle(): Promise<Problema[]> {
  const stare = await googleHealth();
  if (stare === "expirat") {
    return [{ cheie: "google", titlu: "Conexiunea Google a expirat", text: "Calendarul, sarcinile și mailul nu merg. Deschide Argus și apasă „Conectează Google”." }];
  }
  return [];
}

// Cheia Claude: un apel minuscul (1 token) prinde și cheia greșită, și creditul terminat.
async function verificaClaude(): Promise<Problema[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return [{ cheie: "claude", titlu: "Lipsește cheia Claude", text: "ANTHROPIC_API_KEY nu e pusă în Vercel." }];
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.ARGUS_PAZNIC_MODEL || "claude-haiku-5-5", max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
      cache: "no-store",
    });
    if (response.ok) return [];
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      return [{ cheie: "claude", titlu: "Cheia Claude nu mai merge", text: "Creierul lui Argus nu răspunde: cheia ANTHROPIC_API_KEY din Vercel e respinsă." }];
    }
    if (/credit balance/i.test(text)) {
      return [{ cheie: "claude", titlu: "S-a terminat creditul Claude", text: "Creierul lui Argus nu mai răspunde până nu adaugi credit în consola Anthropic." }];
    }
    return [];
  } catch {
    return [];
  }
}

async function verificaOpenAI(): Promise<Problema[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return [];
  try {
    const response = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` }, cache: "no-store" });
    if (response.status === 401) {
      return [{ cheie: "openai", titlu: "Cheia OpenAI nu mai merge", text: "Argus nu mai aude și nu mai vorbește: cheia OPENAI_API_KEY din Vercel e respinsă." }];
    }
    return [];
  } catch {
    return [];
  }
}

type Stare = Record<string, { titlu: string; anuntat: string }>;

// Compară cu ce era jos data trecută: anunță problemele noi (și pe cele vechi la 6 ore), plus revenirile.
export async function ruleazaPaznic(now = new Date()) {
  const laptop = await verificaLaptop();
  const rezultate = await Promise.all([verificaCoada(laptop.laptopPornit), verificaGoogle(), verificaClaude(), verificaOpenAI()]);
  const probleme = [...laptop.probleme, ...rezultate.flat()];

  const veche = (JSON.parse((await command<string | null>("GET", STARE)) ?? "{}") as Stare) ?? {};
  const noua: Stare = {};
  const deAnuntat: { titlu: string; text: string }[] = [];
  for (const p of probleme) {
    const inainte = veche[p.cheie];
    const repeta = inainte && minuteDe(inainte.anuntat) >= REPETA_ORE * 60;
    if (!inainte || repeta) {
      deAnuntat.push({ titlu: p.titlu, text: p.text });
      noua[p.cheie] = { titlu: p.titlu, anuntat: now.toISOString() };
    } else {
      noua[p.cheie] = inainte;
    }
  }
  for (const [cheie, inainte] of Object.entries(veche)) {
    if (!noua[cheie]) deAnuntat.push({ titlu: "Rezolvat", text: `${inainte.titlu}: merge din nou.` });
  }
  await command("SET", STARE, JSON.stringify(noua));

  const liniste = noapte(now);
  for (const mesaj of deAnuntat) {
    if (liniste) await hold(mesaj.titlu, mesaj.text);
    else await notify(mesaj.titlu, mesaj.text, `paznic-${mesaj.titlu}`);
  }
  return { probleme: probleme.map((p) => p.cheie), anuntate: deAnuntat.length };
}
