// Urechea și vocea lui ARGUS. Cu cheie OpenAI în Vercel: auz prin transcriere și voce naturală de la OpenAI.
// Fără ea: recunoașterea și vocile din browser, gratuite dar mai robotice.

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
};

type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

function browserCanListen() {
  return recognitionCtor() !== null;
}

export type Heard = { text: string; final: boolean };

// Pauza după care Argus consideră că Daniel a terminat de vorbit.
const PAUSE_MS = 1800;
const MAX_LISTEN_MS = 45_000;

// Ascultă o replică în română. Pauzele scurte nu o taie: se oprește după PAUSE_MS de liniște.
function browserListen(onHeard: (heard: Heard) => void, onEnd: (error?: string) => void): () => void {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    onEnd("unsupported");
    return () => {};
  }
  const recognition = new Ctor();
  recognition.lang = "ro-RO";
  recognition.continuous = true;
  recognition.interimResults = true;
  let error: string | undefined;
  let pause: ReturnType<typeof setTimeout> | undefined;
  const cap = setTimeout(() => recognition.stop(), MAX_LISTEN_MS);
  recognition.onresult = (event) => {
    let finals = "";
    let interim = "";
    for (let index = 0; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result?.[0]?.transcript ?? "";
      if (result?.isFinal) finals += `${text} `;
      else interim += `${text} `;
    }
    const text = `${finals}${interim}`.replace(/\s+/g, " ").trim();
    if (!text) return;
    // Textul rămâne „final” doar când nu mai e nimic provizoriu; la liniște, provizoriul devine final.
    onHeard({ text, final: !interim.trim() });
    if (pause) clearTimeout(pause);
    pause = setTimeout(() => {
      onHeard({ text, final: true });
      recognition.stop();
    }, PAUSE_MS);
  };
  recognition.onerror = (event) => {
    error = event.error;
  };
  recognition.onend = () => {
    clearTimeout(cap);
    if (pause) clearTimeout(pause);
    onEnd(error);
  };
  try {
    recognition.start();
  } catch {
    clearTimeout(cap);
    onEnd("start");
  }
  return () => {
    clearTimeout(cap);
    if (pause) clearTimeout(pause);
    recognition.abort();
  };
}

// Vocile englezești, de la cea mai potrivită: Brian (Edge pe Windows), Evan sau Nathan (iPhone), apoi orice voce naturală.
const PREFERRED = [/brian(?!.*multilingual)/i, /brian/i, /evan.*(enhanced|premium)/i, /nathan.*(enhanced|premium)/i, /evan/i];

function score(voice: SpeechSynthesisVoice) {
  const index = PREFERRED.findIndex((pattern) => pattern.test(voice.name));
  let value = index >= 0 ? 100 - index * 10 : 0;
  if (/natural|online|premium|enhanced|neural/i.test(voice.name)) value += 20;
  if (/en-US/i.test(voice.lang)) value += 5;
  return value;
}

export function englishVoices(): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !window.speechSynthesis) return [];
  return window.speechSynthesis
    .getVoices()
    .filter((voice) => voice.lang.toLowerCase().startsWith("en"))
    .sort((a, b) => score(b) - score(a));
}

const VOICE_KEY = "argus-voce";
const LANGUAGE_KEY = "argus-limba";

export type Language = "en" | "ro";

// În ce limbă îi vorbește Argus lui Daniel. Scrisul rămâne mereu în română.
export function spokenLanguage(): Language {
  try {
    // Implicit română: aplicația de pe ecranul principal și Safari (butonul de Acțiune) au memorii separate,
    // iar o memorie goală nu trebuie să-l facă pe Argus să răspundă în engleză.
    return localStorage.getItem(LANGUAGE_KEY) === "en" ? "en" : "ro";
  } catch {
    return "ro";
  }
}

export function chooseLanguage(language: Language) {
  try {
    localStorage.setItem(LANGUAGE_KEY, language);
  } catch {
    // fără memorare; rămâne româna
  }
}

