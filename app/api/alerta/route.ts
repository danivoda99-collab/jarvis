import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { addCerere, saveCerere } from "@/lib/cereri";
import { suna } from "@/lib/apel";
import { notify } from "@/lib/push";

// O alertă urgentă de la un agent (de exemplu Santinela WhatsApp): notificare care trece și de „Nu deranja” din Argus,
// un card în aplicație și, la „apel”, un telefon (dacă e configurat Twilio). Decizia cât de urgent e o ia laptopul.
export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { titlu?: string; text?: string; apel?: boolean; de_la?: string };
  const titlu = String(body.titlu ?? "").trim().slice(0, 120);
  const text = String(body.text ?? "").trim().slice(0, 1000);
  if (!titlu || !text) return NextResponse.json({ error: "Lipsește titlul sau textul." }, { status: 400 });
  const cerere = await addCerere(titlu, `Alertă urgentă${body.de_la ? ` de la ${String(body.de_la).slice(0, 60)}` : ""}`, undefined, "în lucru");
  await saveCerere({ ...cerere, status: "gata", rezultat: text, actualizat: new Date().toISOString() });
  await notify(`Urgent: ${titlu}`, text, cerere.id, true);
  const apel = body.apel ? await suna(`${titlu}. ${text}`) : undefined;
  return NextResponse.json({ ok: true, id: cerere.id, ...(apel ? { apel } : {}) });
}
