import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { QueueError } from "@/lib/cereri";
import { addFapt, addSchimb, listConversatie, listFapte, removeFapt, saveLaptopMemory } from "@/lib/memorie";

// Memoria comună: faptele de ținut minte și ultimele schimburi din conversație.

function failure(caught: unknown) {
  const message = caught instanceof QueueError ? caught.message : "Memoria nu răspunde.";
  return NextResponse.json({ error: message }, { status: 502 });
}

async function guard() {
  return (await isAuthenticated()) ? null : NextResponse.json({ error: "Neautentificat." }, { status: 401 });
}

export async function GET() {
  const denied = await guard();
  if (denied) return denied;
  try {
    const [fapte, conversatie] = await Promise.all([listFapte(), listConversatie()]);
    return NextResponse.json({ fapte, conversatie }, { headers: { "Cache-Control": "no-store" } });
  } catch (caught) {
    return failure(caught);
  }
}

// { fapt } ține minte un lucru; { user, assistant } adaugă un schimb la conversație; { laptop } = memorie.md.
export async function POST(request: Request) {
  const denied = await guard();
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { fapt?: string; user?: string; assistant?: string; laptop?: string };
  try {
    if (typeof body.laptop === "string") {
      await saveLaptopMemory(body.laptop);
      return NextResponse.json({ ok: true });
    }
    const fapt = (body.fapt ?? "").trim().slice(0, 300);
    if (fapt) {
      await addFapt(fapt);
      return NextResponse.json({ ok: true });
    }
    const user = (body.user ?? "").slice(0, 4000);
    const assistant = (body.assistant ?? "").slice(0, 4000);
    if (!user || !assistant) return NextResponse.json({ error: "Nimic de ținut minte." }, { status: 400 });
    await addSchimb(user, assistant);
    return NextResponse.json({ ok: true });
  } catch (caught) {
    return failure(caught);
  }
}

// Uită un fapt, doar când Daniel cere și confirmă.
export async function DELETE(request: Request) {
  const denied = await guard();
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { fapt?: string };
  try {
    const removed = await removeFapt((body.fapt ?? "").trim());
    return removed
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "Nu găsesc faptul exact; citește întâi memoria." }, { status: 404 });
  } catch (caught) {
    return failure(caught);
  }
}
