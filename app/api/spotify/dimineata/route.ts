import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { SpotifyError, morningKey, ownPlaylist, spotifyClient } from "@/lib/spotify";

type Device = { id: string; type: string };

export const maxDuration = 60;

function sameKey(given: string) {
  const want = Buffer.from(morningKey());
  const got = Buffer.from(given);
  return got.length === want.length && timingSafeEqual(got, want);
}

// Linkul pentru automatizarea de dimineață din Scurtături („Obține conținutul URL-ului”, merge și cu telefonul blocat).
// Cu ?cheie=… pune playlistul pe iPhone; fără cheie, Setările lui Daniel (autentificat) primesc linkul de copiat.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const key = url.searchParams.get("cheie") ?? "";
  if (!key) {
    if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
    return NextResponse.json({ link: `${url.origin}/api/spotify/dimineata?cheie=${morningKey()}&playlist=` });
  }
  if (!sameKey(key)) return NextResponse.json({ error: "Cheie greșită." }, { status: 401 });
  const wanted = (url.searchParams.get("playlist") ?? "").trim();
  try {
    const call = await spotifyClient();
    const found = wanted ? await ownPlaylist(call, wanted, true) : undefined;
    if (wanted && !found) return NextResponse.json({ error: `N-am găsit playlistul „${wanted}”.` }, { status: 404 });
    // Acțiunea Play din Scurtături tocmai a trezit Spotify; telefonul apare ca dispozitiv în câteva secunde.
    for (let tries = 0; tries < 16; tries += 1) {
      const { data } = await call<{ devices: Device[] }>("/me/player/devices");
      const device = data?.devices?.find((item) => item.type === "Smartphone") ?? data?.devices?.[0];
      if (device) {
        const id = encodeURIComponent(device.id);
        if (found) await call(`/me/player/shuffle?state=true&device_id=${id}`, { method: "PUT" });
        const { status } = await call(`/me/player/play?device_id=${id}`, {
          method: "PUT",
          body: found ? JSON.stringify({ context_uri: found.uri }) : undefined,
        });
        if (status < 300) return NextResponse.json({ ok: true, text: found ? `Pornit: ${found.name}.` : "Am pornit muzica." });
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return NextResponse.json({ error: "Spotify nu a apărut pe telefon. Pune acțiunea Play din Spotify înaintea linkului." }, { status: 502 });
  } catch (caught) {
    const message = caught instanceof SpotifyError ? caught.message : "Spotify nu răspunde.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
