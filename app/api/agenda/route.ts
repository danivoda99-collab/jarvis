import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { GoogleError, addDays, bucharestIso, formatLocal, google, todayInBucharest, TIME_ZONE } from "@/lib/google";

const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

type Event = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

function failure(caught: unknown) {
  const message = caught instanceof GoogleError ? caught.message : "Nu am putut ajunge la Google Calendar.";
  return NextResponse.json({ error: message }, { status: 502 });
}

// Citește evenimentele dintre două zile (inclusiv), din calendarul principal.
export async function GET(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const from = params.get("de_la") || todayInBucharest();
  const to = params.get("pana_la") || from;
  const query = new URLSearchParams({
    timeMin: bucharestIso(`${from}T00:00`),
    timeMax: bucharestIso(`${addDays(to, 1)}T00:00`),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
    timeZone: TIME_ZONE,
  });
  try {
    const data = await google<{ items?: Event[] }>(`${CALENDAR}?${query}`);
    const events = (data.items ?? []).map((event) => ({
      id: event.id,
      titlu: event.summary ?? "(fără titlu)",
      cand: event.start?.dateTime ? formatLocal(event.start.dateTime) : `${event.start?.date} (toată ziua)`,
      inceput: event.start?.dateTime,
      pana_la: event.end?.dateTime ? formatLocal(event.end.dateTime) : undefined,
      loc: event.location,
    }));
    return NextResponse.json({ de_la: from, pana_la: to, evenimente: events });
  } catch (caught) {
    return failure(caught);
  }
}

// Adaugă un eveniment. Aplicația cere confirmarea lui Daniel înainte să ajungă aici.
export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as {
    titlu?: string;
    inceput?: string;
    sfarsit?: string;
    descriere?: string;
  };
  if (!body.titlu || !body.inceput) {
    return NextResponse.json({ error: "Lipsesc titlul sau ora de început." }, { status: 400 });
  }
  const start = body.inceput.slice(0, 16);
  const end = body.sfarsit?.slice(0, 16) || new Date(new Date(`${start}:00Z`).getTime() + 3600_000).toISOString().slice(0, 16);
  try {
    await google(CALENDAR, {
      method: "POST",
      body: JSON.stringify({
        summary: body.titlu,
        description: body.descriere,
        start: { dateTime: `${start}:00`, timeZone: TIME_ZONE },
        end: { dateTime: `${end}:00`, timeZone: TIME_ZONE },
      }),
    });
    return NextResponse.json({ ok: true });
  } catch (caught) {
    return failure(caught);
  }
}

function localMinutes(iso: string): string {
  // „2026-10-15T10:00:00+03:00” → „2026-10-15T10:00”, în ora României.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

// Modifică un eveniment: titlul, ora sau descrierea. Dacă se mută doar începutul, păstrează durata.
export async function PATCH(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    titlu?: string;
    inceput?: string;
    sfarsit?: string;
    descriere?: string;
  };
  if (!body.id) return NextResponse.json({ error: "Lipsește evenimentul." }, { status: 400 });
  const url = `${CALENDAR}/${encodeURIComponent(body.id)}`;
  try {
    const changes: Record<string, unknown> = {};
    if (body.titlu) changes.summary = body.titlu;
    if (body.descriere !== undefined) changes.description = body.descriere;
    if (body.inceput || body.sfarsit) {
      const current = await google<Event>(url);
      const oldStart = current.start?.dateTime;
      const oldEnd = current.end?.dateTime;
      if (!oldStart || !oldEnd) {
        return NextResponse.json({ error: "Evenimentele de toată ziua nu se pot muta de aici." }, { status: 400 });
      }
      const start = body.inceput?.slice(0, 16) || localMinutes(oldStart);
      const duration = new Date(oldEnd).getTime() - new Date(oldStart).getTime();
      const end =
        body.sfarsit?.slice(0, 16) ||
        new Date(new Date(`${start}:00Z`).getTime() + duration).toISOString().slice(0, 16);
      changes.start = { dateTime: `${start}:00`, timeZone: TIME_ZONE };
      changes.end = { dateTime: `${end}:00`, timeZone: TIME_ZONE };
    }
    if (Object.keys(changes).length === 0) {
      return NextResponse.json({ error: "Nu am primit nicio schimbare." }, { status: 400 });
    }
    await google(url, { method: "PATCH", body: JSON.stringify(changes) });
    return NextResponse.json({ ok: true });
  } catch (caught) {
    return failure(caught);
  }
}

// Șterge un eveniment. Google îl păstrează 30 de zile în Coșul calendarului, de unde se poate recupera.
export async function DELETE(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { id?: string };
  if (!body.id) return NextResponse.json({ error: "Lipsește evenimentul." }, { status: 400 });
  try {
    await google(`${CALENDAR}/${encodeURIComponent(body.id)}`, { method: "DELETE" });
    return NextResponse.json({ ok: true });
  } catch (caught) {
    return failure(caught);
  }
}
