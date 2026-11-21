import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { citesteTabla, eAgent, lasaNota, notePentru } from "@/lib/echipa-viata";

// Tabla echipei: agenții de pe laptop își lasă note unul altuia (și Daniel le vede în ecranul „Echipa”).
// GET ?pentru=<agent>&citeste=1: notele necitite pentru acel agent, trecute apoi ca citite. Fără „pentru”: ultimele note.
export const dynamic = "force-dynamic";

const nu = () => NextResponse.json({ error: "Neautentificat." }, { status: 401 });

export async function GET(request: Request) {
  if (!(await isAuthenticated())) return nu();
  const params = new URL(request.url).searchParams;
  const pentru = params.get("pentru");
  try {
    if (pentru) {
      if (!eAgent(pentru)) return NextResponse.json({ error: "Agent necunoscut." }, { status: 400 });
      return NextResponse.json({ note: await notePentru(pentru, params.get("citeste") === "1") });
    }
    return NextResponse.json({ note: (await citesteTabla()).slice(0, 30) });
  } catch {
    return NextResponse.json({ error: "Coada nu răspunde." }, { status: 502 });
  }
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) return nu();
  const body = (await request.json().catch(() => ({}))) as { de?: string; pentru?: string; text?: string };
  try {
    const nota = await lasaNota(body.de, body.pentru, body.text);
    if (!nota) return NextResponse.json({ error: "Nota nu e bună (de, pentru, text)." }, { status: 400 });
    return NextResponse.json({ ok: true, id: nota.id });
  } catch {
    return NextResponse.json({ error: "Coada nu răspunde." }, { status: 502 });
  }
}
