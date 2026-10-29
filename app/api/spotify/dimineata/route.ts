import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { command } from "@/lib/cereri";
import { SpotifyError, morningKey, ownPlaylist, spotifyClient, type SpotifyCall } from "@/lib/spotify";

type Device = { id: string; type: string };

export const maxDuration = 60;

// Ce pune dimineața (din Setări) și ziua în care Daniel a zis „fără muzică mâine dimineață”.
const PLAYLIST = "argus:muzica:playlist";
const SKIP = "argus:muzica:sari";
const DEFAULT_PLAYLIST = "Every morning every day";

function sameKey(given: string) {
  const want = Buffer.from(morningKey());
  const got = Buffer.from(given);
  return got.length === want.length && timingSafeEqual(got, want);
}

function bucharestDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bucharest", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// Unde cântă: „telefon” (linkul din Scurtături) sau „laptop” (pornirea de la 9:30, Spotify-ul deschis de punte). Încearcă ~`tries` × 1,5 s.
async function playMorning(call: SpotifyCall, wanted: string, options: { where: "telefon" | "laptop"; tries: number }) {
  const found = wanted ? await ownPlaylist(call, wanted, true) : undefined;
  if (wanted && !found) return { status: 404, body: { error: `N-am găsit playlistul „${wanted}”.` } };
  for (let tries = 0; tries < options.tries; tries += 1) {
    const { data } = await call<{ devices: Device[] }>("/me/player/devices");
    const devices = data?.devices ?? [];
    const device = devices.find((item) => item.type === (options.where === "laptop" ? "Computer" : "Smartphone"));
    if (device) {
      const id = encodeURIComponent(device.id);
      if (found) await call(`/me/player/shuffle?state=true&device_id=${id}`, { method: "PUT" });
      const { status } = await call(`/me/player/play?device_id=${id}`, {
        method: "PUT",
        body: found ? JSON.stringify({ context_uri: found.uri }) : undefined,
      });
      const where = device.type === "Smartphone" ? "pe telefon" : "pe laptop";
      if (status < 300) return { status: 200, body: { ok: true, unde: device.type, text: found ? `Pornit ${where}: ${found.name}.` : `Am pornit muzica ${where}.` } };
    }
    if (tries < options.tries - 1) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return { status: 502, body: { error: `Spotify nu apare ca dispozitiv pe ${options.where}.` } };
}

function failed(caught: unknown) {
  const message = caught instanceof SpotifyError ? caught.message : "Spotify nu răspunde.";
  return NextResponse.json({ error: message }, { status: 502 });
}

// Linkul pentru automatizarea de dimineață din Scurtături („Obține conținutul URL-ului”, după acțiunea Play din Spotify).
// Cu ?cheie=… pune playlistul pe iPhone; fără cheie, Setările lui Daniel (autentificat) primesc linkul de copiat.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const key = url.searchParams.get("cheie") ?? "";
  if (!key) {
    if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
    return NextResponse.json({ link: `${url.origin}/api/spotify/dimineata?cheie=${morningKey()}&playlist=` });
  }
  if (!sameKey(key)) return NextResponse.json({ error: "Cheie greșită." }, { status: 401 });
  try {
    const result = await playMorning(await spotifyClient(), (url.searchParams.get("playlist") ?? "").trim(), { where: "telefon", tries: 16 });
    return NextResponse.json(result.body, { status: result.status });
  } catch (caught) {
    return failed(caught);
  }
}

// Autentificat (telefonul sau puntea de pe laptop):
// {playlist} = Setările au schimbat playlistul de dimineață; {sari: true} = „fără muzică mâine dimineață”;
// {porneste: true, unde} = laptopul, la ora fixă, pornește muzica pe el (implicit) sau pe telefon (dacă azi nu e sărită).
export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { playlist?: string; sari?: boolean; porneste?: boolean; unde?: string };
  try {
    if (typeof body.playlist === "string") {
      const name = body.playlist.trim().slice(0, 100);
      await command(...(name ? ["SET", PLAYLIST, name] : ["DEL", PLAYLIST]));
      return NextResponse.json({ ok: true });
    }
    if (body.sari !== undefined) {
      const tomorrow = bucharestDate(new Date(Date.now() + 86_400_000));
      // Noaptea târziu (înainte de 5), „mâine dimineață” e chiar dimineața asta.
      const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Bucharest", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
      const day = hour < 5 ? bucharestDate() : tomorrow;
      if (body.sari) await command("SET", SKIP, day, "EX", 2 * 86_400);
      else await command("DEL", SKIP);
      return NextResponse.json({ ok: true, zi: day, text: body.sari ? `Bine, pe ${day} nu pornesc muzica dimineața.` : "Bine, muzica de dimineață pornește ca de obicei." });
    }
    if (body.porneste) {
      const skip = await command<string | null>("GET", SKIP).catch(() => null);
      if (skip === bucharestDate()) return NextResponse.json({ ok: true, sarit: true, text: "Azi fără muzică, cum ai cerut." });
      const wanted = (await command<string | null>("GET", PLAYLIST).catch(() => null)) || DEFAULT_PLAYLIST;
      const result = await playMorning(await spotifyClient(), wanted, { where: body.unde === "telefon" ? "telefon" : "laptop", tries: 8 });
      return NextResponse.json(result.body, { status: result.status });
    }
    return NextResponse.json({ error: "Cerere necunoscută." }, { status: 400 });
  } catch (caught) {
    return failed(caught);
  }
}
