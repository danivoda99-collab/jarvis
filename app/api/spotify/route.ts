import { NextResponse, after } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { SpotifyError, spotifyClient, type SpotifyCall } from "@/lib/spotify";

type Device = { id: string; name: string; type: string; is_active: boolean };
type Item = { name: string; uri: string; artists?: { name: string }[]; owner?: { display_name?: string } };
type Playing = { is_playing: boolean; item?: Item; device?: Device };

const NO_DEVICE = "Nu văd niciun dispozitiv";

export const maxDuration = 60;

// Spotify „adormit” pe iPhone: telefonul îl deschide, iar serverul așteaptă să apară ca dispozitiv (cel mult ~25 s)
// și pornește singur ce s-a cerut, ca Daniel doar să se întoarcă în Argus.
function playWhenAwake(call: SpotifyCall, payload: Record<string, unknown> | null, path = "/me/player/play", method = "PUT") {
  after(async () => {
    for (let tries = 0; tries < 17; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const { data } = await call<{ devices: Device[] }>("/me/player/devices");
      const device = data?.devices?.find((item) => item.type === "Smartphone") ?? data?.devices?.[0];
      if (!device) continue;
      await call(`${path}?device_id=${encodeURIComponent(device.id)}`, {
        method,
        body: payload ? JSON.stringify(payload) : undefined,
      });
      return;
    }
  });
}

// După conversație iPhone-ul poate lăsa Spotify „înghețat”: comanda trece, dar nu cântă. Tot încercăm până cântă (~25 s).
function playUntilPlaying(call: SpotifyCall) {
  after(async () => {
    for (let tries = 0; tries < 17; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const { data: now } = await call<Playing>("/me/player");
      if (now?.is_playing) return;
      const { data } = await call<{ devices: Device[] }>("/me/player/devices");
      const device = data?.devices?.find((item) => item.type === "Smartphone") ?? data?.devices?.[0];
      if (device) await call(`/me/player/play?device_id=${encodeURIComponent(device.id)}`, { method: "PUT" });
    }
  });
}

const TYPES = { melodie: "track", playlist: "playlist", artist: "artist", album: "album" } as const;

// Fără diacritice și majuscule, ca „Dimineață” să se potrivească cu „dimineata”.
function plain(text: string) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const LIKED = /\b(favorit|apreciat|liked|preferat|melodiile mele|piesele mele|biblioteca)/;

