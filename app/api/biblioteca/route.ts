import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { GoogleError } from "@/lib/google";
import { SECTIUNI, TABURI, citeste, noteaza, tabul } from "@/lib/biblioteca";

// Biblioteca know-how pentru Argus de pe telefon: GET ?tab= citește rândurile active, POST { tab, sectiune, text } adaugă un rând.

function failure(caught: unknown) {
  const message = caught instanceof GoogleError ? caught.message : "Nu am putut ajunge la biblioteca know-how.";
  return NextResponse.json({ error: message }, { status: 502 });
}

export async function GET(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const cerut = new URL(request.url).searchParams.get("tab");
  const tab = tabul(cerut);
  if (!tab) return NextResponse.json({ error: `Tab necunoscut. Taburile: ${TABURI.join(", ")}.` }, { status: 400 });
  try {
    const randuri = await citeste(tab);
    return NextResponse.json({ tab, randuri: randuri.slice(0, 120) }, { headers: { "Cache-Control": "no-store" } });
  } catch (caught) {
    return failure(caught);
  }
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { tab?: string; sectiune?: string; text?: string };
  const tab = tabul(body.tab);
  if (!tab || tab === "Cuprins") return NextResponse.json({ error: `Alege un tab de domeniu: ${TABURI.filter((t) => t !== "Cuprins").join(", ")}.` }, { status: 400 });
  const sectiune = SECTIUNI.find((s) => s.toLowerCase() === String(body.sectiune ?? "").trim().toLowerCase()) ?? "Fapt";
  const text = String(body.text ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!text) return NextResponse.json({ error: "Lipsește textul." }, { status: 400 });
  try {
    await noteaza(tab, sectiune, text);
    return NextResponse.json({ ok: true, tab, sectiune });
  } catch (caught) {
    return failure(caught);
  }
}
