// Citirea Sheet-ului de prezențe pentru linkul de seminar; regulile (fără rețea, testate) sunt în seminar-reguli.ts.
import { command } from "@/lib/cereri";
import { google } from "@/lib/google";
import { linkuriDinTab, oameniDinTab, tabulCurent, type Date_ } from "@/lib/seminar-reguli";

export { cauta, fara, mesajLink } from "@/lib/seminar-reguli";
export const PREZENTE_ID = "1mZzN0nBoXZgciE_nvsR_IDBW4v18s4blLbgXgp15i00";
const SHEET = `https://sheets.googleapis.com/v4/spreadsheets/${PREZENTE_ID}`;
const CACHE = "argus:seminar:date";

// Citirea din Sheet, cu cache de 10 minute (linkurile „schimbate temporar” ajung în cel mult 10 minute).
export async function dateSeminar(): Promise<Date_> {
  const cached = await command<string | null>("GET", CACHE).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached) as Date_;
    } catch {
      // citim din nou
    }
  }
  const meta = await google<{ sheets?: { properties?: { title?: string } }[] }>(`${SHEET}?fields=sheets.properties.title`);
  const titluri = (meta.sheets ?? []).map((s) => s.properties?.title ?? "").filter(Boolean);
  const modul = tabulCurent(titluri);
  if (!modul) throw new Error("Nu găsesc niciun tab datat în Sheet-ul de prezențe.");
  const [tab, ids] = await Promise.all([
    google<{ values?: string[][] }>(`${SHEET}/values/${encodeURIComponent(`'${modul}'!A1:H1500`)}`),
    google<{ values?: string[][] }>(`${SHEET}/values/${encodeURIComponent("'ID-uri Referenti'!A1:G60")}`),
  ]);
  const date = { modul, oameni: oameniDinTab(tab.values ?? []), linkuri: linkuriDinTab(ids.values ?? []) };
  await command("SET", CACHE, JSON.stringify(date), "EX", 600).catch(() => undefined);
  return date;
}

