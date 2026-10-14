import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_MAX_AGE, newSessionValue, passcodeMatches } from "@/lib/auth";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { code?: unknown };
  const code = typeof body.code === "string" ? body.code : "";

  if (!process.env.JARVIS_PASSCODE || !process.env.SESSION_SECRET) {
    return NextResponse.json(
      { error: "Serverul nu are codul setat. Verifică variabilele în Vercel și fă Redeploy." },
      { status: 500 },
    );
  }

  if (!passcodeMatches(code)) {
    // Mică pauză ca să încetinim ghicitul codului.
    await new Promise((resolve) => setTimeout(resolve, 800));
    return NextResponse.json({ error: "Cod greșit." }, { status: 401 });
  }

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
