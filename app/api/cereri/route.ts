import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { QueueError, addCerere, getCerere, listCereri, readSignal, saveCerere, type Cerere, type Status } from "@/lib/cereri";

// Cererile pentru Claude de pe laptop. Telefonul și laptopul sunt logate amândouă cu codul lui Daniel.

function failure(caught: unknown) {
  const message = caught instanceof QueueError ? caught.message : "Coada nu răspunde.";
  return NextResponse.json({ error: message }, { status: 502 });
}

async function guard() {
  return (await isAuthenticated()) ? null : NextResponse.json({ error: "Neautentificat." }, { status: 401 });
}

export async function GET(request: Request) {
  const denied = await guard();
  if (denied) return denied;
  try {
    if (new URL(request.url).searchParams.has("semnal")) {
      return NextResponse.json({ semnal: await readSignal() }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ cereri: await listCereri() }, { headers: { "Cache-Control": "no-store" } });
  } catch (caught) {
    return failure(caught);
  }
}

// Argus pune o cerere nouă, după ce Daniel a apăsat Da.
export async function POST(request: Request) {
  const denied = await guard();
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as {
    titlu?: string;
    cerere?: string;
    confirmat?: { titlu?: string; text?: string; destinatar?: string };
  };
  const text = (body.cerere ?? "").trim().slice(0, 4000);
  if (!text) return NextResponse.json({ error: "Lipsește cererea." }, { status: 400 });
  const confirmed = body.confirmat?.text
    ? {
        titlu: String(body.confirmat.titlu ?? "").slice(0, 200),
        text: String(body.confirmat.text).slice(0, 4000),
        destinatar: body.confirmat.destinatar ? String(body.confirmat.destinatar).slice(0, 200) : undefined,
      }
    : undefined;
  try {
    const cerere = await addCerere((body.titlu ?? "").trim().slice(0, 120) || text.slice(0, 60), text, confirmed);
    return NextResponse.json({ ok: true, id: cerere.id });
  } catch (caught) {
    return failure(caught);
  }
}

const NEXT: Partial<Record<Status, Status[]>> = {
  nouă: ["în lucru"],
  "în lucru": ["gata", "eroare", "așteaptă confirmare"],
  "așteaptă confirmare": ["confirmată", "refuzată"],
  confirmată: ["în lucru"],
  eroare: ["nouă"],
};

// Schimbă starea unei cereri: laptopul raportează progresul, Daniel răspunde Da/Nu la confirmări.
export async function PATCH(request: Request) {
  const denied = await guard();
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as Partial<Cerere> & { id?: string };
  if (!body.id || !body.status) return NextResponse.json({ error: "Lipsește cererea sau starea." }, { status: 400 });
  try {
    const current = await getCerere(body.id);
    if (!current) return NextResponse.json({ error: "Cererea nu mai există." }, { status: 404 });
    if (!NEXT[current.status]?.includes(body.status)) {
      return NextResponse.json({ error: `Cererea e deja „${current.status}”.` }, { status: 409 });
    }
    const updated: Cerere = {
      ...current,
      status: body.status,
      actualizat: new Date().toISOString(),
      rezultat: body.rezultat !== undefined ? String(body.rezultat).slice(0, 8000) : current.rezultat,
      confirmare: body.status === "așteaptă confirmare" ? body.confirmare : current.confirmare,
      sesiune: body.sesiune ?? current.sesiune,
    };
    await saveCerere(updated);
    return NextResponse.json({ ok: true });
  } catch (caught) {
    return failure(caught);
  }
}
