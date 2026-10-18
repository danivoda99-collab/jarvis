// Ce poate apărea într-o fereastră pe lângă text: cifre mari, bare de progres, grafice, tabel, imagine.
// Același format vine de la Argus (unealta arata_vizual) și de la laptop (rândul „VIZUAL: {...}”).

export type Cifra = { eticheta: string; valoare: string; nota?: string };
export type Progres = { eticheta: string; valoare: number; maxim: number; unitate?: string };
export type Bara = { eticheta: string; valoare: number; valoare2?: number };
export type Bare = { titlu?: string; unitate?: string; legenda?: string[]; elemente: Bara[] };
export type Serie = { nume: string; valori: number[] };
export type Linie = { titlu?: string; unitate?: string; etichete: string[]; serii: Serie[] };
export type Nivel = "urgent" | "important" | "info";
export type Punct = { titlu: string; text?: string; nivel: Nivel };

export type Vizual = {
  puncte?: Punct[];
  cifre?: Cifra[];
  progres?: Progres[];
  bare?: Bare;
  linie?: Linie;
  tabel?: string[][];
  imagine?: string;
};

const text = (value: unknown, max = 60) => String(value ?? "").trim().slice(0, max);

function number(value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

const list = (value: unknown, max: number): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

// Curăță ce vine de la model: limite de mărime, numere valide, doar imagini https.
export function cleanVizual(input: unknown): Vizual | undefined {
  const raw = record(input);
  const result: Vizual = {};

  // Puncte una sub alta (o conversație, un mail, un om pe rând), cele urgente sus.
  const ORDINE: Nivel[] = ["urgent", "important", "info"];
  const puncte = list(raw.puncte, 8)
    .map(record)
    .map((item) => {
      const nivel = text(item.nivel, 12).toLowerCase() as Nivel;
      return { titlu: text(item.titlu, 40), text: text(item.text, 120) || undefined, nivel: ORDINE.includes(nivel) ? nivel : "info" };
    })
    .filter((item) => item.titlu)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => ORDINE.indexOf(a.item.nivel) - ORDINE.indexOf(b.item.nivel) || a.index - b.index)
    .map(({ item }) => item);
  if (puncte.length) result.puncte = puncte;

  const cifre = list(raw.cifre, 6)
    .map(record)
    .map((item) => ({ eticheta: text(item.eticheta, 40), valoare: text(item.valoare, 24), nota: text(item.nota, 60) || undefined }))
    .filter((item) => item.eticheta && item.valoare);
  if (cifre.length) result.cifre = cifre;

  const progres: Progres[] = [];
  for (const item of list(raw.progres, 12).map(record)) {
    const eticheta = text(item.eticheta, 40);
    const valoare = number(item.valoare);
    const maxim = number(item.maxim);
    if (eticheta && valoare !== null && maxim !== null && maxim > 0) {
      progres.push({ eticheta, valoare, maxim, unitate: text(item.unitate, 10) || undefined });
    }
  }
  if (progres.length) result.progres = progres;

  const bare = record(raw.bare);
  const elemente: Bara[] = [];
  for (const item of list(bare.elemente, 12).map(record)) {
    const eticheta = text(item.eticheta, 24);
    const valoare = number(item.valoare);
    if (eticheta && valoare !== null) elemente.push({ eticheta, valoare, valoare2: number(item.valoare2) ?? undefined });
  }
  if (elemente.length) {
    result.bare = {
      titlu: text(bare.titlu) || undefined,
      unitate: text(bare.unitate, 10) || undefined,
      legenda: list(bare.legenda, 2).map((item) => text(item, 24)).filter(Boolean),
      elemente,
    };
  }

  const linie = record(raw.linie);
  const etichete = list(linie.etichete, 24).map((item) => text(item, 12));
  const serii = list(linie.serii, 3)
    .map(record)
    .map((item) => ({
      nume: text(item.nume, 24),
      valori: list(item.valori, etichete.length).map((value) => number(value) ?? 0),
    }))
    .filter((item) => item.valori.length > 1);
  if (etichete.length > 1 && serii.length) {
    result.linie = { titlu: text(linie.titlu) || undefined, unitate: text(linie.unitate, 10) || undefined, etichete, serii };
  }

  const tabel = list(raw.tabel, 13)
    .filter(Array.isArray)
    .map((row) => (row as unknown[]).slice(0, 6).map((cell) => text(cell, 80)));
  if (tabel.length > 1) result.tabel = tabel;

  const imagine = text(raw.imagine, 500);
  if (/^https:\/\/\S+$/.test(imagine)) result.imagine = imagine;

  return Object.keys(result).length ? result : undefined;
}

// Situația bugetului (Categorie, Buget, Cheltuit, Rămas, %) ca bare de progres și cifre mari.
export function budgetVizual(table: string[][]): Vizual | undefined {
  const rows = table.slice(1);
  const parse = (value: string) => number(String(value ?? "").replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}\b)/g, ""));
  const total = rows.find((row) => row[0] === "Total");
  const progres = rows
    .filter((row) => row[0] !== "Total")
    .map((row) => ({ eticheta: row[0], valoare: parse(row[2]) ?? 0, maxim: parse(row[1]) ?? 0, unitate: "lei" }))
    .filter((item) => item.maxim > 0)
    .sort((a, b) => b.valoare / b.maxim - a.valoare / a.maxim);
  const cifre = total
    ? [
        { eticheta: "Cheltuit", valoare: `${total[2]} lei` },
        { eticheta: "Buget", valoare: `${total[1]} lei` },
        { eticheta: "Rămas", valoare: `${total[3]} lei` },
      ]
    : undefined;
  return cleanVizual({ cifre, progres });
}
