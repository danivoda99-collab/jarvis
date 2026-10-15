// Urechea și vocea lui ARGUS, direct din browser: recunoaștere vocală în română și voce în engleză.
// Nu costă nimic și nu are limită de minute.

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

export function canListen() {
  return recognitionCtor() !== null;
}

export type Heard = { text: string; final: boolean };

// Ascultă o singură frază în română. Se oprește singur la tăcere.
export function listenOnce(onHeard: (heard: Heard) => void, onEnd: (error?: string) => void): () => void {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    onEnd("unsupported");
    return () => {};
  }
  const recognition = new Ctor();
  recognition.lang = "ro-RO";
  recognition.continuous = false;
  recognition.interimResults = true;
  let error: string | undefined;
  recognition.onresult = (event) => {
    const result = event.results[event.results.length - 1];
    if (result?.[0]) onHeard({ text: result[0].transcript.trim(), final: result.isFinal });
  };
  recognition.onerror = (event) => {
    error = event.error;
  };
  recognition.onend = () => onEnd(error);
  try {
    recognition.start();
  } catch {
    onEnd("start");
  }
  return () => recognition.abort();
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

function currentVoice(): SpeechSynthesisVoice | null {
  const voices = englishVoices();
  const saved = chosenVoiceName();
  return voices.find((voice) => voice.name === saved) ?? voices[0] ?? null;
}

// Pe iPhone vocea pornește doar după o atingere: o frază goală la prima atingere o deblochează.
export function primeSpeech() {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth) return;
  synth.cancel();
  synth.speak(new SpeechSynthesisUtterance(""));
}

let finishCurrent: (() => void) | null = null;

export function stopSpeaking() {
  window.speechSynthesis?.cancel();
  // Unele browsere nu anunță sfârșitul frazelor anulate; închidem noi promisiunea.
  finishCurrent?.();
}

// Citește textul propoziție cu propoziție (Chrome taie frazele lungi de peste 15 secunde).
export function speak(text: string): Promise<void> {
  const synth = window.speechSynthesis;
  if (!synth || !text.trim()) return Promise.resolve();
  const voice = currentVoice();
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
        utterance.lang = "en-US";
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