export function chosenVoiceName(): string {
  try {
    return localStorage.getItem(VOICE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function chooseVoice(name: string) {
  try {
    if (name) localStorage.setItem(VOICE_KEY, name);
    else localStorage.removeItem(VOICE_KEY);
  } catch {
    // fără memorare; se folosește vocea implicită
  }
}

function browserVoice(): SpeechSynthesisVoice | null {
  if (spokenLanguage() === "ro") {
    return window.speechSynthesis?.getVoices().find((voice) => voice.lang.toLowerCase().startsWith("ro")) ?? null;
  }
  const voices = englishVoices();
  const saved = chosenVoiceName();
  return voices.find((voice) => voice.name === saved) ?? voices[0] ?? null;
}

// --- Alegerea motorului ---------------------------------------------------------

let cloud = false;
let cloudDefault = "ash";

// Până aflăm dacă serverul are vocea OpenAI, nu vorbim cu vocea robotică a telefonului (cel mult 4 secunde).
let markChecked: () => void = () => {};
const voiceChecked = new Promise<void>((resolve) => {
  markChecked = resolve;
  setTimeout(resolve, 4000);
});

export function voiceCheckDone() {
  markChecked();
}

export function setCloudVoice(enabled: boolean, defaultVoice: string) {
  cloud = enabled;
  cloudDefault = defaultVoice;
  markChecked();
}

export function canListen() {
  if (!cloud) return browserCanListen();
  return typeof window !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined";
}

// --- Sunetul (Web Audio merge sigur pe iPhone după o atingere) ------------------

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!context) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
  }
  return context;
}

// Pe iPhone vocea pornește doar după o atingere: o deblocăm la prima atingere.
export function primeSpeech() {
  const ctx = audio();
  if (ctx && ctx.state !== "running") void ctx.resume();
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth || cloud) return;
  synth.cancel();
  synth.speak(new SpeechSynthesisUtterance(""));
}

let finishCurrent: (() => void) | null = null;
let wakeStream: (() => void) | null = null;
let speakGeneration = 0;
// Bucățile de sunet programate să cânte; le oprim toate când Daniel întrerupe.
const playing = new Set<AudioBufferSourceNode>();

export function stopSpeaking() {
  speakGeneration += 1;
  for (const node of playing) {
    try {
      node.stop();
    } catch {
      // sunetul se terminase deja
    }
  }
  playing.clear();
  window.speechSynthesis?.cancel();
  // Unele browsere nu anunță sfârșitul frazelor anulate; închidem noi promisiunea.
  finishCurrent?.();
  wakeStream?.();
}

// Vorbește pe măsură ce sosesc propozițiile: prima pornește cât Claude încă scrie restul.
export function speakStream(): { push: (sentence: string) => void; finish: () => Promise<void> } {
  const ctx = cloud ? audio() : null;
  if (!ctx) {
    let all = "";
    return { push: (sentence) => void (all += ` ${sentence}`), finish: () => speak(all) };
  }
  stopSpeaking();
  const generation = speakGeneration;
  const queue: { text: string; response: Promise<Response> }[] = [];
  let ended = false;
  const wake = () => {
    const resume = wakeStream;
    wakeStream = null;
    resume?.();
  };
  const loop = (async () => {
    if (ctx.state !== "running") await ctx.resume().catch(() => {});
    for (let index = 0; ; ) {
      if (generation !== speakGeneration) return;
      if (index >= queue.length) {
        if (ended) return;
        await new Promise<void>((resolve) => (wakeStream = resolve));
        continue;
      }
      try {
        await playStream(ctx, await queue[index].response, generation);
      } catch {
        // o bucată n-a venit de la OpenAI: o citește vocea telefonului, ca Argus să nu rămână mut
        if (generation === speakGeneration) await browserSpeak(queue[index].text);
      }
      index += 1;
    }
  })();
  return {
    push(sentence) {
      if (!sentence.trim() || generation !== speakGeneration) return;
      const response = requestSpeech(sentence.trim());
      response.catch(() => {});
      queue.push({ text: sentence.trim(), response });
      wake();
    },
    finish() {
      ended = true;
      wake();
      return loop;
    },
  };
}

export async function speak(text: string): Promise<void> {
  if (!text.trim()) return;
  await voiceChecked;
  return cloud ? cloudSpeak(text) : browserSpeak(text);
}

// Bucăți de una-două propoziții: prima ajunge repede, restul se pregătesc cât vorbește.
function chunks(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*/g)?.map((part) => part.trim()).filter(Boolean) ?? [text];
  const result: string[] = [];
  for (const sentence of sentences) {
    // Prima propoziție pleacă singură; următoarele se adună până la ~180 de caractere.
    const last = result[result.length - 1];
    if (result.length >= 2 && last.length + sentence.length < 180) result[result.length - 1] = `${last} ${sentence}`;
    else result.push(sentence);
  }
  return result;
}

