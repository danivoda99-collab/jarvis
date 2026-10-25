import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { GoogleError, google, todayInBucharest } from "@/lib/google";
import { SHEET, situation } from "@/lib/buget";

// Scriem doar coloanele A:D din Cheltuieli; coloana E (Luna) e o formulă ARRAYFORMULA și nu trebuie atinsă.

function failure(caught: unknown) {
  const message = caught instanceof GoogleError ? caught.message : "Nu am putut ajunge la Sheet-ul de buget.";
  return NextResponse.json({ error: message }, { status: 502 });
}

async function categories(): Promise<string[]> {
  const data = await google<{ values?: string[][] }>(`${SHEET}/values/${encodeURIComponent("Categorii!A2:A26")}`);
  return (data.values ?? []).map((row) => row[0]?.trim()).filter(Boolean);
}

// Categoriile permise, din tabul Categorii; cu ?situatie=1, situația lunii.
export async function GET(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  try {
    if (new URL(request.url).searchParams.has("situatie")) return NextResponse.json(await situation());
    return NextResponse.json({ categorii: await categories() });
  } catch (caught) {
    return failure(caught);
  }
}

// Adaugă o cheltuială pe primul rând liber. Aplicația cere confirmarea lui Daniel înainte.
export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as {
    suma?: number | string;
    categorie?: string;
    nota?: string;
    data?: string;
  };
  const amount = Number(String(body.suma ?? "").replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "Suma nu e validă." }, { status: 400 });
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.data ?? "") ? body.data! : todayInBucharest();
  const [year, month, day] = date.split("-").map(Number);

  try {
    const allowed = await categories();
    const category = allowed.find((item) => item.toLowerCase() === (body.categorie ?? "").trim().toLowerCase());
    if (!category) {
      return NextResponse.json({ error: `Categoria nu există. Variante: ${allowed.join(", ")}.` }, { status: 400 });
    }
    const filled = await google<{ values?: string[][] }>(`${SHEET}/values/${encodeURIComponent("Cheltuieli!A:A")}`);
    const row = (filled.values?.length ?? 1) + 1;
    const range = encodeURIComponent(`Cheltuieli!A${row}:D${row}`);
    await google(`${SHEET}/values/${range}?valueInputOption=USER_ENTERED`, {
      method: "PUT",
      body: JSON.stringify({
        values: [[`=DATE(${year},${month},${day})`, amount, category, (body.nota ?? "").trim()]],
      }),
    });
    return NextResponse.json({ ok: true });
  } catch (caught) {
    return failure(caught);
  }
}
