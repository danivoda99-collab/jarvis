import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_MAX_AGE, newSessionValue, passcodeMatches } from "@/lib/auth";
import { command } from "@/lib/cereri";
import { notify } from "@/lib/push";

// Ghicitul codului: cel mult 5 încercări la 15 minute de la aceeași adresă și cel mult 40 pe oră în total,
// oricâte adrese ar folosi cineva. Numărăm încercarea ÎNAINTE de a verifica codul, ca nici cererile trimise
// în paralel să nu treacă de limită. Aparatele deja logate (telefonul, laptopul) nu sunt afectate de blocare.
const PER_IP = 5;
const PER_IP_SECONDS = 15 * 60;
const TOTAL = 40;
const TOTAL_SECONDS = 60 * 60;
const TOTAL_KEY = "argus:login:total";

async function count(key: string, seconds: number) {
  const value = await command<number>("INCR", key);
  if (value === 1) await command("EXPIRE", key, seconds);
  return value;
}

function blocked() {
  return NextResponse.json({ error: "Prea multe încercări. Mai încearcă peste un sfert de oră." }, { status: 429 });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { code?: unknown };
  const code = typeof body.code === "string" ? body.code.slice(0, 200) : "";

  if (!process.env.JARVIS_PASSCODE || !process.env.SESSION_SECRET) {
    return NextResponse.json(
      { error: "Serverul nu are codul setat. Verifică variabilele în Vercel și fă Redeploy." },
      { status: 500 },
    );
  }

  const ip = (request.headers.get("x-forwarded-for") ?? "necunoscut").split(",")[0].trim().slice(0, 60);
  const ipKey = `argus:login:ip:${ip}`;
  let fromIp: number;
  let total: number;
  try {
    [fromIp, total] = await Promise.all([count(ipKey, PER_IP_SECONDS), count(TOTAL_KEY, TOTAL_SECONDS)]);
  } catch {
    // Fără numărătoare nu verificăm codul deloc: altfel o pană la Redis ar redeschide ghicitul nelimitat.
    return NextResponse.json({ error: "Nu pot verifica acum. Mai încearcă peste un minut." }, { status: 503 });
  }
  if (fromIp > PER_IP || total > TOTAL) {
    // Daniel află o singură dată pe oră că cineva încearcă codul (urgent: trece și de „nu deranja”).
    if (fromIp === PER_IP + 1 || total === TOTAL + 1) {
      const first = await command<string | null>("SET", "argus:login:alerta", "1", "NX", "EX", TOTAL_SECONDS).catch(() => null);
      if (first) {
        await notify(
          "Argus: încercări de intrare cu cod greșit",
          "Cineva a greșit codul de mai multe ori și l-am blocat. Dacă n-ai fost tu, spune-mi și schimbăm codul.",
          "login",
          true,
        ).catch(() => undefined);
      }
    }
    return blocked();
  }

  if (!passcodeMatches(code)) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return NextResponse.json({ error: "Cod greșit." }, { status: 401 });
  }

  // Intrarea reușită nu se pune la socoteală.
  await Promise.all([command("DEL", ipKey), command("DECR", TOTAL_KEY)]).catch(() => undefined);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, newSessionValue(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
