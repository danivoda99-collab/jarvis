import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { quietUntil, setQuiet, takeHeld } from "@/lib/push";

// „Nu mă deranja o oră”: notificările obișnuite așteaptă; alertele urgente din echipă trec oricum.

export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  try {
    const until = await quietUntil();
    // Ce s-a strâns se dă doar după ce liniștea s-a terminat.
    const held = until ? [] : await takeHeld();
    return NextResponse.json({ pana: until, amanate: held }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Nu pot citi starea." }, { status: 502 });
  }
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { minute?: unknown };
  const minutes = Math.round(Number(body.minute));
  if (!Number.isFinite(minutes) || minutes < 0) return NextResponse.json({ error: "Spune câte minute." }, { status: 400 });
  try {
    const until = await setQuiet(Math.min(minutes, 12 * 60));
    if (until) return NextResponse.json({ ok: true, pana: until });
    // Liniștea s-a oprit: ce s-a strâns între timp se spune acum.
    return NextResponse.json({ ok: true, pana: null, amanate: await takeHeld() });
  } catch {
    return NextResponse.json({ error: "Nu pot schimba starea." }, { status: 502 });
  }
}
