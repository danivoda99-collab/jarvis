import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { cheieBuna, salveazaAgenti, stareEchipa } from "@/lib/echipa";

// Starea echipei: o citește widgetul de pe iPhone (cu ?cheie=, fără sesiune) sau aplicația; o scrie doar laptopul.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const cheie = new URL(request.url).searchParams.get("cheie");
  if (!(await isAuthenticated()) && !(await cheieBuna(cheie))) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  try {
    return NextResponse.json(await stareEchipa(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Coada nu răspunde." }, { status: 502 });
  }
}

export async function PUT(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  try {
    await salveazaAgenti(await request.json().catch(() => ({})));
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Coada nu răspunde." }, { status: 502 });
  }
}
