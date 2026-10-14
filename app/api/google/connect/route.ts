import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { consentUrl } from "@/lib/google";

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  if (!(await isAuthenticated())) return NextResponse.redirect(origin);
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return new NextResponse("Lipsesc GOOGLE_CLIENT_ID sau GOOGLE_CLIENT_SECRET în Vercel. Adaugă-le și fă Redeploy.", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return NextResponse.redirect(consentUrl(origin));
}