// Playlisturile lui Daniel (inclusiv cele private): întâi potrivirea exactă, apoi cea care conține ce a cerut.
async function ownPlaylist(call: SpotifyCall, query: string, loose: boolean): Promise<Item | undefined> {
  const wanted = plain(query).replace(/^playlist(ul)?\s+/, "");
  const lists: Item[] = [];
  for (let offset = 0; offset < 200; offset += 50) {
    const { data } = await call<{ items: (Item | null)[]; next: string | null }>(`/me/playlists?limit=50&offset=${offset}`);
    lists.push(...((data?.items ?? []).filter(Boolean) as Item[]));
    if (!data?.next) break;
  }
  const exact = lists.find((item) => plain(item.name) === wanted);
  if (exact) return exact;
  // Numele playlistului conține ce a spus („chill” → „Chill seara”); invers doar când a cerut clar un playlist.
  const contains = lists.find((item) => (wanted.length > 2 && plain(item.name).includes(wanted)) || (loose && wanted.length > 3 && wanted.includes(plain(item.name))));
  if (contains) return contains;
  // Altfel, cel cu cele mai multe cuvinte comune („every morning” → „Every morning, every day”), cel puțin jumătate.
  const words = new Set(wanted.split(" ").filter((word) => word.length > 1));
  let best: Item | undefined;
  let bestScore = 0;
  for (const item of lists) {
    const name = new Set(plain(item.name).split(" "));
    const score = [...words].filter((word) => name.has(word)).length / Math.max(1, words.size);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore >= 0.5 && (loose || bestScore === 1) ? best : undefined;
}

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
  if (!device) {
    // Cel mai des: pe telefon e alt cont Spotify decât cel conectat la Argus. Spunem care e cel conectat.
    const { data: me } = await call<{ display_name?: string; id?: string }>("/me");
    const who = me?.display_name || me?.id;
    return `${NO_DEVICE} cu Spotify pornit${who ? ` pe contul „${who}”` : ""}. Deschide Spotify pe telefon, cu același cont, pune ceva câteva secunde și încearcă din nou.`;
  }
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
        // iPhone-ul a „adormit” Spotify: telefonul îl deschide direct, de unde a rămas.
        if (error?.startsWith(NO_DEVICE)) {
          playWhenAwake(call, null);
          return NextResponse.json({ error, deschide: "spotify:" }, { status: 502 });
        }
      } else {
        let found: Item | undefined;
        let payload: Record<string, unknown>;
        if (body.tip === "favorite" || LIKED.test(plain(query))) {
          // Melodiile apreciate de Daniel, amestecate.
          const { data } = await call<{ items: { track: Item | null }[] }>("/me/tracks?limit=50");
          const uris = (data?.items ?? []).map((entry) => entry.track?.uri).filter(Boolean) as string[];
          if (!uris.length) return NextResponse.json({ error: "Nu văd melodii apreciate. Reconectează Spotify din aplicație și încearcă din nou." }, { status: 404 });
          uris.sort(() => Math.random() - 0.5);
          found = { name: "melodiile tale apreciate", uri: "spotify:collection:tracks" };
          payload = { uris };
        } else {
          // Întâi biblioteca lui (playlisturi private incluse), apoi căutarea publică.
          found = body.tip !== "artist" ? await ownPlaylist(call, query, body.tip === "playlist") : undefined;
          if (found) payload = { context_uri: found.uri };
          else {
            const type = TYPES[(body.tip as keyof typeof TYPES) ?? "melodie"] ?? "track";
            const { data } = await call<Record<string, { items: (Item | null)[] }>>(
              `/search?${new URLSearchParams({ q: query, type, limit: "1", market: "RO" })}`,
            );
            found = data?.[`${type}s`]?.items?.find(Boolean) ?? undefined;
            if (!found) return NextResponse.json({ error: `N-am găsit „${query}” pe Spotify.` }, { status: 404 });
            payload = type === "track" ? { uris: [found.uri] } : { context_uri: found.uri };
          }
        }
        error = await onDevice(call, "/me/player/play", { method: "PUT", body: JSON.stringify(payload) });
        text = `Pun ${describe(found)}.`;
        // iPhone-ul a „adormit” Spotify: telefonul deschide Spotify direct pe ce s-a cerut.
        if (error?.startsWith(NO_DEVICE)) {
          playWhenAwake(call, payload);
          return NextResponse.json({ error, deschide: found.uri.startsWith("spotify:collection") ? "spotify:" : found.uri, piesa: describe(found) }, { status: 502 });
        }
      }
    } else if (action === "reia") {
      // După conversație: muzica pornește la loc; dacă iPhone-ul a adormit Spotify, mai încearcă câteva secunde, fără să-l deschidă.
      error = await onDevice(call, "/me/player/play", { method: "PUT" });
      if (!error) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const { data } = await call<Playing>("/me/player");
        if (!data?.is_playing) error = NO_DEVICE;
      }
      if (error?.startsWith(NO_DEVICE)) {
        // Telefonul deschide Spotify doar la finalul conversației; în așteptare (mașină) rămâne în Argus.
        playUntilPlaying(call);
        return NextResponse.json({ ok: true, text: "Pornesc muzica de îndată ce se trezește Spotify.", deschide: "spotify:" });
      }
      text = "Am pornit muzica la loc.";
    } else if (action === "pauza_daca_canta") {
      // Modul mașină: muzica se oprește cât vorbești cu Argus și pornește la loc după.
      const { data } = await call<Playing>("/me/player");
      if (!data?.is_playing) return NextResponse.json({ ok: true, pauzat: false });
      error = await onDevice(call, "/me/player/pause", { method: "PUT" });
      if (error) return NextResponse.json({ error }, { status: 502 });
      return NextResponse.json({ ok: true, pauzat: true });
    } else if (action === "pauza") {
      error = await onDevice(call, "/me/player/pause", { method: "PUT" });
      text = "Am oprit muzica.";
    } else if (action === "urmatoarea" || action === "anterioara") {
      const path = `/me/player/${action === "urmatoarea" ? "next" : "previous"}`;
      error = await onDevice(call, path, { method: "POST" });
      // iPhone-ul a „adormit” Spotify: îl deschidem și, când apare, pornim muzica și trecem la piesa cerută.
      if (error?.startsWith(NO_DEVICE)) {
        playWhenAwake(call, null, path, "POST");
        return NextResponse.json({ error, deschide: "spotify:" }, { status: 502 });
      }
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
