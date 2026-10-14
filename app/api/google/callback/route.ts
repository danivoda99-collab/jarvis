import { NextResponse } from "next/server";
import { isAuthenticated, SESSION_MAX_AGE } from "@/lib/auth";
import { GOOGLE_COOKIE, exchangeCode, oauthState, sealToken } from "@/lib/google";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = url.origin;
  const fail = (reason: string) => NextResponse.redirect(`${origin}/?google=${encodeURIComponent(reason)}`);

  if (!(await isAuthenticated())) return NextResponse.redirect(origin);
  if (url.searchParams.get("state") !== oauthState()) return fail("eroare");
  const code = url.searchParams.get("code");
  if (!code) return fail("anulat");

  const tokens = await exchangeCode(code, origin);
  if (!tokens.refresh_token) return fail("eroare");

  const response = NextResponse.redirect(`${origin}/?google=conectat`);
  response.cookies.set(GOOGLE_COOKIE, sealToken(tokens.refresh_token), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return response;
}
