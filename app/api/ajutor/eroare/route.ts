import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { command } from "@/lib/cereri";
import { once, tellDaniel } from "@/lib/ajutor";

// Aplicația Team Vodă trimite aici erorile oamenilor (aceleași rânduri ca în tabul „_Erori”), cu cheia AJUTOR_SECRET.
// O pierdere izolată de conexiune doar se notează; mai mulți oameni blocați sau o eroare reală ajung la Daniel.
const NETWORK = /network|http 0|http -1|failed to fetch|timeout|conexiun/i;
const WINDOW_MS = 30 * 60_000;

function sameSecret(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const expected = process.env.AJUTOR_SECRET;
  if (!expected) return NextResponse.json({ ok: false, error: "AJUTOR_SECRET lipsește." }, { status: 500 });
  const body = (await request.json().catch(() => ({}))) as { secret?: string; cine?: string; ecran?: string; eroare?: string };
  if (typeof body.secret !== "string" || !sameSecret(body.secret, expected)) {
    return NextResponse.json({ ok: false, error: "neautorizat" }, { status: 401 });
  }
  const who = String(body.cine ?? "").trim().slice(0, 60) || "necunoscut";
  const screen = String(body.ecran ?? "").trim().slice(0, 60) || "aplicație";
  const error = String(body.eroare ?? "").trim().slice(0, 300);
  if (!error) return NextResponse.json({ ok: false, error: "Lipsește eroarea." }, { status: 400 });
  const now = Date.now();
  await command("LPUSH", "ajutor:erori", JSON.stringify({ cand: new Date(now).toISOString(), cine: who, ecran: screen, eroare: error }));
  await command("LTRIM", "ajutor:erori", 0, 199);

  if (NETWORK.test(error)) {
    // Câți oameni diferiți au pierdut conexiunea în ultima jumătate de oră.
    await command("ZADD", "ajutor:retea", now, `${who}|${now}`);
    await command("ZREMRANGEBYSCORE", "ajutor:retea", 0, now - WINDOW_MS);
    const recent = await command<string[]>("ZRANGEBYSCORE", "ajutor:retea", now - WINDOW_MS, now);
    const people = new Set(recent.map((item) => item.split("|")[0]));
    if (people.size >= 3 && (await once("retea", 2 * 60 * 60))) {
      await tellDaniel(
        `Problemă în Team Vodă: ${people.size} oameni nu pot trimite`,
        `În ultima jumătate de oră, ${people.size} oameni (${[...people].slice(0, 5).join(", ")}) au pierdut conexiunea cu aplicația la trimitere. Cel mai probabil e aglomerație la Google sau internet slab; aplicația le păstrează formularul, dar spune-le să reîncerce peste câteva minute.`,
        "Monitorizarea erorilor Team Vodă",
      );
    }
    return NextResponse.json({ ok: true });
  }
  if (await once(`eroare:${screen}:${error.slice(0, 80)}`, 2 * 60 * 60)) {
    await tellDaniel(
      `Eroare în Team Vodă (${screen})`,
      `${who} a primit o eroare în „${screen}”: ${error}`,
      "Monitorizarea erorilor Team Vodă",
    );
  }
  return NextResponse.json({ ok: true });
}
