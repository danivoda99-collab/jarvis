import { NextResponse } from "next/server";
import { command } from "@/lib/cereri";
import { ruleazaPaznic } from "@/lib/paznic";

// Paznicul tehnic, chemat la 10 minute de cron-job.org (contul lui Daniel). Nu din GitHub Actions: asta a dus la suspendarea contului.
// Nu arată nimic despre Daniel: răspunde doar câte probleme a găsit. Rulează cel mult o dată la 4 minute,
// oricine ar chema adresa, deci nu poate fi folosit la nesfârșit.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const LOCK = "argus:paznic:lacat";

export async function GET() {
  try {
    if (!(await command<string | null>("SET", LOCK, "1", "NX", "EX", 240))) {
      return NextResponse.json({ ok: true, sarit: true });
    }
    const { probleme } = await ruleazaPaznic();
    // Ultima tură: ecranul Echipa îl arată pornit cât timp a rulat în ultima jumătate de oră.
    await command("SET", "argus:paznic:ultima", new Date().toISOString(), "EX", 24 * 60 * 60).catch(() => undefined);
    return NextResponse.json({ ok: true, probleme: probleme.length });
  } catch {
    // Paznicul însuși nu poate verifica (de exemplu Redis căzut): cron-job.org vede eroarea și îl anunță pe Daniel pe mail.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