// Sunetul vine ca PCM brut (24 kHz, 16 biți, mono), ca să-l putem cânta pe măsură ce sosește.
const PCM_RATE = 24_000;

async function requestSpeech(text: string): Promise<Response> {
  const response = await fetch("/api/vorbeste", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voce: chosenVoiceName() || cloudDefault, limba: spokenLanguage(), format: "pcm" }),
  });
  if (!response.ok || !response.body) throw new Error(String(response.status));
  return response;
}

function pcmToFloat(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length - (bytes.length % 2));
  const samples = new Float32Array(view.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
  return samples;
}

// Frazele fixe (salutul) rămân în memorie după ce le aducem o dată, ca să pornească pe loc.
const phrases = new Map<string, Float32Array>();

function phraseKey(text: string) {
  return `${chosenVoiceName() || cloudDefault}|${spokenLanguage()}|${text.trim()}`;
}

export function preloadPhrase(text: string) {
  const key = phraseKey(text);
  if (!cloud || phrases.has(key)) return;
  requestSpeech(text.trim())
    .then((response) => response.arrayBuffer())
    .then((buffer) => {
      if (buffer.byteLength > 0) phrases.set(key, pcmToFloat(new Uint8Array(buffer)));
    })
    .catch(() => {});
}

function playSamples(ctx: AudioContext, samples: Float32Array, generation: number): Promise<void> {
  return new Promise((resolve) => {
    if (generation !== speakGeneration || !samples.length) return resolve();
    const buffer = ctx.createBuffer(1, samples.length, PCM_RATE);
    buffer.getChannelData(0).set(samples);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    playing.add(node);
    const done = () => {
      if (finishCurrent === done) finishCurrent = null;
      playing.delete(node);
      resolve();
    };
    finishCurrent = done;
    node.onended = done;
    node.start();
  });
}

// Cântă o frază cât încă se descarcă: primele ~0,1 secunde pornesc imediat, restul se leagă în continuare.
// Se termină când a cântat tot; aruncă eroare doar dacă n-a venit nimic de cântat.
async function playStream(ctx: AudioContext, response: Response, generation: number): Promise<void> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  let carry: number | null = null; // un octet rămas din bucata trecută
  let pending: Float32Array[] = [];
  let pendingLength = 0;
  let playhead = 0;
  let last: AudioBufferSourceNode | null = null;

  const flush = () => {
    if (!pendingLength || generation !== speakGeneration) return;
    const buffer = ctx.createBuffer(1, pendingLength, PCM_RATE);
    const channel = buffer.getChannelData(0);
    let offset = 0;
    for (const piece of pending) {
      channel.set(piece, offset);
      offset += piece.length;
    }
    pending = [];
    pendingLength = 0;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    const start = Math.max(playhead, ctx.currentTime + 0.03);
    node.start(start);
    playhead = start + buffer.duration;
    playing.add(node);
    node.onended = () => playing.delete(node);
    last = node;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (generation !== speakGeneration) {
      reader.cancel().catch(() => {});
      return;
    }
    if (done) break;
    if (!value?.length) continue;
    let bytes = value;
    if (carry !== null) {
      const joined = new Uint8Array(bytes.length + 1);
      joined[0] = carry;
      joined.set(bytes, 1);
      bytes = joined;
      carry = null;
    }
    if (bytes.length % 2) carry = bytes[bytes.length - 1];
    const samples = pcmToFloat(bytes);
    pending.push(samples);
    pendingLength += samples.length;
    // Când e aproape să rămână fără sunet, pornim bucăți mici; altfel le adunăm câte o jumătate de secundă.
    const ahead = playhead - ctx.currentTime;
    if (pendingLength >= PCM_RATE * (ahead < 0.25 ? 0.1 : 0.5)) flush();
  }
  flush();
  const tail = last as AudioBufferSourceNode | null;
  if (!tail) {
    if (generation === speakGeneration) throw new Error("fără sunet");
    return;
  }
  await new Promise<void>((resolve) => {
    if (!playing.has(tail)) return resolve();
    const done = () => {
      if (finishCurrent === done) finishCurrent = null;
      playing.delete(tail);
      resolve();
    };
    finishCurrent = done;
    tail.onended = done;
  });
}

