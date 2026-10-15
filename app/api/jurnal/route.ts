import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { QueueError } from "@/lib/cereri";
import { google } from "@/lib/google";
import { addIntrare, listJurnal, type Intrare } from "@/lib/memorie";

// Jurnalul cererilor lui Daniel: în Redis pentru Argus și laptop, copiat și în Sheet-ul „Argus – jurnal”,
// ca să-l poată citi și Claude din proiect când Daniel cere un rezumat.
const SHEET = "https://sheets.googleapis.com/v4/spreadsheets/18WGac5_Fr5UQCwwroFWH3GQn5M2tmQvva8O3ptEumT0";

async function guard() {
  return (await isAuthenticated()) ? null : NextResponse.json({ error: "Neautentificat." }, { status: 401 });
}

export async function GET() {
  const denied = await guard();
  if (denied) return denied;
  try {
    return NextResponse.json({ jurnal: await listJurnal() }, { headers: { "Cache-Control": "no-store" } });
  } catch (caught) {
    const message = caught instanceof QueueError ? caught.message : "Jurnalul nu răspunde.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const denied = await guard();
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as Partial<Intrare>;
  const cerere = (body.cerere ?? "").trim().slice(0, 2000);
  if (!cerere) return NextResponse.json({ error: "Lipsește cererea." }, { status: 400 });
  const intrare: Intrare = {
    data: new Date().toLocaleString("sv-SE", { timeZone: "Europe/Bucharest" }).slice(0, 16),
    sursa: (body.sursa ?? "Telefon").slice(0, 40),
    cerere,
    rezultat: (body.rezultat ?? "").trim().slice(0, 2000),
  };
  let saved = false;
  try {
    await addIntrare(intrare);
    saved = true;
  } catch {
    // rămâne măcar în Sheet
  }
  let sheet = false;
  try {
    await google(`${SHEET}/values/${encodeURIComponent("Jurnal!A:D")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: "POST",
      body: JSON.stringify({ values: [[intrare.data, intrare.sursa, intrare.cerere, intrare.rezultat]] }),
    });
    sheet = true;
  } catch {
    // fără Google conectat, jurnalul rămâne doar în Redis
  }
  return NextResponse.json({ ok: saved || sheet });
}
