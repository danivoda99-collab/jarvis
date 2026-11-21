import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { cheieWidget } from "@/lib/echipa";
import { scriptWidget } from "@/lib/widget-script";

// Scriptul gata făcut pentru Scriptable (cu cheia deja pusă). POST face o cheie nouă: widgetul vechi nu mai vede nimic.
export const dynamic = "force-dynamic";

function adresa(request: Request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export async function GET(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const cheie = await cheieWidget();
  return NextResponse.json({ script: scriptWidget(adresa(request), cheie) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const cheie = await cheieWidget(true);
  return NextResponse.json({ script: scriptWidget(adresa(request), cheie) });
}