async function cloudSpeak(text: string): Promise<void> {
  stopSpeaking();
  const generation = speakGeneration;
  const ctx = audio();
  if (!ctx) return browserSpeak(text);
  if (ctx.state !== "running") await ctx.resume().catch(() => {});
  const known = phrases.get(phraseKey(text));
  if (known) return playSamples(ctx, known, generation);
  const parts = chunks(text);
  const pending = parts.map((part) => requestSpeech(part));
  pending.forEach((promise) => promise.catch(() => {}));
  for (let index = 0; index < parts.length; index += 1) {
    if (generation !== speakGeneration) return;
    try {
      await playStream(ctx, await pending[index], generation);
    } catch {
      // OpenAI nu răspunde: restul îl citește vocea din browser, ca să nu rămână mut.
      if (generation !== speakGeneration) return;
      return browserSpeak(parts.slice(index).join(" "));
    }
  }
}

// --- Auzul prin OpenAI ------------------------------------------------------------

let micStream: MediaStream | null = null;

// Pornește microfonul o dată pe conversație, ca iPhone-ul să nu întrebe la fiecare frază.
export async function openMic(): Promise<string | undefined> {
  if (!cloud) return undefined;
  if (micStream?.active) return undefined;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    void openLive();
    return undefined;
  } catch (caught) {
    return caught instanceof DOMException && caught.name === "NotAllowedError" ? "not-allowed" : "start";
  }
}

export function closeMic() {
  micStream?.getTracks().forEach((track) => track.stop());
  micStream = null;
  closeLive();
}

// --- Auzul instant (în test): vocea pleacă la OpenAI pe măsură ce vorbește Daniel ----------
// Textul vine bucată cu bucată și e gata aproape imediat ce tace. Dacă nu merge, se folosește înregistrarea, ca până acum.

const FAST_KEY = "argus-auz-instant";
const LIVE_RATE = 24_000;
const LIVE_WAIT_MS = 3000; // cât așteptăm textul final după ce tace, înainte să trimitem înregistrarea

export function fastHearing(): boolean {
  try {
    return localStorage.getItem(FAST_KEY) === "1";
  } catch {
    return false;
  }
}

export function chooseFastHearing(on: boolean) {
  try {
    if (on) localStorage.setItem(FAST_KEY, "1");
    else localStorage.removeItem(FAST_KEY);
  } catch {
    // fără memorare
  }
  liveProblem = "";
  if (on && micStream?.active) void openLive();
  if (!on) closeLive();
}

// Ultimul motiv pentru care auzul instant n-a mers, ca Daniel să-l vadă în Setări.
let liveProblem = "";
let liveUsed = 0;

export function fastHearingStatus(): string {
  if (!fastHearing()) return "";
  if (liveProblem) return `nu merge: ${liveProblem}`;
  return liveUsed > 0 ? `merge (${liveUsed} replici)` : "pornit";
}

type Live = {
  socket: WebSocket;
  text: string;
  onDelta: ((text: string) => void) | null;
  waiting: ((text: string | null) => void) | null;
};

let live: Live | null = null;
let liveOpening: Promise<Live | null> | null = null;

function openLive(): Promise<Live | null> {
  if (!cloud || !fastHearing() || typeof WebSocket === "undefined") return Promise.resolve(null);
  if (live && live.socket.readyState <= WebSocket.OPEN) return Promise.resolve(live);
  if (liveOpening) return liveOpening;
  liveOpening = (async () => {
    try {
      const response = await fetch("/api/asculta/cheie", { method: "POST" });
      const data = (await response.json().catch(() => ({}))) as { cheie?: string; error?: string };
      if (!response.ok || !data.cheie) {
        liveProblem = data.error || `cheia a dat eroare ${response.status}`;
        return null;
      }
      const socket = new WebSocket("wss://api.openai.com/v1/realtime", ["realtime", `openai-insecure-api-key.${data.cheie}`]);
      const entry: Live = { socket, text: "", onDelta: null, waiting: null };
      const settle = (text: string | null) => {
        const resolve = entry.waiting;
        entry.waiting = null;
        entry.text = "";
        resolve?.(text);
      };
      socket.onmessage = (event) => {
        let message: { type?: string; delta?: string; transcript?: string; error?: { message?: string } };
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.type === "conversation.item.input_audio_transcription.delta" && message.delta) {
          entry.text += message.delta;
          entry.onDelta?.(entry.text);
        } else if (message.type === "conversation.item.input_audio_transcription.completed") {
          liveProblem = "";
          liveUsed += 1;
          settle(message.transcript ?? entry.text);
        } else if (message.type === "error") {
          liveProblem = message.error?.message?.slice(0, 160) || "eroare de la OpenAI";
          settle(null);
        }
      };
      socket.onclose = (event) => {
        if (live === entry) live = null;
        if (event.code !== 1000 && !liveProblem) liveProblem = `legătura s-a închis (${event.code}${event.reason ? `: ${event.reason.slice(0, 80)}` : ""})`;
        settle(null);
      };
      live = entry;
      return entry;
    } catch {
      liveProblem = "nu pot porni legătura";
      return null;
    } finally {
      liveOpening = null;
    }
  })();
  return liveOpening;
}

