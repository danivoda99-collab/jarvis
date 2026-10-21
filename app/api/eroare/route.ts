import { NextResponse, after } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { addCerere, command } from "@/lib/cereri";
import { once } from "@/lib/ajutor";

// Erorile pe care le vede Daniel în Argus (pe telefon sau pe laptop) ajung întâi la Argus de pe laptop, să le rezolve.
// Cele care țin de Daniel (microfonul, internetul lui) doar se notează.
const LOCAL = /microfon|internet|conexiun|failed to fetch|load failed|network/i;

const RULES = [
  "Ești Argus de pe laptop și ai primit o eroare apărută în aplicația Argus (jarvis-one-psi-36.vercel.app), văzută de Daniel.",
  "Află cauza din ce poți verifica singur: dacă Google, Spotify sau OpenAI răspund, coada de cereri, jurnalul tău (argus.log). Nu schimbi codul aplicației; dacă e nevoie de o schimbare de cod, o descrii scurt pentru Daniel.",
  "Rezultatul: dacă Daniel trebuie să facă ceva (o reconectare, o cheie, credit), îl începi cu „DANIEL:” și spui exact ce și unde; altfel scrii pe scurt cauza și ce ai făcut, pentru jurnal, fără să-l anunți.",
].join("\n");

export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { mesaj?: unknown; unde?: unknown; aparat?: unknown };
  const message = String(body.mesaj ?? "").trim().slice(0, 400);
  if (!message) return NextResponse.json({ error: "Lipsește eroarea." }, { status: 400 });
  const where = String(body.unde ?? "").trim().slice(0, 60) || "aplicație";
  const device = String(body.aparat ?? "").trim().slice(0, 120);
  after(async () => {
    try {
      const now = new Date().toISOString();
      await command("LPUSH", "argus:erori", JSON.stringify({ cand: now, unde: where, aparat: device, mesaj: message }));
      await command("LTRIM", "argus:erori", 0, 199);
      if (LOCAL.test(message)) return;
      if (!(await once(`argus-eroare:${where}:${message.slice(0, 80)}`, 2 * 60 * 60))) return;
      await addCerere(
        `Eroare în Argus: ${where}`,
        `${RULES}\n\nEroarea (${now}, ${where}${device ? `, ${device}` : ""}): ${message}`,
        undefined,
        undefined,
        true,
      );
    } catch (caught) {
      console.error("eroare", caught);
    }
  });
  return NextResponse.json({ ok: true });
}
