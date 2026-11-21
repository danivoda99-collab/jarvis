// Biblioteca know-how: Google Sheet-ul „Argus – know-how (bibliotecă)”, comun tuturor proiectelor lui Daniel.
// Coloane: A Data (zz.ll.aaaa) | B Sursa | C Secțiune (Regulă/Fapt/Decizie/În lucru) | D Text | E Stare (activ/înlocuit/gata; la Cereri: nou/preluat/făcut).
// Rândurile doar se adaugă; nu se șterg și nu se rescriu din aplicație.

import { command } from "@/lib/cereri";
import { google, todayInBucharest } from "@/lib/google";

export const BIBLIOTECA_ID = "1Hbi6L7x9ZtphYZZ8yVm7cd6qx6yKVSws8Q0AIyrkne4";
const SHEET = `https://sheets.googleapis.com/v4/spreadsheets/${BIBLIOTECA_ID}`;
export const TABURI = [
  "Cuprins", "Echipa Voda", "Buget și investiții", "Recrutare", "Aplicația Team Vodă",
  "PM-uri și prezentări", "Personal", "Argus", "Cereri către Argus",
] as const;
export const SECTIUNI = ["Regulă", "Fapt", "Decizie", "În lucru"] as const;
const CACHE = (tab: string) => `argus:biblioteca:${tab}`;

const fara = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
// Tabul exact, chiar dacă vine fără diacritice sau scris altfel („buget” → „Buget și investiții”).
export function tabul(dorit: unknown): string | null {
  const t = fara(String(dorit ?? ""));
  if (!t) return null;
  return TABURI.find((x) => fara(x) === t) ?? TABURI.find((x) => fara(x).includes(t) || t.includes(fara(x))) ?? null;
}

// Rândurile active (sau „nou” la cereri) dintr-un tab, compact: „Secțiune: Text (data, sursa)”. Cache 10 minute.
export async function citeste(tab: string): Promise<string[]> {
  const cached = await command<string | null>("GET", CACHE(tab)).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached) as string[];
    } catch {
      // cache stricat: citim din nou
    }
  }
  const data = await google<{ values?: string[][] }>(`${SHEET}/values/${encodeURIComponent(`'${tab}'!A2:E500`)}`);
  const randuri = (data.values ?? [])
    .filter((r) => r[3]?.trim() && ["activ", "nou", ""].includes(fara(r[4] ?? "")))
    .map((r) => `${r[2]?.trim() || "Fapt"}: ${r[3].trim()} (${r[0]?.trim() || "?"}, ${r[1]?.trim() || "?"})`);
  await command("SET", CACHE(tab), JSON.stringify(randuri), "EX", 600).catch(() => undefined);
  return randuri;
}

export async function noteaza(tab: string, sectiune: string, text: string) {
  const [an, luna, zi] = todayInBucharest().split("-");
  await google(`${SHEET}/values/${encodeURIComponent(`'${tab}'!A:E`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values: [[`${zi}.${luna}.${an}`, "Argus", sectiune, text, "activ"]] }),
  });
  await command("DEL", CACHE(tab)).catch(() => undefined);
}
