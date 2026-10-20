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
let source: AudioBufferSourceNode | null = null;

export function stopSpeaking() {
  speakGeneration += 1;
  try {
    source?.stop();
  } catch {
    // sunetul se terminase deja
  }
  source = null;
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
  const queue: Promise<ArrayBuffer>[] = [];
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
        await play(ctx, await ctx.decodeAudioData(await queue[index]), generation);
      } catch {
        // o bucată n-a venit de la OpenAI: trecem la următoarea
      }
      index += 1;
    }
  })();
  return {
    push(sentence) {
      if (!sentence.trim() || generation !== speakGeneration) return;
      const pending = fetchSpeech(sentence.trim());
      pending.catch(() => {});
      queue.push(pending);
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

async function fetchSpeech(text: string): Promise<ArrayBuffer> {
  const response = await fetch("/api/vorbeste", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voce: chosenVoiceName() || cloudDefault, limba: spokenLanguage() }),
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.arrayBuffer();
}

function play(ctx: AudioContext, buffer: AudioBuffer, generation: number): Promise<void> {
  return new Promise((resolve) => {
    if (generation !== speakGeneration) return resolve();
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    source = node;
    const done = () => {
      if (finishCurrent === done) finishCurrent = null;
      resolve();
    };
    finishCurrent = done;
    node.onended = done;
    node.start();
  });
}

async function cloudSpeak(text: string): Promise<void> {
  stopSpeaking();
  const generation = speakGeneration;
  const ctx = audio();
  if (!ctx) return browserSpeak(text);
  if (ctx.state !== "running") await ctx.resume().catch(() => {});
  const parts = chunks(text);
  const pending = parts.map((part) => fetchSpeech(part));
  pending.forEach((promise) => promise.catch(() => {}));
  for (let index = 0; index < parts.length; index += 1) {
    if (generation !== speakGeneration) return;
    let buffer: AudioBuffer;
    try {
      buffer = await ctx.decodeAudioData(await pending[index]);
    } catch {
      // OpenAI nu răspunde: restul îl citește vocea din browser, ca să nu rămână mut.
      if (generation !== speakGeneration) return;
      return browserSpeak(parts.slice(index).join(" "));
    }
    await play(ctx, buffer, generation);
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
    return undefined;
  } catch (caught) {
    return caught instanceof DOMException && caught.name === "NotAllowedError" ? "not-allowed" : "start";
  }
}

export function closeMic() {
  micStream?.getTracks().forEach((track) => track.stop());
  micStream = null;
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
  }

  function finishRecording() {
    cleanup();
    if (recorder.state !== "inactive") recorder.stop();
  }

  recorder.onstop = async () => {
    if (aborted) return;
    if (!spoke || pieces.length === 0) return onEnd();
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
