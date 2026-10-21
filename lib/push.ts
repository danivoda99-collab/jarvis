import webpush, { type PushSubscription } from "web-push";
import { command } from "@/lib/cereri";

// Notificări pe telefon când aplicația e închisă: un rezultat gata, o cercetare terminată, o confirmare de dat.
// Cheile VAPID se generează o singură dată, pe server, și stau în Redis; nu le vede și nu le copiază nimeni.

const VAPID = "argus:vapid";
const SUBSCRIPTIONS = "argus:push";
// Telefonul cu aplicația deschisă reînnoiește cheia asta; cât există, nu trimitem notificări (aude direct).
const OPEN = "argus:aplicatie-deschisa";

async function vapid(): Promise<{ publicKey: string; privateKey: string }> {
  const saved = await command<string | null>("GET", VAPID);
  if (saved) return JSON.parse(saved);
  const keys = webpush.generateVAPIDKeys();
  await command("SET", VAPID, JSON.stringify(keys), "NX");
  return JSON.parse((await command<string | null>("GET", VAPID)) ?? JSON.stringify(keys));
}

export async function publicKey() {
  return (await vapid()).publicKey;
}

export async function subscribe(subscription: PushSubscription) {
  await command("SADD", SUBSCRIPTIONS, JSON.stringify(subscription));
}

export async function unsubscribe(endpoint: string) {
  const all = await command<string[]>("SMEMBERS", SUBSCRIPTIONS);
  for (const value of all) {
    if ((JSON.parse(value) as PushSubscription).endpoint === endpoint) await command("SREM", SUBSCRIPTIONS, value);
  }
}

// „Nu mă deranja”: cât există cheia, notificările obișnuite se țin deoparte și le spune Argus la final.
const QUIET = "argus:nu-deranja";
const HELD = "argus:amanate";

export async function quietUntil(): Promise<string | null> {
  return command<string | null>("GET", QUIET);
}

export async function setQuiet(minutes: number): Promise<string | null> {
  if (minutes <= 0) {
    await command("DEL", QUIET);
    return null;
  }
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  await command("SET", QUIET, until, "EX", Math.round(minutes * 60));
  return until;
}

// Ce a venit cât a fost liniște; citirea le și golește, ca să fie spuse o singură dată.
export async function takeHeld(): Promise<{ titlu: string; text: string }[]> {
  const items = await command<string[]>("LRANGE", HELD, 0, 19);
  if (items.length) await command("DEL", HELD);
  return items.map((item) => JSON.parse(item) as { titlu: string; text: string }).reverse();
}

export async function markOpen() {
  await command("SET", OPEN, "1", "EX", 30);
}

// Nu aruncă niciodată: o notificare ratată nu trebuie să strice cererea.
export async function notify(title: string, body: string, tag?: string, urgent = false) {
  try {
    if (!urgent && (await command<string | null>("GET", QUIET))) {
      await command("LPUSH", HELD, JSON.stringify({ titlu: title.slice(0, 120), text: body.slice(0, 240) }));
      await command("LTRIM", HELD, 0, 19);
      return;
    }
    if (await command<string | null>("GET", OPEN)) return;
    const all = await command<string[]>("SMEMBERS", SUBSCRIPTIONS);
    if (!all.length) return;
    const keys = await vapid();
    webpush.setVapidDetails("mailto:argus@jarvis-one-psi-36.vercel.app", keys.publicKey, keys.privateKey);
    const payload = JSON.stringify({ title, body: body.slice(0, 240), tag });
    await Promise.all(
      all.map(async (value) => {
        try {
          await webpush.sendNotification(JSON.parse(value) as PushSubscription, payload, { TTL: 60 * 60 * 6 });
        } catch (caught) {
          const status = (caught as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) await command("SREM", SUBSCRIPTIONS, value);
        }
      }),
    );
  } catch {
    // fără notificare
  }
}

// Prima propoziție dintr-un rezultat, pentru textul notificării.
export function firstSentence(text = "") {
  return text.split(/(?<=[.!?])\s|\n/)[0]?.trim() || text.slice(0, 200);
}
