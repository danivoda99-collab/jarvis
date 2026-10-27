// Vocea și auzul lui Argus prin OpenAI: transcriere în română și voce în engleză.
// Modelele și vocea se pot schimba din Vercel fără cod nou.

// marin și cedar sunt cele mai noi și mai naturale; restul rămân de încercat.
export const OPENAI_VOICES = ["cedar", "marin", "ash", "echo", "onyx", "ballad", "verse", "sage", "fable", "alloy", "coral", "nova", "shimmer"];

export const STT_MODEL = process.env.OPENAI_STT_MODEL || "gpt-4o-transcribe";
// Auzul instant folosește același model ca auzul normal (mai precis în română); se poate schimba din Vercel.
export const REALTIME_STT_MODEL = process.env.OPENAI_REALTIME_STT_MODEL || "gpt-4o-transcribe";
// Vocile ElevenLabs (mai fluide în română); apar în listă doar dacă ELEVENLABS_API_KEY e în Vercel.
export const ELEVEN_VOICES: Record<string, string> = {
  "ElevenLabs · JARVIS (vocea ta)": "4oVaL1VMKFtdfA1dQPol",
  "ElevenLabs · Alex (română)": "xHIzJ4zBhlGcvJscsdON",
};
export const ELEVEN_MODEL = process.env.ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5";

export function elevenKey(): string | null {
  return process.env.ELEVENLABS_API_KEY || null;
}

export const TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";

export function defaultVoice(): string {
  return process.env.OPENAI_TTS_VOICE || "ash";
}

export const TTS_STYLE =
  process.env.OPENAI_TTS_STYLE ||
  "Voice: a refined British AI butler, like JARVIS. Calm, warm and confident, with a light touch of dry wit. Natural pace, crisp diction, never robotic.";

export const TTS_STYLE_RO =
  process.env.OPENAI_TTS_STYLE_RO ||
  "Speak Romanian with a natural, native Romanian accent and correct Romanian pronunciation. Voice: a refined AI butler, like JARVIS. Calm, warm and confident, with a light touch of dry wit. Natural pace, never robotic.";

export function openaiKey(): string | null {
  return process.env.OPENAI_API_KEY || null;
}

export function openaiError(status: number): string {
  if (status === 401) return "Cheia OpenAI nu e validă. Verific-o în Vercel.";
  if (status === 429) return "Creditul OpenAI s-a terminat sau sunt prea multe cereri.";
  return `OpenAI a răspuns cu eroare ${status}.`;
}
