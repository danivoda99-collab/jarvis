import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { GoogleError } from "@/lib/google";
import { cauta, dateSeminar, fara, mesajLink } from "@/lib/seminar";

// Pentru Santinela de pe laptop (doar citire din Sheet-ul de prezențe):
// GET ?nume=<numele din WhatsApp>&prenume=<prenume> → seminarul omului și textul exact de trimis;
// GET ?lista=1 → oamenii din modulul curent cu BL Voda (Santinela le poate deschide conversațiile 1:1).
export async function GET(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const params = new URL(request.url).searchParams;
  try {
    const date = await dateSeminar();
    if (params.has("lista")) {
      const nume = [...new Set(date.oameni.filter((om) => fara(om.bl) === "voda").map((om) => om.nume))];
      return NextResponse.json({ modul: date.modul, nume }, { headers: { "Cache-Control": "no-store" } });
    }
    const cine = String(params.get("nume") ?? "").trim().slice(0, 80);
    const prenume = String(params.get("prenume") ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!cine) return NextResponse.json({ error: "Lipsește numele." }, { status: 400 });
    const gasit = cauta(date, cine);
    if (!gasit.ok) return NextResponse.json(gasit, { headers: { "Cache-Control": "no-store" } });
    // Prenumele din salut trebuie să fie chiar un cuvânt din numele omului (sau din numele lui din WhatsApp).
    const cuvinte = new Set([...fara(gasit.nume).split(" "), ...fara(cine).split(" ")]);
    const salut = prenume && fara(prenume).split(" ").every((w) => cuvinte.has(w)) ? prenume : "";
    if (!salut) return NextResponse.json({ ok: false, motiv: `nu știu sigur prenumele lui ${gasit.nume}`, modul: gasit.modul }, { headers: { "Cache-Control": "no-store" } });
    return NextResponse.json({ ...gasit, prenume: salut, text: mesajLink(salut, gasit) }, { headers: { "Cache-Control": "no-store" } });
  } catch (caught) {
    const message = caught instanceof GoogleError ? caught.message : `Nu am putut citi Sheet-ul de prezențe: ${(caught as Error).message}`;
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
