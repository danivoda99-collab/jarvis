import { NextResponse } from "next/server";
import { QueueError } from "@/lib/cereri";
import { allowed, answer, tellDaniel, type Replica } from "@/lib/ajutor";

// Pagina de ajutor e publică (o folosesc oamenii din echipă), deci fiecare adresă are o limită pe oră.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    intrebare?: string;
    istoric?: Replica[];
    nume?: string;
    anunta?: boolean;
  };
  const question = String(body.intrebare ?? "").trim().slice(0, 1500);
  const name = String(body.nume ?? "").trim().slice(0, 60);
  if (!question) return NextResponse.json({ error: "Scrie întrebarea." }, { status: 400 });
  const ip = (request.headers.get("x-forwarded-for") ?? "necunoscut").split(",")[0].trim();
  try {
    if (body.anunta) {
      if (!(await allowed(`anunta:${ip}`, 5))) return NextResponse.json({ error: "Ai trimis deja câteva întrebări. Daniel revine la tine." }, { status: 429 });
      const who = name || "cineva din echipă";
      await tellDaniel(`Întrebare de la ${who}`, `${who} nu s-a descurcat în Team Vodă: „${question}”`, "Pagina de ajutor Team Vodă");
      return NextResponse.json({ ok: true, raspuns: "Am trimis întrebarea lui Daniel. Îți răspunde el cât poate de repede." });
    }
    if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "Ajutorul nu e pornit încă." }, { status: 500 });
    if (!(await allowed(ip, 30))) return NextResponse.json({ error: "Prea multe întrebări într-o oră. Încearcă puțin mai târziu." }, { status: 429 });
    const history = Array.isArray(body.istoric) ? body.istoric.filter((item) => item && typeof item.text === "string") : [];
    return NextResponse.json({ ok: true, raspuns: await answer(question, history) });
  } catch (caught) {
    const message = caught instanceof QueueError ? "Ajutorul nu răspunde acum." : "N-am putut răspunde acum. Încearcă din nou.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