function closeLive() {
  const entry = live;
  live = null;
  entry?.socket.close(1000);
}

function sendLive(entry: Live, event: object) {
  if (entry.socket.readyState === WebSocket.OPEN) entry.socket.send(JSON.stringify(event));
}

// Microfonul merge la 44,1 sau 48 kHz; OpenAI vrea 24 kHz, 16 biți, în base64.
function livePcm(input: Float32Array, rate: number): string {
  const ratio = rate / LIVE_RATE;
  const length = Math.floor(input.length / ratio);
  const samples = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const from = Math.floor(index * ratio);
    const to = Math.max(from + 1, Math.min(input.length, Math.floor((index + 1) * ratio)));
    let sum = 0;
    for (let position = from; position < to; position += 1) sum += input[position];
    samples[index] = Math.max(-1, Math.min(1, sum / (to - from))) * 0x7fff;
  }
  const bytes = new Uint8Array(samples.buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function recorderType(): string {
  for (const type of ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return "";
}

const SILENCE_MS = 1200; // după atâta liniște, Daniel a terminat
let userTalking = false; // Daniel vorbește chiar acum; Argus nu-l întrerupe cu anunțuri

export function isUserTalking() {
  return userTalking;
}
const NO_SPEECH_MS = 8000; // dacă nu spune nimic, runda e „tăcută”

function cloudListen(
  onHeard: (heard: Heard) => void,
  onEnd: (error?: string, message?: string) => void,
  onLevel?: (level: number) => void,
): () => void {
  const ctx = audio();
  const stream = micStream;
  if (!ctx || !stream?.active) {
    onEnd("start");
    return () => {};
  }
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const input = ctx.createMediaStreamSource(stream);
  input.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  // Cu auzul instant, sunetul pleacă și direct la OpenAI cât vorbește; înregistrarea rămâne ca rezervă.
  const liveEntry = live && live.socket.readyState === WebSocket.OPEN ? live : null;
  if (!liveEntry && fastHearing()) void openLive();
  let tap: ScriptProcessorNode | null = null;
  if (liveEntry) {
    sendLive(liveEntry, { type: "input_audio_buffer.clear" });
    liveEntry.text = "";
    liveEntry.onDelta = (text) => onHeard({ text, final: false });
    tap = ctx.createScriptProcessor(2048, 1, 1);
    tap.onaudioprocess = (event) => {
      sendLive(liveEntry, { type: "input_audio_buffer.append", audio: livePcm(event.inputBuffer.getChannelData(0), ctx.sampleRate) });
    };
    input.connect(tap);
    tap.connect(ctx.destination);
  }
  const type = recorderType();
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const pieces: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) pieces.push(event.data);
  };

  const startedAt = performance.now();
  let floor = 0;
  let floorSamples = 0;
  let loud = 0;
  let spoke = false;
  let lastVoice = startedAt;
  let aborted = false;

  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const value of samples) sum += value * value;
    const rms = Math.sqrt(sum / samples.length);
    const now = performance.now();
    // O notificare pe iPhone oprește sunetul câteva clipe: nu o luăm drept liniște și nu tăiem ce spune Daniel.
    const track = stream.getAudioTracks()[0];
    if (ctx.state !== "running" || track?.muted || track?.readyState === "ended") {
      if (ctx.state !== "running") void ctx.resume().catch(() => {});
      lastVoice = now;
      return;
    }
    if (now - startedAt < 300) {
      floor = (floor * floorSamples + rms) / (floorSamples + 1);
      floorSamples += 1;
      return;
    }
    const threshold = Math.max(0.012, floor * 2.5);
    onLevel?.(Math.min(1, rms * 12));
    if (rms > threshold) {
      loud += 1;
      if (loud >= 2) {
        spoke = true;
        userTalking = true;
        lastVoice = now;
      }
    } else loud = 0;
    if ((spoke && now - lastVoice > SILENCE_MS) || (!spoke && now - startedAt > NO_SPEECH_MS) || now - startedAt > MAX_LISTEN_MS) {
      finishRecording();
    }
  }, 50);

  function cleanup() {
    userTalking = false;
    clearInterval(timer);
    input.disconnect();
    tap?.disconnect();
    if (tap) tap.onaudioprocess = null;
    if (liveEntry) liveEntry.onDelta = null;
  }

  // Textul de la auzul instant, dacă vine la timp; altfel null și trimitem înregistrarea.
  function liveText(): Promise<string | null> {
    if (!liveEntry || liveEntry.socket.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (liveEntry.waiting === finish) liveEntry.waiting = null;
        resolve(null);
      }, LIVE_WAIT_MS);
      const finish = (text: string | null) => {
        clearTimeout(timeout);
        resolve(text);
      };
      liveEntry.waiting = finish;
      sendLive(liveEntry, { type: "input_audio_buffer.commit" });
    });
  }

  let quick: Promise<string | null> = Promise.resolve(null);

  function finishRecording() {
    cleanup();
    if (spoke) quick = liveText();
    if (recorder.state !== "inactive") recorder.stop();
  }

  recorder.onstop = async () => {
    if (aborted) return;
    if (!spoke || pieces.length === 0) return onEnd();
    const fast = await quick;
    if (aborted) return;
    if (fast !== null && fast.trim()) {
      onHeard({ text: fast.trim(), final: true });
      return onEnd();
    }
    onHeard({ text: "…", final: false });
    const blob = new Blob(pieces, { type: recorder.mimeType || type || "audio/webm" });
    const extension = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
    const form = new FormData();
    form.set("audio", blob, `voce.${extension}`);
    try {
      const response = await fetch("/api/asculta", { method: "POST", body: form });
      const data = (await response.json()) as { text?: string; error?: string };
      if (aborted) return;
      if (!response.ok) return onEnd("server", data.error);
      if (data.text) onHeard({ text: data.text, final: true });
      onEnd();
    } catch {
      if (!aborted) onEnd("server", "Nu am putut trimite ce ai spus. Verifică internetul.");
    }
  };

  try {
    recorder.start(250);
  } catch {
    cleanup();
    onEnd("start");
  }
  return () => {
    aborted = true;
    cleanup();
    if (recorder.state !== "inactive") recorder.stop();
  };
}

