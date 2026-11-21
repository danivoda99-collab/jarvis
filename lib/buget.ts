import { google } from "@/lib/google";

// Sheet-ul „Buget personal” al lui Daniel.
export const SHEET = "https://sheets.googleapis.com/v4/spreadsheets/18aCKEXM5g2cSpyjZVp8lPwnunvMEwTdX4MJhK44OMW0";

// Luna de buget merge de pe 15 pe 14: „10.2026” înseamnă 15.10.2026–14.11.2026.
// Sheet-ul face calculul (Cheltuieli!E și „Buget vs. cheltuit”!B1 folosesc EOMONTH(data-14,-1)+1); aici doar scriem perioada.
export function cyclePeriod(month: string): string | undefined {
  const match = /^(\d{1,2})\.(\d{4})$/.exec(month.trim());
  if (!match) return undefined;
  const m = Number(match[1]);
  const y = Number(match[2]);
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const pad = (n: number) => String(n).padStart(2, "0");
  return nextY === y ? `15.${pad(m)}–14.${pad(nextM)}.${y}` : `15.${pad(m)}.${y}–14.${pad(nextM)}.${nextY}`;
}

// Situația lunii de buget din tabul „Buget vs. cheltuit” (luna e în B1, implicit cea în curs).
export async function situation() {
  const data = await google<{ values?: string[][] }>(
    `${SHEET}/values/${encodeURIComponent("'Buget vs. cheltuit'!A1:E40")}`,
  );
  const rows = data.values ?? [];
  const month = rows[0]?.[1] ?? "";
  const header = ["Categorie", "Buget", "Cheltuit", "Rămas", "%"];
  const body = rows
    .slice(3)
    .filter((row) => row[0] && (row[0] === "Total" || row[1] !== "0" || row[2] !== "0"))
    .map((row) => [row[0], row[1] ?? "", row[2] ?? "", row[3] ?? "", row[4] ?? ""]);
  // Venitul lunii, din fila „Lunar” (rândurile 9–20, luna în A, venitul în B).
  const lunar = await google<{ values?: string[][] }>(`${SHEET}/values/${encodeURIComponent("Lunar!A9:B20")}`).catch(() => null);
  const venit = lunar?.values?.find((row) => row[0]?.trim() === month.trim())?.[1]?.trim() || undefined;
  return { luna: month, perioada: cyclePeriod(month), tabel: [header, ...body], venit };
}

