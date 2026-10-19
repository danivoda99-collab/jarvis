import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_MAX_AGE } from "@/lib/auth";
import { SPOTIFY_COOKIE, SPOTIFY_STATE, exchangeSpotifyCode, sealToken } from "@/lib/spotify";

// Ca la Google: întoarcerea vine de pe alt site, deci verificăm codul unic și revenim printr-o pagină proprie.
function backToApp(result: string) {
  const target = `/?spotify=${encodeURIComponent(result)}`;
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><script>location.replace(${JSON.stringify(target)})</script>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const store = await cookies();
  const expected = store.get(SPOTIFY_STATE)?.value;
  if (!expected || url.searchParams.get("state") !== expected) return backToApp("eroare");
  const code = url.searchParams.get("code");
  if (!code) return backToApp("anulat");
  const tokens = await exchangeSpotifyCode(code, url.origin);
  if (!tokens.refresh_token) return backToApp("eroare");
  const response = backToApp("conectat");
  response.cookies.set(SPOTIFY_COOKIE, sealToken(tokens.refresh_token), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  response.cookies.delete({ name: SPOTIFY_STATE, path: "/api/spotify" });
  return response;
}
