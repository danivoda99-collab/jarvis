import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { addUrmarire, listUrmariri, updateUrmarire, type Urmarire } from "@/lib/urmariri";

// Urmăririle: telefonul le adaugă și le oprește, laptopul le verifică și raportează.

async function guard() {
  return (await isAuthenticated()) ? null : NextResponse.json({ error: "Neautentificat." }, { status: 401 });
}

function failure(caught: unknown) {
  return NextResponse.json({ error: caught instanceof Error ? caught.message : "Urmăririle nu răspund." }, { status: 502 });
}

export async function GET() {
  const denied = await guard();
  if (denied) return denied;
  try {
    return NextResponse.json({ urmariri: await listUrmariri() }, { headers: { "Cache-Control": "no-store" } });
  } catch (caught) {
    return failure(caught);
  }
}

export async function POST(request: Request) {
  const denied = await guard();
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { ce?: string; conditie?: string; interval_ore?: number; zile?: number };
  const ce = (body.ce ?? "").trim().slice(0, 500);
  const conditie = (body.conditie ?? "").trim().slice(0, 500);
  if (!ce || !conditie) return NextResponse.json({ error: "Lipsește ce urmăresc sau când te anunț." }, { status: 400 });
  try {
    const item = await addUrmarire(ce, conditie, Math.round((Number(body.interval_ore) || 2) * 60), Number(body.zile) || 7);
    return NextResponse.json({ ok: true, id: item.id, pana: item.pana });
  } catch (caught) {
    return failure(caught);
  }
}

const STATES: Urmarire["stare"][] = ["activă", "îndeplinită", "oprită"];

export async function PATCH(request: Request) {
  const denied = await guard();
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { id?: string; stare?: Urmarire["stare"]; ultimul?: string };
  if (!body.id) return NextResponse.json({ error: "Lipsește urmărirea." }, { status: 400 });
  if (body.stare && !STATES.includes(body.stare)) return NextResponse.json({ error: "Stare necunoscută." }, { status: 400 });
  try {
    const item = await updateUrmarire(body.id, {
      stare: body.stare,
      ultimul: body.ultimul?.slice(0, 500),
      verificat: new Date().toISOString(),
    });
    return item ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Nu găsesc urmărirea." }, { status: 404 });
  } catch (caught) {
    return failure(caught);
  }
}
