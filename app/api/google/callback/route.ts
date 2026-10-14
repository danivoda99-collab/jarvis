import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_MAX_AGE } from "@/lib/auth";
import { GOOGLE_COOKIE, STATE_COOKIE, exchangeCode, sealToken } from "@/lib/google";

// Întoarcerea vine de pe google.com, așa că browserul nu trimite cookie-ul de sesiune (e „strict”).
// Verificăm în schimb codul unic pus de /api/google/connect și revenim în aplicație dintr-o pagină
// proprie, ca la încărcarea aplicației sesiunea să fie din nou trimisă.
function backToApp(result: string) {
  const target = `/?google=${encodeURIComponent(result)}`;
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><script>location.replace(${JSON.stringify(target)})</script>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const store = await cookies();
  const expected = store.get(STATE_COOKIE)?.value;
  if (!expected || url.searchParams.get("state") !== expected) return backToApp("eroare");
  const code = url.searchParams.get("code");
  if (!code) return backToApp("anulat");

  const tokens = await exchangeCode(code, url.origin);
  if (!tokens.refresh_token) return backToApp("eroare");

  const response = backToApp("conectat");
  response.cookies.set(GOOGLE_COOKIE, sealToken(tokens.refresh_token), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  response.cookies.delete({ name: STATE_COOKIE, path: "/api/google" });
  return response;
}
