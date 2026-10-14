import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { STATE_COOKIE, consentUrl, newOauthState } from "@/lib/google";

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  if (!(await isAuthenticated())) return NextResponse.redirect(origin);
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return new NextResponse("Lipsesc GOOGLE_CLIENT_ID sau GOOGLE_CLIENT_SECRET în Vercel. Adaugă-le și fă Redeploy.", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  // Doar cine e logat primește acest cod unic; întoarcerea de la Google trebuie să-l aducă înapoi.
  const state = newOauthState();
  const response = NextResponse.redirect(consentUrl(origin, state));
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/google",
    maxAge: 600,
  });
  return response;
}
