import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { GoogleError, addDays, bucharestIso, formatLocal, google, todayInBucharest, TIME_ZONE } from "@/lib/google";

const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

type Event = {
  summary?: string;
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
      titlu: event.summary ?? "(fără titlu)",
      cand: event.start?.dateTime ? formatLocal(event.start.dateTime) : `${event.start?.date} (toată ziua)`,
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
