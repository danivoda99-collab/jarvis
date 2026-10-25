import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { awayText, command, laptopAway } from "@/lib/cereri";
import { hold } from "@/lib/push";
import { addFapt, listFapte, listJurnal } from "@/lib/memorie";

// Noaptea, Argus își recitește jurnalul și își notează ce a învățat despre Daniel (Vercel Cron, o dată pe zi).
// Doar adaugă fapte noi; nu șterge nimic. Rulează cel mult o dată la 20 de ore, oricine ar chema adresa.

export const maxDuration = 120;
const MODEL = process.env.ARGUS_MODEL || "claude-sonnet-5-5";
const LOCK = "argus:noapte";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Neautorizat." }, { status: 401 });
  }
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "Lipsește cheia." }, { status: 500 });
  try {
    if (!(await command<string | null>("SET", LOCK, new Date().toISOString(), "NX", "EX", 20 * 60 * 60))) {
      return NextResponse.json({ ok: true, sarit: "a rulat deja azi" });
    }
    // Laptopul oprit de peste o oră: Daniel află când deschide Argus dimineață, fără o notificare la 4 noaptea.
    const away = await laptopAway();
    if (away !== null && away >= 60) {
      await hold("Laptopul Argus e oprit", `Nu mai răspunde de ${awayText(away)}. Verifică dacă e la încărcat și pornit.`).catch(() => undefined);
    }
    const [jurnal, fapte] = await Promise.all([listJurnal(120), listFapte()]);
    if (!jurnal.length) return NextResponse.json({ ok: true, noi: 0 });
    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: `Ești memoria lui Argus, asistentul vocal al lui Daniel. Citești jurnalul cererilor lui și extragi fapte DURABILE care îl vor ajuta pe Argus pe viitor: preferințe (cum îi place să i se scrie, canale), oameni și cine sunt (doar echipă, familie, prieteni), nume scrise corect, obiceiuri, reguli date de Daniel.
Nu notezi: lucruri de o zi, cifre care se schimbă, parole, coduri, numere de card, date despre clienții OVB, nimic deja în lista existentă (nici reformulat).
Răspunzi DOAR cu un JSON: {"fapte": ["propoziție scurtă în română", ...]}, cel mult 8. Dacă nu e nimic nou, {"fapte": []}.`,
      messages: [
        {
          role: "user",
          content: `Fapte existente:\n${fapte.map((fapt) => `- ${fapt}`).join("\n") || "(niciunul)"}\n\nJurnal (cele mai noi primele):\n${jurnal
            .map((item) => `[${item.data}] (${item.sursa}) ${item.cerere.slice(0, 400)} → ${item.rezultat.slice(0, 400)}`)
            .join("\n")}`,
        },
      ],
    });
    const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    const match = text.match(/\{[\s\S]*\}/);
    const found = match ? ((JSON.parse(match[0]) as { fapte?: unknown }).fapte ?? []) : [];
    const noi = (Array.isArray(found) ? found : [])
      .filter((item): item is string => typeof item === "string" && item.trim().length > 3)
      .map((item) => item.trim().slice(0, 300))
      .filter((item) => !fapte.includes(item))
      .slice(0, 8);
    // Cele mai vechi primele, ca ordinea din listă să rămână „cel mai nou sus”.
    for (const fapt of noi.reverse()) await addFapt(fapt);
    return NextResponse.json({ ok: true, noi: noi.length });
  } catch {
    // Încercarea eșuată nu blochează următoarea rulare.
    await command("DEL", LOCK).catch(() => undefined);
    return NextResponse.json({ error: "Nu am putut reciti jurnalul." }, { status: 502 });
  }
}
