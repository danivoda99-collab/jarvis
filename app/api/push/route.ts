import { NextResponse } from "next/server";
import type { PushSubscription } from "web-push";
import { isAuthenticated } from "@/lib/auth";
import { publicKey, subscribe, unsubscribe } from "@/lib/push";

// Abonarea telefonului la notificări.

async function guard() {
  return (await isAuthenticated()) ? null : NextResponse.json({ error: "Neautentificat." }, { status: 401 });
}

export async function GET() {
  const denied = await guard();
  if (denied) return denied;
  try {
    return NextResponse.json({ cheie: await publicKey() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Notificările nu sunt pornite (lipsește Redis)." }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const denied = await guard();
  if (denied) return denied;
  const subscription = (await request.json().catch(() => null)) as PushSubscription | null;
  if (!subscription?.endpoint?.startsWith("https://") || !subscription.keys?.p256dh || !subscription.keys.auth) {
    return NextResponse.json({ error: "Abonare invalidă." }, { status: 400 });
  }
  try {
    await subscribe({ endpoint: subscription.endpoint, keys: subscription.keys });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Nu am putut salva abonarea." }, { status: 502 });
  }
}

export async function DELETE(request: Request) {
  const denied = await guard();
  if (denied) return denied;
  const { endpoint } = (await request.json().catch(() => ({}))) as { endpoint?: string };
  if (endpoint) await unsubscribe(endpoint).catch(() => undefined);
  return NextResponse.json({ ok: true });
}
