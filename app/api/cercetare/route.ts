import { NextResponse, after } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { QueueError, addCerere, awayText, laptopAway } from "@/lib/cereri";
import { laptopResearch, research } from "@/lib/cercetare";
import { apiPaused } from "@/lib/creier";

// Cât poate dura o cercetare în fundal (căutări și pagini citite).
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { titlu?: string; intrebare?: string };
  const question = (body.intrebare ?? "").trim().slice(0, 4000);
  if (!question) return NextResponse.json({ error: "Lipsește întrebarea." }, { status: 400 });
  try {
    // Când API-ul nu are credit, cercetarea o face Claude de pe laptop (abonamentul), ca o cerere obișnuită: caută, citește,
    // iar rezultatul vine în „Lucrări” cu notificare. Altfel o face serverul, pe API, ca înainte.
    const onLaptop = process.env.ARGUS_CREIER === "laptop" || !process.env.ANTHROPIC_API_KEY || Boolean(await apiPaused());
    const away = onLaptop ? await laptopAway() : 0;
    if (onLaptop && away === null) {
      const cerere = await addCerere(
        `Cercetare: ${(body.titlu ?? question).slice(0, 80)}`,
        laptopResearch(question),
      );
      return NextResponse.json({ ok: true, id: cerere.id, laptop: true });
    }
    if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: `API-ul nu are cheie, iar laptopul nu răspunde de ${awayText(away ?? 0)}.` }, { status: 503 });
    // Apare în lista de cereri ca „în lucru”, ca laptopul să n-o ia și telefonul să verifice des.
    const cerere = await addCerere(`Cercetare: ${(body.titlu ?? question).slice(0, 80)}`, question, undefined, "în lucru");
    after(() => research(cerere.id, question));
    return NextResponse.json({ ok: true, id: cerere.id });
  } catch (caught) {
    const message = caught instanceof QueueError ? caught.message : "Coada nu răspunde.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
