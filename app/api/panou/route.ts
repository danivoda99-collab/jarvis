import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { situation } from "@/lib/buget";
import { command, laptopAway } from "@/lib/cereri";
import { addDays, bucharestIso, formatLocal, google, todayInBucharest, TIME_ZONE } from "@/lib/google";
import { budgetMoney } from "@/lib/vizual";

// Cifrele mici de pe ecranul principal: următoarea întâlnire, bugetul lunii, sarcinile și echipa.
// Fiecare bucată merge separat: dacă Google nu răspunde, restul tot apare.

const ECHIPA = "argus:panou:echipa";
type Echipa = { raportat: number; total: number; subTel?: number; analize?: number; tel?: number; actualizat: string };

async function nextMeeting() {
  const today = todayInBucharest();
  const query = new URLSearchParams({
    timeMin: new Date().toISOString(),
    timeMax: bucharestIso(`${addDays(today, 2)}T00:00`),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "10",
    timeZone: TIME_ZONE,
  });
  const data = await google<{ items?: { summary?: string; start?: { dateTime?: string } }[] }>(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${query}`,
  );
  const next = (data.items ?? []).find((event) => event.start?.dateTime && Date.parse(event.start.dateTime) > Date.now());
  if (!next?.start?.dateTime) return null;
  return { titlu: next.summary ?? "(fără titlu)", cand: formatLocal(next.start.dateTime), inceput: next.start.dateTime };
}

async function budget() {
  const { luna, tabel, venit } = await situation();
  const m = budgetMoney(tabel, venit);
  if (!m.budget) return null;
  // Bani: venit − cheltuit, cât ar trebui să fie în cont (îl compară cu banca). Liber: după ce mai e de plătit din buget.
  return {
    luna,
    procent: Math.round((m.spent / m.budget) * 100),
    ramas: Math.round(m.budget - m.spent),
    liber: m.free === null ? undefined : Math.round(m.free),
    bani: m.money === null ? undefined : Math.round(m.money),
    deplata: Math.round(m.toPay),
  };
}

async function tasks() {
  const data = await google<{ items?: { due?: string }[] }>("https://tasks.googleapis.com/tasks/v1/lists/@default/tasks?showCompleted=false&maxResults=100");
  const items = data.items ?? [];
  const today = todayInBucharest();
  return { ramase: items.length, azi: items.filter((item) => item.due && item.due.slice(0, 10) <= today).length };
}

async function team(): Promise<Echipa | null> {
  const raw = await command<string | null>("GET", ECHIPA);
  return raw ? (JSON.parse(raw) as Echipa) : null;
}

export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const settle = <T,>(promise: Promise<T>) => promise.catch(() => null);
  const [intalnire, buget, sarcini, echipa, laptop] = await Promise.all([
    settle(nextMeeting()),
    settle(budget()),
    settle(tasks()),
    settle(team()),
    settle(laptopAway()),
  ]);
  return NextResponse.json({ intalnire, buget, sarcini, echipa, laptop }, { headers: { "Cache-Control": "no-store" } });
}

// Laptopul trimite cifrele echipei (doar totaluri, fără nume și fără clienți) după rezumatul de seară sau raportul de luni.
export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { echipa?: Partial<Record<keyof Echipa, unknown>> };
  const number = (value: unknown) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Math.max(0, Math.round(Number(value))) : undefined);
  const raportat = number(body.echipa?.raportat);
  const total = number(body.echipa?.total);
  if (raportat === undefined || !total) return NextResponse.json({ error: "Lipsesc raportat și total." }, { status: 400 });
  const echipa: Echipa = {
    raportat: Math.min(raportat, total),
    total,
    subTel: number(body.echipa?.subTel),
    analize: number(body.echipa?.analize),
    tel: number(body.echipa?.tel),
    actualizat: new Date().toISOString(),
  };
  try {
    await command("SET", ECHIPA, JSON.stringify(echipa), "EX", 8 * 24 * 60 * 60);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Coada nu răspunde." }, { status: 502 });
  }
}
