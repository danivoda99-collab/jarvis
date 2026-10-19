import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { newOauthState } from "@/lib/google";
import { SPOTIFY_STATE, spotifyConsentUrl } from "@/lib/spotify";

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  if (!(await isAuthenticated())) return NextResponse.redirect(origin);
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    return new NextResponse("Lipsesc SPOTIFY_CLIENT_ID sau SPOTIFY_CLIENT_SECRET în Vercel. Adaugă-le și fă Redeploy.", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const state = newOauthState();
  const response = NextResponse.redirect(spotifyConsentUrl(origin, state));
  response.cookies.set(SPOTIFY_STATE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/spotify",
    maxAge: 600,
  });
  return response;
}