// Ascultă o replică a lui Daniel, cu motorul ales.
export function listenOnce(
  onHeard: (heard: Heard) => void,
  onEnd: (error?: string, message?: string) => void,
  onLevel?: (level: number) => void,
): () => void {
  return cloud ? cloudListen(onHeard, onEnd, onLevel) : browserListen(onHeard, onEnd);
}

// --- Vocea din browser (rezervă) -------------------------------------------------

// Citește textul propoziție cu propoziție (Chrome taie frazele lungi de peste 15 secunde).
function browserSpeak(text: string): Promise<void> {
  const synth = window.speechSynthesis;
  if (!synth || !text.trim()) return Promise.resolve();
  const voice = browserVoice();
  const parts = text.match(/[^.!?]+[.!?]*/g)?.map((part) => part.trim()).filter(Boolean) ?? [text];
  synth.cancel();
  finishCurrent?.();
  return new Promise((resolve) => {
    let left = parts.length;
    const finish = () => {
      if (finishCurrent === finish) finishCurrent = null;
      resolve();
    };
    finishCurrent = finish;
    // Plasă de siguranță: dacă browserul nu anunță niciodată sfârșitul vocii, nu rămânem blocați.
    const words = text.split(/\s+/).length;
    setTimeout(finish, 4000 + words * 600);
    const done = () => {
      left -= 1;
      if (left <= 0) finish();
    };
    for (const part of parts) {
      const utterance = new SpeechSynthesisUtterance(part);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else {
        utterance.lang = spokenLanguage() === "ro" ? "ro-RO" : "en-US";
      }
      utterance.rate = 1.03;
      utterance.onend = done;
      utterance.onerror = done;
      synth.speak(utterance);
    }
  });
}

// Răspunsul lui Claude are partea vorbită în engleză și varianta română pentru jurnal.
export function splitReply(raw: string): { spoken: string; ro: string } {
  const spoken = raw.match(/<spoken>([\s\S]*?)<\/spoken>/i)?.[1]?.trim();
  const ro = raw.match(/<ro>([\s\S]*?)<\/ro>/i)?.[1]?.trim();
  const plain = raw.replace(/<\/?[a-z]+>/gi, " ").replace(/\s+/g, " ").trim();
  return { spoken: spoken ?? plain, ro: ro ?? spoken ?? plain };
}
