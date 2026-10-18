import { NextResponse } from "next/server";

// Ce versiune a aplicației rulează acum pe server; telefonul o compară cu a lui ca să se actualizeze singur.
export const dynamic = "force-dynamic";

export function GET() {
  const versiune = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || "local";
  return NextResponse.json({ versiune }, { headers: { "Cache-Control": "no-store" } });
}
