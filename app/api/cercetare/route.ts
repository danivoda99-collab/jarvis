import { NextResponse, after } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { QueueError, addCerere } from "@/lib/cereri";
import { research } from "@/lib/cercetare";

// Cât poate dura o cercetare în fundal (căutări și pagini citite).
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "Lipsește cheia ANTHROPIC_API_KEY." }, { status: 500 });
  const body = (await request.json().catch(() => ({}))) as { titlu?: string; intrebare?: string };
  const question = (body.intrebare ?? "").trim().slice(0, 4000);
  if (!question) return NextResponse.json({ error: "Lipsește întrebarea." }, { status: 400 });
  try {
    // Apare în lista de cereri ca „în lucru”, ca laptopul să n-o ia și telefonul să verifice des.
    const cerere = await addCerere(`Cercetare: ${(body.titlu ?? question).slice(0, 80)}`, question, undefined, "în lucru");
    after(() => research(cerere.id, question));
    return NextResponse.json({ ok: true, id: cerere.id });
  } catch (caught) {
    const message = caught instanceof QueueError ? caught.message : "Coada nu răspunde.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
