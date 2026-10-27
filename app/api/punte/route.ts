import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";

// Puntea de pe laptop își ia singură versiunea nouă de aici (fără „ia din main”): primește codul și amprenta lui.
// Doar cu sesiunea lui Daniel; fișierul e cel din aceeași versiune a aplicației care rulează acum.
export const dynamic = "force-dynamic";

const FILES = ["argus-bridge.mjs", "team-voda.mjs"];

export async function GET(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const name = new URL(request.url).searchParams.get("fisier") || FILES[0];
  if (!FILES.includes(name)) return NextResponse.json({ error: "Fișier necunoscut." }, { status: 400 });
  try {
    const cod = await readFile(join(process.cwd(), "bridge", name), "utf8");
    return NextResponse.json({ fisier: name, amprenta: createHash("sha256").update(cod).digest("hex"), cod });
  } catch {
    return NextResponse.json({ error: "Fișierul nu e în această versiune." }, { status: 404 });
  }
}
