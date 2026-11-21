import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { brainState, laptopAccess } from "@/lib/creier";

// Creierul de pe laptop: puntea își ia de aici adresa canalului pe care ascultă întrebările telefonului,
// iar telefonul (sau Daniel) poate vedea cine a răspuns ultima dată: laptopul sau rezerva pe API.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const params = new URL(request.url).searchParams;
  try {
    if (params.has("acces")) {
      const access = await laptopAccess(params.has("complet"));
      if (!access) return NextResponse.json({ error: "Coada nu e pornită." }, { status: 500 });
      return NextResponse.json(access, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(await brainState(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Coada nu răspunde." }, { status: 502 });
  }
}
