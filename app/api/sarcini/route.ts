import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { GoogleError, google } from "@/lib/google";

const TASKS = "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks";

type Task = { id: string; title?: string; notes?: string; due?: string };

function failure(caught: unknown) {
  const message = caught instanceof GoogleError ? caught.message : "Nu am putut ajunge la Google Tasks.";
  return NextResponse.json({ error: message }, { status: 502 });
}

async function guard() {
  return (await isAuthenticated()) ? null : NextResponse.json({ error: "Neautentificat." }, { status: 401 });
}

// Sarcinile nebifate din lista principală.
export async function GET() {
  const denied = await guard();
  if (denied) return denied;
  try {
    const data = await google<{ items?: Task[] }>(`${TASKS}?showCompleted=false&maxResults=100`);
    const tasks = (data.items ?? []).map((task) => ({
      id: task.id,
      titlu: task.title ?? "",
      notite: task.notes,
      scadenta: task.due?.slice(0, 10),
    }));
    return NextResponse.json({ sarcini: tasks });
  } catch (caught) {
    return failure(caught);
  }
}

// Adaugă o sarcină. Aplicația cere confirmarea lui Daniel înainte să ajungă aici.
export async function POST(request: Request) {
  const denied = await guard();
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { titlu?: string; notite?: string; scadenta?: string };
  if (!body.titlu) return NextResponse.json({ error: "Lipsește titlul." }, { status: 400 });
  try {
    await google(TASKS, {
      method: "POST",
      body: JSON.stringify({
        title: body.titlu,
        notes: body.notite,
        due: body.scadenta ? `${body.scadenta.slice(0, 10)}T00:00:00.000Z` : undefined,
      }),
    });
    return NextResponse.json({ ok: true });
  } catch (caught) {
    return failure(caught);
  }
}

// Bifează o sarcină ca făcută (nu o șterge) sau îi schimbă titlul, scadența ori notițele.
export async function PATCH(request: Request) {
  const denied = await guard();
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    titlu?: string;
    scadenta?: string;
    notite?: string;
  };
  if (!body.id) return NextResponse.json({ error: "Lipsește sarcina." }, { status: 400 });
  const changes: Record<string, unknown> = {};
  if (body.titlu) changes.title = body.titlu;
  if (body.notite !== undefined) changes.notes = body.notite;
  if (body.scadenta) changes.due = `${body.scadenta.slice(0, 10)}T00:00:00.000Z`;
  // Doar cererea fără niciun câmp de schimbat bifează sarcina; un câmp gol nu o termină din greșeală.
  const asked = body.titlu !== undefined || body.notite !== undefined || body.scadenta !== undefined;
  if (Object.keys(changes).length === 0) {
    if (asked) return NextResponse.json({ error: "Nu am primit nimic de schimbat." }, { status: 400 });
    changes.status = "completed";
  }
  try {
    await google(`${TASKS}/${encodeURIComponent(body.id)}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    });
    return NextResponse.json({ ok: true });
  } catch (caught) {
    return failure(caught);
  }
}
