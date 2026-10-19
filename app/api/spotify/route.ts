import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { SpotifyError, spotifyClient, type SpotifyCall } from "@/lib/spotify";

type Device = { id: string; name: string; type: string; is_active: boolean };
type Item = { name: string; uri: string; artists?: { name: string }[]; owner?: { display_name?: string } };
type Playing = { is_playing: boolean; item?: Item; device?: Device };

const TYPES = { melodie: "track", playlist: "playlist", artist: "artist", album: "album" } as const;

function describe(item?: Item) {
  if (!item) return "";
  const who = item.artists?.map((artist) => artist.name).join(", ") || item.owner?.display_name;
  return who ? `${item.name} – ${who}` : item.name;
}

// Comenzile de redare merg doar pe un dispozitiv deschis; dacă niciunul nu e activ, îl trezim pe primul găsit (telefonul, de obicei).
async function onDevice(call: SpotifyCall, path: string, init: RequestInit): Promise<string | null> {
  let result = await call(path, init);
  if (result.status !== 404) return result.status < 300 ? null : `Spotify a răspuns cu ${result.status}.`;
  const { data } = await call<{ devices: Device[] }>("/me/player/devices");
  const devices = data?.devices ?? [];
  const device = devices.find((item) => item.type === "Smartphone") ?? devices[0];
  if (!device) return "Nu văd niciun dispozitiv cu Spotify pornit. Deschide o dată Spotify pe telefon și încearcă din nou.";
  const separator = path.includes("?") ? "&" : "?";
  result = await call(`${path}${separator}device_id=${encodeURIComponent(device.id)}`, init);
  return result.status < 300 ? null : `Spotify a răspuns cu ${result.status}.`;
}

export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  try {
    const call = await spotifyClient();
    const { data } = await call<Playing>("/me/player");
    if (!data?.item) return NextResponse.json({ canta: false, text: "Acum nu cântă nimic pe Spotify." });
    return NextResponse.json({ canta: data.is_playing, piesa: describe(data.item), dispozitiv: data.device?.name });
  } catch (caught) {
    const message = caught instanceof SpotifyError ? caught.message : "Spotify nu răspunde.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Neautentificat." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { actiune?: string; ce?: string; tip?: string; valoare?: number };
  const action = String(body.actiune ?? "");
  try {
    const call = await spotifyClient();
    let error: string | null = null;
    let text = "Gata.";
    if (action === "pune") {
      const query = String(body.ce ?? "").trim();
      if (!query) {
        error = await onDevice(call, "/me/player/play", { method: "PUT" });
        text = "Am pornit muzica.";
      } else {
        const type = TYPES[(body.tip as keyof typeof TYPES) ?? "melodie"] ?? "track";
        const { data } = await call<Record<string, { items: (Item | null)[] }>>(
          `/search?${new URLSearchParams({ q: query, type, limit: "1", market: "RO" })}`,
        );
        const found = data?.[`${type}s`]?.items?.find(Boolean) ?? undefined;
        if (!found) return NextResponse.json({ error: `N-am găsit „${query}” pe Spotify.` }, { status: 404 });
        const payload = type === "track" ? { uris: [found.uri] } : { context_uri: found.uri };
        error = await onDevice(call, "/me/player/play", { method: "PUT", body: JSON.stringify(payload) });
        text = `Pun ${describe(found)}.`;
      }
    } else if (action === "pauza") {
      error = await onDevice(call, "/me/player/pause", { method: "PUT" });
      text = "Am oprit muzica.";
    } else if (action === "urmatoarea" || action === "anterioara") {
      error = await onDevice(call, `/me/player/${action === "urmatoarea" ? "next" : "previous"}`, { method: "POST" });
      text = action === "urmatoarea" ? "Am trecut la următoarea." : "Am pus-o pe cea dinainte.";
    } else if (action === "volum") {
      const volume = Math.max(0, Math.min(100, Math.round(Number(body.valoare ?? 50))));
      error = await onDevice(call, `/me/player/volume?volume_percent=${volume}`, { method: "PUT" });
      text = `Volumul e la ${volume}%.`;
    } else {
      return NextResponse.json({ error: "Acțiune necunoscută." }, { status: 400 });
    }
    if (error) return NextResponse.json({ error }, { status: 502 });
    return NextResponse.json({ ok: true, text });
  } catch (caught) {
    const message = caught instanceof SpotifyError ? caught.message : "Spotify nu răspunde.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
