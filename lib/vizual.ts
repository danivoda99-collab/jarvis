// Ce poate apărea într-o fereastră pe lângă text: cifre mari, bare de progres, grafice, tabel, imagine.
// Același format vine de la Argus (unealta arata_vizual) și de la laptop (rândul „VIZUAL: {...}”).

export type Cifra = { eticheta: string; valoare: string; nota?: string };
export type Progres = { eticheta: string; valoare: number; maxim: number; unitate?: string };
export type Bara = { eticheta: string; valoare: number; valoare2?: number };
export type Bare = { titlu?: string; unitate?: string; legenda?: string[]; elemente: Bara[] };
export type Serie = { nume: string; valori: number[] };
export type Linie = { titlu?: string; unitate?: string; etichete: string[]; serii: Serie[] };
export type Nivel = "urgent" | "important" | "info";
// Un punct poate avea un mesaj gata scris (de exemplu pentru un om din echipă), trimis pe WhatsApp după „Da”.
export type Mesaj = { catre: string; text: string };
// Sau o sarcină din Google Tasks (id-ul ei), cu „Gata” și „Mâine” sub ea.
export type Punct = { titlu: string; text?: string; nivel: Nivel; mesaj?: Mesaj; sarcina?: string };

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
      const draft = record(item.mesaj);
      const mesaj = text(draft.catre, 60) && text(draft.text, 600) ? { catre: text(draft.catre, 60), text: text(draft.text, 600) } : undefined;
      const sarcina = text(item.sarcina, 120) || undefined;
      return { titlu: text(item.titlu, 40), text: text(item.text, 120) || undefined, nivel: ORDINE.includes(nivel) ? nivel : "info", mesaj, sarcina };
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
  for (const item of list(raw.progres, 30).map(record)) {
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

// O sumă scrisă de Sheet în orice format: „1,100.00” (en_GB, cum e Sheet-ul bugetului), „1.100,00”, „1100”, „-25,5 lei”.
// Separatorul zecimal e ultimul dintre „.” și „,” când apar amândouă; unul singur urmat de grupuri de exact 3 cifre e de mii.
export function amount(value: unknown): number | null {
  const raw = String(value ?? "").replace(/[^\d,.-]/g, "");
  if (!raw) return null;
  const lastDot = raw.lastIndexOf(".");
  const lastComma = raw.lastIndexOf(",");
  let clean: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    clean = raw.split(thousands).join("").replace(decimal, ".");
  } else {
    const sep = lastDot >= 0 ? "." : lastComma >= 0 ? "," : "";
    clean = sep && new RegExp(`^-?\\d{1,3}(\\${sep}\\d{3})+$`).test(raw) ? raw.split(sep).join("") : raw.replace(",", ".");
  }
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : null;
}

// Situația bugetului (Categorie, Buget, Cheltuit, Rămas, %): cifre mari și bare pentru toate categoriile cu buget.
// Cu venitul lunii: bani rămași (venit − cheltuit), cât mai e de plătit din buget și cât rămâne liber după plăți.
// „Rămas” din Total e doar buget − cheltuit și scade și depășirile, deci nu sunt bani.
export function budgetMoney(table: string[][], venit?: string) {
  const rows = table.slice(1);
  const total = rows.find((row) => row[0] === "Total");
  const left = rows.filter((row) => row[0] !== "Total").map((row) => amount(row[3]) ?? 0);
  const toPay = left.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const over = -left.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  const spent = amount(total?.[2]) ?? 0;
  const income = venit ? amount(venit) : null;
  const money = income === null ? null : income - spent;
  return { spent, budget: amount(total?.[1]) ?? 0, toPay, over, income, money, free: money === null ? null : money - toPay };
}

export function budgetVizual(table: string[][], venit?: string): Vizual | undefined {
  const rows = table.slice(1);
  const progres = rows
    .filter((row) => row[0] !== "Total")
    .map((row) => ({ eticheta: row[0], valoare: amount(row[2]) ?? 0, maxim: amount(row[1]) ?? 0, unitate: "lei" }))
    .filter((item) => item.maxim > 0)
    .sort((a, b) => b.valoare / b.maxim - a.valoare / a.maxim);
  const lei = (value: number) => `${Math.round(value).toLocaleString("ro-RO")} lei`;
  const m = budgetMoney(table, venit);
  const hasTotal = rows.some((row) => row[0] === "Total");
  const cifre = !hasTotal
    ? undefined
    : m.income !== null && m.money !== null && m.free !== null
      ? [
          { eticheta: "Venit", valoare: lei(m.income) },
          { eticheta: "Cheltuit", valoare: lei(m.spent) },
          { eticheta: "Bani rămași", valoare: lei(m.money), nota: "venit − cheltuit" },
          { eticheta: "De plătit din buget", valoare: lei(m.toPay) },
          { eticheta: "Liber după plăți", valoare: lei(m.free) },
          ...(m.over ? [{ eticheta: "Peste buget", valoare: lei(m.over) }] : []),
        ]
      : [
          { eticheta: "Cheltuit", valoare: lei(m.spent) },
          { eticheta: "Buget", valoare: lei(m.budget) },
          { eticheta: "De plătit din buget", valoare: lei(m.toPay) },
          ...(m.over ? [{ eticheta: "Peste buget", valoare: lei(m.over) }] : []),
        ];
  return cleanVizual({ cifre, progres });
}

// Cheltuielile din categoriile fără buget nu au bară: le arătăm într-un tabel sub bare.
export function unbudgeted(table: string[][]): string[][] | undefined {
  const rows = table
    .slice(1)
    .filter((row) => row[0] !== "Total" && !(amount(row[1]) ?? 0) && (amount(row[2]) ?? 0) > 0)
    .map((row) => [row[0], `${row[2]} lei`]);
  return rows.length ? [["Fără buget", "Cheltuit"], ...rows] : undefined;
}

// Rezerva pentru un rezultat de pe laptop venit fără VIZUAL (punte veche sau model neatent): liniile „- Nume: ce vrea”
// devin puncte una sub alta, iar textul rămâne doar cu propozițiile din afara listei.
const URGENT = /\burgent|\bazi\b|\bacum\b|imediat|până la|deadline/i;
const IMPORTANT = /răspun|întreab|te sun|sună|vrea|cere|confirm|aștepți|necitit/i;

export function pointsFromText(text: string): { text: string; vizual: Vizual } | undefined {
  const lines = text.split("\n");
  const items = lines
    .map((line) => line.trim().match(/^(?:[-•*]|\d+[.)])\s+(.+)$/)?.[1])
    .filter((item): item is string => Boolean(item));
  if (items.length < 2) return undefined;
  const puncte = items.map((item) => {
    const plain = item.replace(/\*\*(.+?)\*\*/g, "$1").trim();
    const split = plain.match(/^(.{1,40}?)\s*(?::|—|–|\s-\s)\s*(.+)$/);
    const nivel = URGENT.test(plain) ? "urgent" : IMPORTANT.test(plain) ? "important" : "info";
    return split ? { titlu: split[1], text: split[2], nivel } : { titlu: plain.slice(0, 40), text: plain.length > 40 ? plain : undefined, nivel };
  });
  const vizual = cleanVizual({ puncte });
  if (!vizual) return undefined;
  const rest = lines
    .filter((line) => !/^\s*(?:[-•*]|\d+[.)])\s+/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: rest, vizual };
}
