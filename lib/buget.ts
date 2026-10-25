import { google } from "@/lib/google";

// Sheet-ul „Buget personal” al lui Daniel.
export const SHEET = "https://sheets.googleapis.com/v4/spreadsheets/18aCKEXM5g2cSpyjZVp8lPwnunvMEwTdX4MJhK44OMW0";

// Situația lunii din tabul „Buget vs. cheltuit” (luna e în B1, implicit cea curentă).
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
  return { luna: month, tabel: [header, ...body] };
}

