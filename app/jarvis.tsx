"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type Anthropic from "@anthropic-ai/sdk";
import Hud, { type HudState } from "./hud";
import CardStack, { Linked, type Answer, type Card } from "./cards";
import Orb, { type Module, type OrbHandle } from "./orb";
import WindowLinks from "./links";
import { blipSound, bootSound } from "./sounds";
import type { Cerere } from "@/lib/cereri";
import { budgetVizual, cleanVizual, pointsFromText, unbudgeted } from "@/lib/vizual";
import {
  canListen,
  chooseVoice,
  chosenVoiceName,
  chooseFastHearing,
  closeMic,
  releaseAudio,
  fastHearing,
  fastHearingStatus,
  englishVoices,
  isUserTalking,
  listenOnce,
  openMic,
  preloadPhrase,
  primeSpeech,
  setCloudVoice,
  speak,
  speakStream,
  chooseLanguage,
  spokenLanguage,
  voiceCheckDone,
  splitReply,
  stopSpeaking,
  watchVoice,
  type Language,
} from "./voice";

type Line = { role: "user" | "agent"; text: string; at: string };

const MODULES: { name: string; ready: boolean; google?: boolean }[] = [
  { name: "Voce (Claude)", ready: true },
  { name: "Ferestre", ready: true },
  { name: "Agendă", ready: true, google: true },
  { name: "Listă to-do", ready: true, google: true },
  { name: "Buget", ready: true, google: true },
  { name: "Muzică", ready: false },
];

type Phase = "idle" | "listening" | "thinking" | "speaking";
type Message = Anthropic.Beta.BetaMessageParam;

const GREETING = {
  spoken: "Hello Daniel, Argus online. What are we breaking today?",
  ro: "Salut, Daniel! Argus e aici. Cu ce rupem topurile azi?",
};
const greetingFor = (language: Language) => (language === "ro" ? GREETING.ro : GREETING.spoken);
const GREETED_KEY = "argus-salutat-la";
const GREET_EVERY_MS = 15 * 60 * 1000; // salută o dată la 15 minute; între timp ascultă direct
// Iconița Echipa: Daniel alege ce vede din ultima săptămână încheiată (sâmbătă–vineri); nimic nu vine zilnic.
const TEAM_VIEWS = [
  { label: "Tel party", ask: "Raport echipă, Tel party pe ultima săptămână încheiată: activitatea fiecăruia față de tel." },
  { label: "Închideri", ask: "Raport echipă, închideri pe ultima săptămână încheiată: semnate și plătite, pe fiecare." },
  { label: "Amândouă", ask: "Raport echipă pe ultima săptămână încheiată: Tel party față de tel și închiderile, pe fiecare." },
];
const VOICE_CHECK = { en: "Voice check. Argus online.", ro: "Test de voce. Argus e aici." };
const MAX_MESSAGES = 80; // peste atât, conversația o ia de la capăt

// Partea din <spoken>…</spoken> scrisă până acum și dacă s-a încheiat.
function spokenPart(text: string): { body: string; closed: boolean } | null {
  const start = text.indexOf("<spoken>");
  if (start < 0) return null;
  const rest = text.slice(start + "<spoken>".length);
  const end = rest.indexOf("</spoken>");
  if (end >= 0) return { body: rest.slice(0, end), closed: true };
  // Un „</spo” început nu se citește cu voce.
  const partialTag = rest.lastIndexOf("<");
  return { body: partialTag >= 0 ? rest.slice(0, partialTag) : rest, closed: false };
}

type Panou = {
  intalnire: { titlu: string; inceput: string } | null;
  buget: { procent: number; ramas: number; liber?: number; deplata?: number; bani?: number } | null;
  sarcini: { ramase: number; azi: number } | null;
  echipa: { raportat: number; total: number; subTel?: number; analize?: number; tel?: number; actualizat: string } | null;
};

// „13:00”, „mâine 09:30” sau „joi 10:00”, după cât de departe e întâlnirea.
function meetingWhen(iso: string): string {
  const zone = { timeZone: "Europe/Bucharest" } as const;
  const day = (date: Date) => date.toLocaleDateString("en-CA", zone);
  const start = new Date(iso);
  const time = start.toLocaleTimeString("ro-RO", { ...zone, hour: "2-digit", minute: "2-digit" });
  if (day(start) === day(new Date())) return time;
  if (day(start) === day(new Date(Date.now() + 86_400_000))) return `mâine ${time}`;
  return `${start.toLocaleDateString("ro-RO", { ...zone, weekday: "short" })} ${time}`;
}

function awayText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} ore`;
  return `${Math.round(minutes / 1440)} zile`;
}

// Unde se termină ultima propoziție completă (după . ! ? urmat de spațiu).
function lastSentenceEnd(text: string): number {
  let cut = 0;
  for (const match of text.matchAll(/[.!?…]+\s/g)) cut = (match.index ?? 0) + match[0].length;
  return cut;
}

// Ce s-a vorbit (doar textul, fără unelte) stă în memoria comună de pe server, ca Argus să continue de unde
// ați rămas pe orice dispozitiv. Copia de pe telefon ajută când serverul nu răspunde.
const MEMORY_KEY = "argus-memorie";
const MEMORY_KEEP = 24; // ultimele 12 schimburi
function cleanMemory(saved: { role: "user" | "assistant"; content: string }[]): Message[] {
  const messages = saved.filter((item) => typeof item.content === "string" && item.content);
  while (messages.length && messages[0].role !== "user") messages.shift();
  return messages.at(-1)?.role === "assistant" ? messages : [];
}
function loadMemory(): Message[] {
  try {
    return cleanMemory(JSON.parse(localStorage.getItem(MEMORY_KEY) ?? "[]"));
  } catch {
    return [];
  }
}
// Memoria pentru instrucțiunile lui Argus, luată o dată pe conversație (ca instrucțiunile să nu se schimbe la mijloc).
let memorySnapshot: string | undefined;
function stripThinking(messages: Message[]) {
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      message.content = message.content.filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking");
    }
  }
}
async function fetchMemory(): Promise<Message[]> {
  try {
    const response = await fetch("/api/memorie", { cache: "no-store" });
    if (response.ok) {
      const { conversatie = [], prompt } = (await response.json()) as { conversatie?: Message[]; prompt?: string };
      memorySnapshot = typeof prompt === "string" ? prompt : undefined;
      const messages = cleanMemory(conversatie as { role: "user" | "assistant"; content: string }[]);
      if (messages.length) return messages;
    }
  } catch {
    // folosim copia de pe telefon
  }
  return loadMemory();
}
function remember(user: string, assistant: string) {
  void fetch("/api/memorie", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, assistant }),
  }).catch(() => undefined);
  try {
    const messages = [
      ...loadMemory(),
      { role: "user", content: user },
      { role: "assistant", content: assistant },
    ].slice(-MEMORY_KEEP);
    localStorage.setItem(MEMORY_KEY, JSON.stringify(messages));
  } catch {
    // fără copie locală
  }
}
// Fiecare cerere și rezultatul ei ajung în jurnal (Redis + Sheet-ul „Argus – jurnal”).
function journal(sursa: string, cerere: string, rezultat: string) {
  void fetch("/api/jurnal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sursa, cerere, rezultat }),
  }).catch(() => undefined);
}
const MAX_STEPS = 8; // câte runde de unelte poate face Argus pentru o singură cerere
const QUIET_ROUNDS = 3; // după atâtea ascultări fără nimic spus, Argus se oprește
const DRIVING_QUIET_ROUNDS = 15; // în mașină ascultă mai mult (cam două minute) înainte să se oprească
// În mașină, cu „Argus” ca cuvânt de trezire: după ascultarea obișnuită, așteaptă să fie strigat (cel mult o oră).
const WAKE_KEY = "argus-trezire";
const STANDBY_MS = 60 * 60_000;
// Brief-ul de dimineață din oficiu: prima deschidere dintre 5 și 11, o dată pe zi.
const BRIEF_KEY = "argus-brief-auto";
const MORNING_MUSIC_KEY = "argus-muzica-dimineata";
// Întreruperea cu vocea (în test): cât vorbește Argus, dacă Daniel începe să vorbească, Argus tace și ascultă.
const BARGE_KEY = "argus-intrerupe";
const BRIEF_DAY_KEY = "argus-brief-zi";

function briefDue(): boolean {
  try {
    if (localStorage.getItem(BRIEF_KEY) !== "1") return false;
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bucharest", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
    const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
    const hour = Number(part("hour"));
    const day = `${part("year")}-${part("month")}-${part("day")}`;
    if (hour < 5 || hour >= 11 || localStorage.getItem(BRIEF_DAY_KEY) === day) return false;
    localStorage.setItem(BRIEF_DAY_KEY, day);
    return true;
  } catch {
    return false;
  }
}
const WAKE_WORD = /^\W*(?:hei|hey|bun[ăa])?\W*argus\b[\s,.!?:;-]*/i;

const PROJECT_STATE: Record<Cerere["status"], { label: string; tone: "active" | "wait" | "done" | "fail" }> = {
  nouă: { label: "În așteptare", tone: "active" },
  "în lucru": { label: "Lucrează", tone: "active" },
  confirmată: { label: "Trimite", tone: "active" },
  "așteaptă confirmare": { label: "Așteaptă „Da”", tone: "wait" },
  gata: { label: "Gata", tone: "done" },
  eroare: { label: "N-a mers", tone: "fail" },
  refuzată: { label: "Refuzată", tone: "fail" },
};

function sinceText(iso: string) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "acum";
  if (minutes < 60) return `acum ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `acum ${hours} h`;
  return new Date(iso).toLocaleDateString("ro-RO", { timeZone: "Europe/Bucharest", day: "numeric", month: "short" });
}

export default function Jarvis({ googleConnected = false, spotifyConnected = false }: { googleConnected?: boolean; spotifyConnected?: boolean }) {
  return <Assistant googleConnected={googleConnected} spotifyConnected={spotifyConnected} />;
}

function nowLine() {
  const now = new Date();
  const date = now.toLocaleDateString("ro-RO", { timeZone: "Europe/Bucharest", weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const time = now.toLocaleTimeString("ro-RO", { timeZone: "Europe/Bucharest", hour: "2-digit", minute: "2-digit" });
  const iso = now.toLocaleDateString("sv-SE", { timeZone: "Europe/Bucharest" });
  return `[Acum: ${date} (${iso}), ora ${time}, ora României]`;
}

// Pe iPhone, aplicația pusă deoparte își îngheață cronometrele și ceasul rămânea la ora de atunci:
// îl aducem la zi imediat ce aplicația revine în față, iar cronometrul pornește din nou de fiecare dată.
function useClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | undefined;
    const tick = () => setNow(new Date());
    const start = () => {
      tick();
      if (id) clearInterval(id);
      id = setInterval(tick, 1000);
    };
    const wake = () => {
      if (document.visibilityState === "visible") start();
    };
    start();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", start);
    window.addEventListener("pageshow", start);
    return () => {
      if (id) clearInterval(id);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", start);
      window.removeEventListener("pageshow", start);
    };
  }, []);
  return now;
}

function timeOf(date: Date) {
  return date.toLocaleTimeString("ro-RO", { timeZone: "Europe/Bucharest", hour: "2-digit", minute: "2-digit" });
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asText).filter(Boolean);
  // Uneori modelul trimite lista ca text, câte un element pe rând.
  return asText(value)
    .split("\n")
    .map((item) => item.replace(/^[-•*\d.)\s]+/, "").trim())
    .filter(Boolean);
}

// Doar un „da” sau „nu” clar contează; orice altceva lasă fereastra deschisă.
function spokenAnswer(message: string): Answer | null {
  const words = message
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  // „Argus, accept” / „Argus, refuz” sunt frazele clare; numele poate fi auzit și „Argos” sau lipsi.
  if (words[0]?.startsWith("arg")) words.shift();
  if (words.length === 0 || words.length > 4) return null;
  if (words.some((word) => ["nu", "anuleaza", "refuz", "refuza"].includes(word))) return "nu";
  if (["accept", "accepta", "accepte"].includes(words[0])) return "da";
  if (words[0] === "da" || (words[0] === "confirm" && words.length === 1)) return "da";
  return null;
}

const CONFIRM_TIMEOUT_MS = 90_000;

// Din ce modul vine o fereastră, ca să pornească din cuvântul potrivit de pe sferă.
function guessModule(...texts: string[]): Module | undefined {
  const text = texts.join(" ").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/buget|cheltui|\blei\b|ron\b/.test(text)) return "buget";
  if (/mail|inbox|gmail/.test(text)) return "gmail";
  if (/agend|intaln|sedint|calendar|eveniment/.test(text)) return "agenda";
  if (/sarcin|to-?do|de facut|priorit/.test(text)) return "sarcini";
  return undefined;
}

function asModule(value: unknown): Module | undefined {
  const text = asText(value).toLowerCase();
  return (["agenda", "sarcini", "buget", "gmail"] as const).find((module) => module === text);
}

// Trimite eroarea la server o singură dată pe minut pentru același text, ca o buclă să nu umple coada.
const reported = new Map<string, number>();
function reportError(message: string, where: string) {
  const now = Date.now();
  if ((reported.get(message) ?? 0) > now - 60_000) return;
  reported.set(message, now);
  void fetch("/api/eroare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mesaj: message.slice(0, 400), unde: where, aparat: navigator.userAgent.slice(0, 120) }),
  }).catch(() => {});
}

function Assistant({ googleConnected, spotifyConnected }: { googleConnected: boolean; spotifyConnected: boolean }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const answers = useRef(new Map<string, (answer: Answer | "fără răspuns") => void>());
  const [error, setError] = useState("");
  const hudRef = useRef<HTMLButtonElement>(null);
  const orbRef = useRef<OrbHandle>(null);
  const levelRef = useRef(0);
  const [use2d, setUse2d] = useState(false);
  const [working, setWorking] = useState(0);
  const [armed, setArmed] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const meterRef = useRef<HTMLSpanElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const now = useClock();
  const [googleNotice, setGoogleNotice] = useState("");

  // Auzul instant: starea se citește din telefon și se reîmprospătează, ca Daniel să vadă dacă merge.
  useEffect(() => {
    setFastOn(fastHearing());
    try {
      wakeWordRef.current = localStorage.getItem(WAKE_KEY) === "1";
      setWakeWord(wakeWordRef.current);
      setBriefAuto(localStorage.getItem(BRIEF_KEY) === "1");
      setBargeIn(localStorage.getItem(BARGE_KEY) === "1");
    } catch {
      // implicit oprit
    }
    const timer = setInterval(() => setFastStatus(fastHearingStatus()), 3000);
    return () => clearInterval(timer);
  }, []);

  // Orice eroare văzută aici ajunge și la Argus de pe laptop, care o verifică singur și îl anunță pe Daniel doar dacă e nevoie de el.
  useEffect(() => {
    if (error) reportError(error, "conversație");
  }, [error]);
  useEffect(() => {
    // „Script error.” vine din scripturi străine fără detalii; nu ajută pe nimeni.
    const onError = (event: ErrorEvent) => {
      if (event.message && !/^script error\.?$/i.test(event.message)) reportError(event.message, "cod");
    };
    const onRejection = (event: PromiseRejectionEvent) =>
      reportError(event.reason instanceof Error ? event.reason.message : String(event.reason ?? "promisiune respinsă"), "cod");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // Mesajul de după conectarea la Google (?google=conectat).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("google");
    const music = params.get("spotify");
    if (!result && !music) return;
    if (result) {
      setGoogleNotice(
        result === "conectat"
          ? "Google e conectat. Argus îți vede acum agenda și lista de to-do."
          : "Conectarea la Google n-a mers. Mai încearcă.",
      );
    } else {
      setGoogleNotice(
        music === "conectat"
          ? "Spotify e conectat. Spune-i lui Argus „pune muzică” sau ce vrei să asculți."
          : "Conectarea la Spotify n-a mers. Mai încearcă.",
      );
    }
    window.history.replaceState(null, "", "/");
  }, []);

  function addCard(card: Card) {
    setCards((previous) => [...previous.filter((item) => item.kind === "confirm"), card].slice(-4));
    // Pe iPhone orice sunet al paginii oprește Spotify: semnalul se aude doar în conversație.
    if (activeRef.current) blipSound();
  }

  function closeCard(id: string) {
    setCards((previous) => previous.filter((card) => card.id !== id));
  }

  function settle(id: string, answer: Answer | "fără răspuns") {
    answers.current.get(id)?.(answer);
    answers.current.delete(id);
    closeCard(id);
    // Ce a prins microfonul cât era deschisă fereastra nu e o cerere nouă: îl aruncăm și ascultăm din nou.
    if (activeRef.current && phaseRef.current === "listening") {
      stopListening();
      setTimeout(listen, 150);
    }
  }

  // Afișează o fereastră Da/Nu și așteaptă atingerea lui Daniel.
  function confirm(title: string, details: string, recipient?: string, module?: Module, table?: string[][]) {
    const id = crypto.randomUUID();
    addCard({ id, kind: "confirm", title, details, recipient, table, module: module ?? guessModule(title, details) });
    return new Promise<Answer | "fără răspuns">((resolve) => {
      const timer = setTimeout(() => settle(id, "fără răspuns"), CONFIRM_TIMEOUT_MS);
      answers.current.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
    });
  }

  async function callApi(path: string, method = "GET", body?: unknown): Promise<string> {
    // Cât timp Argus caută sau scrie ceva, sfera trece pe „lucrează” și scanează.
    setWorking((count) => count + 1);
    orbRef.current?.scan();
    try {
      const response = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
      const data = (await response.json()) as { ok?: boolean; error?: string; deschide?: string; piesa?: string };
      if (path === "/api/spotify" && data.deschide) lastSpotifyOpenRef.current = { uri: data.deschide, piesa: data.piesa };
      if (!response.ok) return `Eroare: ${data.error ?? response.status}`;
      // După o schimbare în to-do, buget sau agendă, cifrele din jurul sferei se iau din nou, nu la 5 minute.
      if (method !== "GET" && /^\/api\/(sarcini|buget|agenda)/.test(path)) setTimeout(() => panouReloadRef.current(), 600);
      return data.ok && Object.keys(data).length === 1 ? "Gata, făcut." : JSON.stringify(data);
    } catch {
      return "Eroare: nu am putut ajunge la server.";
    } finally {
      setWorking((count) => count - 1);
    }
  }

  // Ce se face fără confirmare (to-do, buget, agenda personală) apare după aceea într-o fereastră, ca să se vadă.
  function shown(result: string, title: string, text: string, module: Module, table?: string[][]) {
    if (!result.startsWith("Eroare")) addCard({ id: crypto.randomUUID(), kind: "summary", title, text, table, module });
    return result;
  }

  // Unelte pe care agentul ARGUS le cheamă ca să arate ferestre pe ecran.
  const clientTools = {
    memorie_noteaza: (parameters: { fapt?: unknown }) => {
      const fact = asText(parameters.fapt);
      if (!fact) return "Lipsește faptul.";
      return callApi("/api/memorie", "POST", { fapt: fact });
    },
    memorie_uita: async (parameters: { fapt?: unknown }) => {
      const fact = asText(parameters.fapt);
      if (!fact) return "Lipsește faptul.";
      const answer = await confirm("Uit asta?", fact);
      if (answer !== "da") return "Daniel nu a confirmat. Faptul rămâne în memorie.";
      return callApi("/api/memorie", "DELETE", { fapt: fact });
    },
    arata_rezumat: (parameters: { titlu?: unknown; text?: unknown; puncte?: unknown; modul?: unknown }) => {
      const title = asText(parameters.titlu) || "Rezumat";
      const text = asText(parameters.text);
      addCard({
        id: crypto.randomUUID(),
        kind: "summary",
        title,
        text,
        points: asList(parameters.puncte),
        module: asModule(parameters.modul) ?? guessModule(title, text),
      });
      return "Rezumatul e afișat pe ecran.";
    },
    // Grafice, bare de progres, cifre mari, tabele sau o imagine, după ce cere Daniel.
    arata_vizual: (parameters: { titlu?: unknown; text?: unknown; modul?: unknown } & Record<string, unknown>) => {
      const title = asText(parameters.titlu) || "Rezumat";
      const text = asText(parameters.text);
      const vizual = cleanVizual(parameters);
      if (!vizual) return "Eroare: n-am primit date de afișat (puncte, cifre, progres, bare, linie, tabel sau imagine).";
      addCard({
        id: crypto.randomUUID(),
        kind: "summary",
        title,
        text,
        vizual,
        module: asModule(parameters.modul) ?? guessModule(title, text),
      });
      return "Fereastra cu graficul e pe ecran.";
    },
    arata_lista: (parameters: { titlu?: unknown; elemente?: unknown; modul?: unknown }) => {
      const title = asText(parameters.titlu) || "Listă";
      const items = asList(parameters.elemente);
      addCard({
        id: crypto.randomUUID(),
        kind: "list",
        title,
        items,
        module: asModule(parameters.modul) ?? guessModule(title, items.slice(0, 3).join(" ")),
      });
      return "Lista e afișată pe ecran.";
    },
    cere_confirmare: async (parameters: { titlu?: unknown; detalii?: unknown; destinatar?: unknown }) => {
      const answer = await confirm(
        asText(parameters.titlu) || "Confirmi?",
        asText(parameters.detalii),
        asText(parameters.destinatar) || undefined,
      );
      return answer === "da"
        ? "Daniel a apăsat Da."
        : answer === "nu"
          ? "Daniel a apăsat Nu. Nu face acțiunea."
          : "Daniel nu a răspuns. Nu face acțiunea.";
    },
    agenda_citeste: (parameters: { de_la?: unknown; pana_la?: unknown }) => {
      const query = new URLSearchParams();
      if (asText(parameters.de_la)) query.set("de_la", asText(parameters.de_la));
      if (asText(parameters.pana_la)) query.set("pana_la", asText(parameters.pana_la));
      return callApi(`/api/agenda?${query}`);
    },
    agenda_adauga: async (parameters: { titlu?: unknown; inceput?: unknown; sfarsit?: unknown; descriere?: unknown }) => {
      const title = asText(parameters.titlu);
      const start = asText(parameters.inceput);
      const end = asText(parameters.sfarsit);
      const when = [start, end].filter(Boolean).map((value) => value.replace("T", " ")).join(" – ");
      const result = await callApi("/api/agenda", "POST", {
        titlu: title,
        inceput: start,
        sfarsit: end || undefined,
        descriere: asText(parameters.descriere) || undefined,
      });
      return shown(result, "Adăugat în agendă", `${title}\n${when}`, "agenda");
    },
    agenda_modifica: async (parameters: {
      id?: unknown;
      titlu_actual?: unknown;
      titlu?: unknown;
      inceput?: unknown;
      sfarsit?: unknown;
      descriere?: unknown;
    }) => {
      const title = asText(parameters.titlu);
      const start = asText(parameters.inceput);
      const end = asText(parameters.sfarsit);
      const description = asText(parameters.descriere);
      const changes = [
        title && `Titlu nou: ${title}`,
        start && `Început: ${start.replace("T", " ")}`,
        end && `Sfârșit: ${end.replace("T", " ")}`,
        description && `Descriere: ${description}`,
      ].filter(Boolean);
      const details = [asText(parameters.titlu_actual) || "Evenimentul ales", ...changes].join("\n");
      const answer = await confirm("Modific în agendă?", details, undefined, "agenda");
      if (answer !== "da") return "Daniel nu a confirmat. Evenimentul NU a fost modificat.";
      return callApi("/api/agenda", "PATCH", {
        id: asText(parameters.id),
        titlu: title || undefined,
        inceput: start || undefined,
        sfarsit: end || undefined,
        descriere: description || undefined,
      });
    },
    agenda_sterge: async (parameters: { id?: unknown; titlu?: unknown; cand?: unknown }) => {
      const details = [asText(parameters.titlu) || "Evenimentul ales", asText(parameters.cand)].filter(Boolean).join("\n");
      const answer = await confirm("Șterg din agendă?", `${details}\nRămâne 30 de zile în Coșul calendarului.`, undefined, "agenda");
      if (answer !== "da") return "Daniel nu a confirmat. Evenimentul NU a fost șters.";
      return callApi("/api/agenda", "DELETE", { id: asText(parameters.id) });
    },
    sarcini_citeste: () => callApi("/api/sarcini"),
    sarcini_adauga: async (parameters: { titlu?: unknown; scadenta?: unknown; notite?: unknown }) => {
      const title = asText(parameters.titlu);
      const due = asText(parameters.scadenta);
      const result = await callApi("/api/sarcini", "POST", {
        titlu: title,
        scadenta: due || undefined,
        notite: asText(parameters.notite) || undefined,
      });
      return shown(result, "Adăugat în to-do", due ? `${title}\nScadență: ${due}` : title, "sarcini");
    },
    sarcini_bifeaza: async (parameters: { id?: unknown; titlu?: unknown }) => {
      const result = await callApi("/api/sarcini", "PATCH", { id: asText(parameters.id) });
      return shown(result, "Bifat ca făcut", asText(parameters.titlu) || "Sarcina aleasă", "sarcini");
    },
    sarcini_modifica: async (parameters: {
      id?: unknown;
      titlu_actual?: unknown;
      titlu?: unknown;
      scadenta?: unknown;
      notite?: unknown;
    }) => {
      const title = asText(parameters.titlu);
      const due = asText(parameters.scadenta);
      const notes = asText(parameters.notite);
      const changes = [title && `Titlu nou: ${title}`, due && `Scadență: ${due}`, notes && `Notițe: ${notes}`].filter(Boolean);
      if (changes.length === 0) return "Nu ai dat nicio schimbare.";
      const details = [asText(parameters.titlu_actual) || "Sarcina aleasă", ...changes].join("\n");
      const result = await callApi("/api/sarcini", "PATCH", {
        id: asText(parameters.id),
        titlu: title || undefined,
        scadenta: due || undefined,
        notite: notes || undefined,
      });
      return shown(result, "Modificat în to-do", details, "sarcini");
    },
    // Gmail, Contacte, Drive: doar citire, direct din aplicație (fără laptop).
    mail_citeste: async (parameters: { cauta?: unknown; max?: unknown }) => {
      const query = new URLSearchParams();
      if (asText(parameters.cauta)) query.set("cauta", asText(parameters.cauta));
      if (typeof parameters.max === "number") query.set("max", String(parameters.max));
      const raw = await callApi(`/api/mail?${query}`);
      if (raw.startsWith("Eroare")) return raw;
      const { mailuri = [] } = JSON.parse(raw) as { mailuri?: { de_la: string; subiect: string; data: string; necitit: boolean }[] };
      if (mailuri.length) {
        const sender = (from: string) => from.replace(/<[^>]*>/g, "").replace(/"/g, "").trim() || from;
        const when = (date: string) => {
          const value = new Date(date);
          return Number.isNaN(value.getTime())
            ? ""
            : value.toLocaleString("ro-RO", { timeZone: "Europe/Bucharest", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
        };
        addCard({
          id: crypto.randomUUID(),
          kind: "summary",
          title: `Mailuri (${mailuri.length})`,
          // Unul sub altul, necititele sus, ca pe telefon să nu stea coloanele înghesuite.
          vizual: cleanVizual({
            puncte: mailuri.slice(0, 8).map((mail) => ({
              titlu: sender(mail.de_la),
              text: [mail.subiect, when(mail.data)].filter(Boolean).join(" · "),
              nivel: mail.necitit ? "important" : "info",
            })),
          }),
          module: "gmail",
        });
      }
      return raw;
    },
    mail_deschide: (parameters: { id?: unknown }) => callApi(`/api/mail?id=${encodeURIComponent(asText(parameters.id))}`),
    contacte_cauta: (parameters: { cauta?: unknown }) => callApi(`/api/contacte?cauta=${encodeURIComponent(asText(parameters.cauta))}`),
    fisiere_cauta: (parameters: { cauta?: unknown }) => callApi(`/api/fisiere?cauta=${encodeURIComponent(asText(parameters.cauta))}`),
    spotify: async (parameters: { actiune?: unknown; ce?: unknown; tip?: unknown; valoare?: unknown }) => {
      const action = asText(parameters.actiune);
      if (action === "ce_canta") return callApi("/api/spotify");
      // Daniel a cerut ceva anume de la muzică: nu o mai pornim singuri la final.
      musicPausedRef.current = false;
      const raw = await callApi("/api/spotify", "POST", {
        actiune: action,
        ce: asText(parameters.ce),
        tip: asText(parameters.tip) || undefined,
        valoare: typeof parameters.valoare === "number" ? parameters.valoare : undefined,
      });
      if (action === "pune" && !raw.startsWith("Eroare")) musicOnRef.current = true;
      if (lastSpotifyOpenRef.current) {
        // Spotify „adormit” pe iPhone: îl deschidem direct pe ce s-a cerut; conversația se închide după răspuns.
        // Conversația se închide acum, fără să mai vorbească: altfel, la întoarcerea în Argus, ar vorbi și ar opri muzica.
        const { uri, piesa } = lastSpotifyOpenRef.current;
        lastSpotifyOpenRef.current = null;
        end();
        log("agent", `Am deschis Spotify${piesa ? ` cu ${piesa}` : ""}.`);
        window.location.href = uri;
        return "Spotify s-a deschis pe telefon. Nu mai spune nimic.";
      }
      return raw;
    },
    nu_deranja: async (parameters: { minute?: unknown }) => {
      const raw = await callApi("/api/nu-deranja", "POST", { minute: Number(parameters.minute) || 0 });
      if (raw.startsWith("Eroare")) return raw;
      const data = JSON.parse(raw) as { pana?: string | null; amanate?: { titlu: string; text: string }[] };
      if (data.pana) return `Liniște până la ${timeOf(new Date(data.pana))}. Spune doar, scurt, până la ce oră.`;
      return data.amanate?.length
        ? `Liniștea s-a oprit. Au venit între timp: ${data.amanate.map((item) => `${item.titlu}: ${item.text}`).join(" | ")}. Spune-le pe scurt.`
        : "Liniștea s-a oprit și n-a venit nimic între timp.";
    },
    // Imaginea se face pe server (OpenAI) și apare direct într-o fereastră; pe iPhone se salvează ținând apăsat pe ea.
    imagine_creeaza: async (parameters: { descriere?: unknown; format?: unknown; titlu?: unknown }) => {
      const raw = await callApi("/api/imagine", "POST", { descriere: asText(parameters.descriere), format: asText(parameters.format) || undefined });
      if (raw.startsWith("Eroare")) return raw;
      const data = JSON.parse(raw) as { imagine?: string };
      if (!data.imagine) return "Eroare: n-a venit nicio imagine.";
      addCard({
        id: crypto.randomUUID(),
        kind: "summary",
        title: asText(parameters.titlu) || "Imaginea ta",
        text: "Ține apăsat pe imagine ca s-o salvezi în Poze.",
        vizual: { imagine: data.imagine },
      });
      return "Imaginea e pe ecran. Spune doar, scurt, că e gata.";
    },
    // Waze și apelurile pleacă din aplicație; iPhone-ul întreabă singur înainte de apel.
    navigheaza: (parameters: { destinatie?: unknown }) => {
      const place = asText(parameters.destinatie);
      if (!place) return "Lipsește destinația.";
      setTimeout(() => window.location.assign(`https://waze.com/ul?q=${encodeURIComponent(place)}&navigate=yes`), 300);
      return `Waze se deschide spre ${place}. Nu mai adăuga nimic.`;
    },
    suna: (parameters: { numar?: unknown; nume?: unknown }) => {
      const number = asText(parameters.numar).replace(/[^\d+]/g, "");
      if (number.replace(/\D/g, "").length < 6) return "Numărul nu pare bun. Caută-l cu contacte_cauta.";
      setTimeout(() => window.location.assign(`tel:${number}`), 300);
      return `Apelul către ${asText(parameters.nume) || number} pornește; iPhone-ul cere confirmarea. Nu mai adăuga nimic.`;
    },
    fisier_citeste: (parameters: { id?: unknown }) => callApi(`/api/fisiere?id=${encodeURIComponent(asText(parameters.id))}`),
    buget_categorii: () => callApi("/api/buget"),
    // Cât s-a cheltuit luna asta pe fiecare categorie, față de buget: tabel pe ecran, rezumat cu voce.
    buget_situatie: async () => {
      const raw = await callApi("/api/buget?situatie=1");
      if (raw.startsWith("Eroare")) return raw;
      const data = JSON.parse(raw) as { luna?: string; tabel?: string[][]; venit?: string };
      if (data.tabel && data.tabel.length > 1) {
        // Bare pentru toate categoriile cu buget (cele aproape de limită sus), apoi cheltuielile fără buget; tabelul întreg doar dacă nu se pot citi cifrele.
        const vizual = budgetVizual(data.tabel, data.venit);
        addCard({
          id: crypto.randomUUID(),
          kind: "summary",
          title: `Buget ${data.luna ?? ""}`.trim(),
          vizual,
          table: vizual ? unbudgeted(data.tabel) : data.tabel,
          module: "buget",
        });
      }
      return `${raw}\nBarele de progres sunt pe ecran, cu toate categoriile. Spune pe scurt: bani rămași (venit − cheltuit), cât mai are de plătit din buget, cât rămâne liber după plăți și ce categorii au depășit. „Rămas” din Total e doar buget − cheltuit, nu bani; nu-l prezenta ca bani rămași.`;
    },
    buget_adauga: async (parameters: { suma?: unknown; categorie?: unknown; nota?: unknown; data?: unknown }) => {
      const amount = String(parameters.suma ?? "").trim();
      const category = asText(parameters.categorie);
      const note = asText(parameters.nota);
      const date = asText(parameters.data);
      const table = [
        ["Data", "Categorie", "Sumă", "Notă"],
        [date || "azi", category, `${amount} lei`, note || "—"],
      ];
      const result = await callApi("/api/buget", "POST", { suma: amount, categorie: category, nota: note, data: date || undefined });
      return shown(result, "Trecut în buget", "", "buget", table);
    },
    claude_trimite: async (parameters: { titlu?: unknown; cerere?: unknown }) => {
      const title = asText(parameters.titlu);
      const request = asText(parameters.cerere);
      if (!request) return "Lipsește cererea.";
      // Trimiterea către laptop nu mai cere „Da”: Claude cere o singură confirmare, la final, înainte să trimită ceva în afară.
      const result = await callApi("/api/cereri", "POST", { titlu: title, cerere: request });
      window.dispatchEvent(new Event("argus-cerere"));
      return result;
    },
    // Un mesaj gata formulat: Daniel confirmă aici, o singură dată, iar laptopul doar îl trimite.
    mesaj_trimite: async (parameters: { canal?: unknown; destinatar?: unknown; text?: unknown }) => {
      const channel = asText(parameters.canal).toLowerCase() === "mail" ? "mail" : "WhatsApp";
      const recipient = asText(parameters.destinatar);
      const text = asText(parameters.text);
      if (!recipient || !text) return "Lipsește destinatarul sau textul.";
      const title = `Trimit pe ${channel} lui ${recipient}`;
      const answer = await confirm(`${title}?`, text, recipient, channel === "mail" ? "gmail" : undefined);
      if (answer !== "da") return "Daniel nu a confirmat. Mesajul NU a fost trimis.";
      const result = await callApi("/api/cereri", "POST", {
        titlu: title,
        cerere: `${title} exact textul confirmat.`,
        confirmat: { titlu: title, text, destinatar: `${recipient} (${channel})` },
      });
      window.dispatchEvent(new Event("argus-cerere"));
      return result.startsWith("Eroare") ? result : "Trimis la laptop; Daniel aude când pleacă mesajul.";
    },
    // „Mă documentez și revin”: caută pe server, în fundal; rezultatul vine singur, cu voce.
    cerceteaza: async (parameters: { titlu?: unknown; intrebare?: unknown }) => {
      const question = asText(parameters.intrebare);
      if (!question) return "Lipsește întrebarea.";
      const result = await callApi("/api/cercetare", "POST", { titlu: asText(parameters.titlu), intrebare: question });
      window.dispatchEvent(new Event("argus-cerere"));
      return result.startsWith("Eroare") ? result : "Cercetarea a pornit în fundal. Rezultatul vine singur, cu voce. Continuă conversația.";
    },
    jurnal_citeste: () => callApi("/api/jurnal"),
    urmareste_adauga: (parameters: { ce?: unknown; conditie?: unknown; interval_ore?: unknown; zile?: unknown }) =>
      callApi("/api/urmariri", "POST", {
        ce: asText(parameters.ce),
        conditie: asText(parameters.conditie),
        interval_ore: Number(parameters.interval_ore) || undefined,
        zile: Number(parameters.zile) || undefined,
      }),
    urmareste_lista: () => callApi("/api/urmariri"),
    urmareste_opreste: (parameters: { id?: unknown }) =>
      callApi("/api/urmariri", "PATCH", { id: asText(parameters.id), stare: "oprită" }),
    claude_cereri: async () => {
      const raw = await callApi("/api/cereri");
      if (raw.startsWith("Eroare")) return raw;
      const { cereri = [] } = JSON.parse(raw) as { cereri?: Cerere[] };
      return JSON.stringify(
        cereri.slice(0, 10).map((item) => ({
          titlu: item.titlu,
          stare: item.status,
          trimisa: item.creat,
          rezultat: item.rezultat?.slice(0, 600),
        })),
      );
    },
    inchide_ferestrele: () => {
      setCards((previous) => previous.filter((card) => card.kind === "confirm"));
      return "Ferestrele sunt închise.";
    },
  };

  // „Trimite pe WhatsApp” de sub un mesaj propus (de exemplu de agentul de echipă): o singură confirmare, cu textul exact.
  const sendDraftRef = useRef<(draft: { catre: string; text: string }) => void>(() => {});
  sendDraftRef.current = (draft) => {
    void clientTools.mesaj_trimite({ canal: "WhatsApp", destinatar: draft.catre, text: draft.text });
  };
  useEffect(() => {
    const onSend = (event: Event) => {
      const draft = (event as CustomEvent<{ catre?: string; text?: string }>).detail;
      if (draft?.catre && draft.text) sendDraftRef.current({ catre: draft.catre, text: draft.text });
    };
    window.addEventListener("argus-trimite", onSend);
    return () => window.removeEventListener("argus-trimite", onSend);
  }, []);

  // Ce a făcut Claude pe laptop: rezultatele apar ca ferestre, iar ce trebuie trimis cere „Da”.
  const askedRef = useRef(new Set<string>());
  useEffect(() => {
    const SEEN_KEY = "argus-cereri-vazute";
    let stopped = false;
    let seen = "";
    try {
      seen = localStorage.getItem(SEEN_KEY) ?? new Date().toISOString();
    } catch {
      seen = new Date().toISOString();
    }
    let lastSignal = "";
    let polls = 0;
    let open = false; // o cerere e în lucru pe laptop: verificăm des, ca rezultatul să apară imediat
    let timer: ReturnType<typeof setTimeout> | undefined;
    function schedule() {
      clearTimeout(timer);
      if (!stopped) timer = setTimeout(tick, open ? 2_000 : 15_000);
    }
    async function tick() {
      await poll();
      schedule();
    }
    async function poll() {
      if (stopped || document.hidden) return;
      try {
        // O dată pe minut întrebăm și dacă laptopul e pornit.
        const withLaptop = polls++ % 4 === 0;
        const response = await fetch(`/api/cereri?semnal=1&tel=1${withLaptop ? "&laptop=1" : ""}`, { cache: "no-store" });
        if (response.ok) {
          const { semnal, laptop } = (await response.json()) as { semnal?: string; laptop?: number | null };
          if (withLaptop) setLaptopOff(typeof laptop === "number" ? laptop : null);
          if (semnal && semnal === lastSignal) return;
          lastSignal = semnal ?? "";
        }
      } catch {
        return;
      }
      let cereri: Cerere[] = [];
      try {
        const response = await fetch("/api/cereri", { cache: "no-store" });
        if (response.status === 502 || response.status === 401) {
          stopped = true; // coada nu e pornită încă
          return;
        }
        if (!response.ok) return;
        cereri = ((await response.json()) as { cereri?: Cerere[] }).cereri ?? [];
      } catch {
        return;
      }
      setProjects(cereri);
      let latest = seen;
      for (const item of [...cereri].reverse()) {
        if (item.status === "așteaptă confirmare" && item.confirmare && !askedRef.current.has(item.id)) {
          askedRef.current.add(item.id);
          log("agent", `Claude cere confirmare: ${item.titlu}`);
          const { titlu, text, destinatar, tabel } = item.confirmare;
          const decision = confirm(titlu || "Confirmi?", text, destinatar, undefined, tabel);
          void announce(titlu, text);
          void decision.then((answer) => {
            if (answer === "fără răspuns") return; // rămâne în așteptare; o revezi la următoarea deschidere
            void fetch("/api/cereri", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: item.id, status: answer === "da" ? "confirmată" : "refuzată" }),
            });
          });
        }
        if ((item.status === "gata" || item.status === "eroare") && item.actualizat > seen) {
          const title = item.status === "gata" ? `Claude a terminat: ${item.titlu}` : `Claude n-a reușit: ${item.titlu}`;
          const shaped = !item.vizual && item.status === "gata" ? pointsFromText(item.rezultat || "") : undefined;
          addCard({
            id: crypto.randomUUID(),
            kind: "summary",
            title,
            text: shaped ? shaped.text : item.rezultat || "",
            vizual: shaped ? shaped.vizual : item.vizual,
          });
          log("agent", title);
          // Prima propoziție din rezultat („Trimis lui Jess pe WhatsApp.”) se spune cu voce;
          // la o cercetare, tot primul paragraf, care e răspunsul.
          const research = item.titlu.startsWith("Cercetare:");
          const first =
            (research
              ? (item.rezultat || "").split(/\n\s*\n|\n- /)[0]?.slice(0, 500)
              : (item.rezultat || "").split(/(?<=[.!?])\s|\n/)[0]?.slice(0, 200)) || title;
          void report(item.status === "gata" ? first : `Claude n-a reușit: ${first}`);
          journal(research ? "Cercetare" : "Laptop", item.cerere, `${item.status === "gata" ? "" : "Eroare: "}${item.rezultat || ""}`);
          // Argus ține minte ce a găsit, ca Daniel să poată întreba mai departe.
          if (research && item.status === "gata" && item.rezultat) {
            remember(`(Cercetarea cerută: ${item.cerere})`, item.rezultat.slice(0, 2000));
          }
        }
        if (item.actualizat > latest) latest = item.actualizat;
      }
      seen = latest;
      open = cereri.some((item) => ["nouă", "în lucru", "confirmată"].includes(item.status));
      try {
        localStorage.setItem(SEEN_KEY, seen);
      } catch {
        // fără memorare: la următoarea deschidere pot reapărea ultimele rezultate
      }
    }
    // După ce Argus trimite o cerere, verificăm imediat și des.
    const wake = () => {
      open = true;
      void tick();
    };
    void tick();
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("argus-cerere", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("argus-cerere", wake);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [phase, setPhaseState] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const activeRef = useRef(false); // conversația e pornită
  const historyRef = useRef<Message[]>([]);

  // Aplicația instalată pe iPhone rămâne deschisă zile întregi cu codul vechi. Când revine în față și pe server
  // e o versiune nouă, se reîncarcă singură, dar doar când Argus nu vorbește și nu ascultă.
  useEffect(() => {
    let base = "";
    const check = async () => {
      try {
        const response = await fetch("/api/versiune", { cache: "no-store" });
        const { versiune } = (await response.json()) as { versiune?: string };
        if (!versiune) return;
        if (!base) base = versiune;
        else if (versiune !== base && !activeRef.current && document.visibilityState === "visible") window.location.reload();
      } catch {
        // fără rețea: verificăm data viitoare
      }
    };
    void check();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    const id = setInterval(check, 10 * 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(id);
    };
  }, []);
  const stopListenRef = useRef<() => void>(() => {});
  const listenGenRef = useRef(0); // fiecare ascultare nouă o anulează pe cea veche
  const quietRef = useRef(0);
  const silentRef = useRef(false); // când Daniel scrie, Argus răspunde doar în scris
  const cleanRef = useRef(true); // istoricul s-a încheiat normal și se poate continua
  const [heard, setHeard] = useState("");
  const [typed, setTyped] = useState("");
  const [voices, setVoices] = useState<string[]>([]);
  const [voiceName, setVoiceName] = useState("");
  const [language, setLanguage] = useState<Language>("ro");
  // „La volan”: răspunsuri foarte scurte, totul cu vocea, nimic de citit.
  const [driving, setDriving] = useState(false);
  const micRetryRef = useRef(0);
  const standbyRef = useRef(0); // când a început așteptarea cuvântului „Argus”; 0 = nu așteaptă
  const [standby, setStandby] = useState(false);
  const [wakeWord, setWakeWord] = useState(false);
  const [briefAuto, setBriefAuto] = useState(false);
  const [bargeIn, setBargeIn] = useState(false);
  const wakeWordRef = useRef(false);
  const musicPausedRef = useRef(false); // Argus a oprit Spotify la începutul conversației din mașină
  const drivingRef = useRef(false);
  const musicOnRef = useRef(false); // în runda asta Argus a pornit muzica
  const musicSeenRef = useRef({ canta: false, at: 0 }); // ultima dată când am văzut, din pagină, dacă merge muzica
  const lastSpotifyOpenRef = useRef<{ uri: string; piesa?: string } | null>(null); // Spotify adormit: ce deschidem direct
  const morningRef = useRef(false); // pornit cu ?dimineata=1: muzica se oprește cât vorbește cu Argus
  const [morningMusic, setMorningMusic] = useState("");
  const [musicButton, setMusicButton] = useState(false); // Spotify a înghețat și iPhone-ul nu l-a lăsat deschis singur
  // Adresele pentru scurtăturile din iPhone: ?masina=1 pornește modul mașină, ?asculta=1 arată „atinge oriunde”.
  const [quickStart, setQuickStart] = useState(false);
  useEffect(() => {
    let saved = false;
    try {
      saved = localStorage.getItem("argus-volan") === "1";
    } catch {
      // implicit oprit
    }
    const params = new URLSearchParams(window.location.search);
    if (params.get("masina") === "1" || params.get("mod") === "masina") {
      saved = true;
      try {
        localStorage.setItem("argus-volan", "1");
      } catch {
        // rămâne doar pentru sesiunea asta
      }
    }
    if (params.get("asculta") === "1") setQuickStart(true);
    let playlist = "";
    try {
      playlist = localStorage.getItem(MORNING_MUSIC_KEY) ?? "";
    } catch {
      // fără playlist salvat
    }
    setMorningMusic(playlist);
    // ?dimineata=1 (automatizarea „Când oprești alarma” din iPhone): pune muzica și arată „atinge oriunde” pentru brief.
    if (params.get("dimineata") === "1") {
      const ce = (params.get("playlist") ?? playlist).trim();
      morningRef.current = true;
      setQuickStart(true);
      if (spotifyConnected) {
        void fetch("/api/spotify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ce ? { actiune: "pune", ce, tip: "playlist" } : { actiune: "pune" }),
        })
          .then((response) => response.json().catch(() => null))
          .then((data: { error?: string; deschide?: string } | null) => {
            // Spotify „adormit” pe iPhone: îl deschidem direct pe playlist.
            if (data?.deschide) window.location.href = data.deschide;
            else if (data?.error) log("agent", data.error);
          })
          .catch(() => {});
      } else {
        log("agent", "Pentru muzica de dimineață, conectează întâi Spotify (butonul de jos).");
      }
    }
    if (params.has("masina") || params.has("mod") || params.has("asculta") || params.has("dimineata")) {
      params.delete("masina");
      params.delete("mod");
      params.delete("asculta");
      params.delete("dimineata");
      params.delete("playlist");
      const rest = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
    }
    drivingRef.current = saved;
    setDriving(saved);
  }, []);
  function toggleDriving() {
    const next = !drivingRef.current;
    drivingRef.current = next;
    setDriving(next);
    try {
      localStorage.setItem("argus-volan", next ? "1" : "0");
    } catch {
      // rămâne doar pentru sesiunea asta
    }
  }
  // O poză (bon, document, ceva de recunoscut), micșorată pe telefon ca să plece repede.
  const photoRef = useRef<HTMLInputElement>(null);
  async function sendPhoto(file: File) {
    if (phaseRef.current === "thinking") return;
    setError("");
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/jpeg", 0.82).split(",")[1];
      if (!data) throw new Error("fără imagine");
      const text = typed.trim() || "Uite poza asta. Dacă e un bon, trece-l în buget; dacă e un document, spune-mi pe scurt ce scrie.";
      setTyped("");
      if (!activeRef.current) {
        // Fără conversație pornită, răspunsul vine în scris, ca la mesajele scrise.
        stopSpeaking();
        silentRef.current = true;
        activeRef.current = true;
      }
      void ask(text, data);
    } catch {
      setError("Nu am putut citi poza. Mai încearcă.");
    }
  }
  const [projects, setProjects] = useState<Cerere[]>([]);
  const [projectsOpen, setProjectsOpen] = useState(false);
  // De câte minute nu mai răspunde laptopul (null = pornit).
  const [laptopOff, setLaptopOff] = useState<number | null>(null);
  // Cifrele mici din jurul sferei; se reîmprospătează la 5 minute și când revii în aplicație.
  const [panou, setPanou] = useState<Panou | null>(null);
  const [teamPick, setTeamPick] = useState(false);
  const [morningLink, setMorningLink] = useState("");
  const panouReloadRef = useRef<() => void>(() => {});
  useEffect(() => {
    let stopped = false;
    const load = () => {
      if (document.hidden) return;
      fetch("/api/panou", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((data: Panou | null) => {
          if (!stopped && data) setPanou(data);
        })
        .catch(() => {});
    };
    panouReloadRef.current = load;
    load();
    const timer = setInterval(load, 5 * 60_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);
  const [fastOn, setFastOn] = useState(false);
  const [fastStatus, setFastStatus] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false); // pe telefon, panoul Sistem se deschide din „Setări”
  // Notificările: „off” = se pot porni, „on” = pornite, „denied” = refuzate, „none” = telefonul nu le suportă aici
  // (pe iPhone merg doar din aplicația pusă pe ecranul principal).
  const [pushState, setPushState] = useState<"none" | "off" | "on" | "denied">("none");
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
    void navigator.serviceWorker
      .register("/sw.js")
      .then(async (registration) => {
        if (Notification.permission === "denied") return setPushState("denied");
        const existing = await registration.pushManager.getSubscription();
        if (existing && Notification.permission === "granted") {
          setPushState("on");
          // Abonarea se retrimite la fiecare deschidere, ca serverul s-o aibă mereu.
          void fetch("/api/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(existing) });
        } else setPushState("off");
      })
      .catch(() => undefined);
  }, []);
  async function enablePush() {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return setPushState(permission === "denied" ? "denied" : "off");
      const registration = await navigator.serviceWorker.ready;
      const { cheie } = (await (await fetch("/api/push", { cache: "no-store" })).json()) as { cheie?: string };
      if (!cheie) throw new Error("fără cheie");
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: cheie });
      const saved = await fetch("/api/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription),
      });
      if (!saved.ok) throw new Error("nesalvat");
      setPushState("on");
    } catch {
      setError("Nu am putut porni notificările. Mai încearcă.");
    }
  }
  useEffect(() => setLanguage(spokenLanguage()), []);

  function setPhase(next: Phase) {
    phaseRef.current = next;
    setPhaseState(next);
  }

  function log(role: Line["role"], text: string) {
    setLines((previous) => [...previous, { role, text, at: timeOf(new Date()) }].slice(-30));
  }

  // Vocea vine de la OpenAI dacă serverul are cheia; altfel din browser, a cărui listă apare cu întârziere.
  useEffect(() => {
    let cloud = false;
    const loadBrowser = () => {
      if (cloud) return;
      const list = englishVoices();
      setVoices(list.map((voice) => voice.name));
      setVoiceName(chosenVoiceName() || list[0]?.name || "");
    };
    loadBrowser();
    window.speechSynthesis?.addEventListener?.("voiceschanged", loadBrowser);
    fetch("/api/voce", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { cloud?: boolean; voci?: string[]; implicita?: string } | null) => {
        if (!data?.cloud || !data.voci?.length) return;
        cloud = true;
        const fallback = data.implicita || data.voci[0];
        setCloudVoice(true, fallback);
        const saved = chosenVoiceName();
        if (!data.voci.includes(saved)) chooseVoice(fallback);
        setVoices(data.voci);
        setVoiceName(data.voci.includes(saved) ? saved : fallback);
        setCanListenNow(canListen());
        preloadPhrase(greetingFor(spokenLanguage()));
      })
      .catch(() => {})
      .finally(voiceCheckDone);
    return () => window.speechSynthesis?.removeEventListener?.("voiceschanged", loadBrowser);
  }, []);

  function stopListening() {
    listenGenRef.current += 1;
    stopListenRef.current();
  }

  // Când Claude de pe laptop cere o decizie, Argus o spune pe scurt (dacă nu vorbește deja), apoi ascultă „accept” / „refuz”.
  async function announce(title: string, text: string) {
    // Dacă Argus tocmai vorbește sau se gândește, decizia așteaptă rândul (cel mult un minut), apoi se citește.
    for (let tries = 0; tries < 120 && activeRef.current && phaseRef.current !== "listening"; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!(await waitForSilence())) return;
    if (!activeRef.current || silentRef.current || phaseRef.current !== "listening") return;
    const decision = (text || title).slice(0, 300);
    await say(spokenLanguage() === "ro" ? `Am formulat așa: ${decision}` : `Here is how I put it: ${decision}`);
    if (activeRef.current && (phaseRef.current as Phase) === "speaking") {
      setPhase("listening");
      listen();
    }
  }

  // Cât vorbește Daniel, anunțurile așteaptă (cel mult o jumătate de minut), ca să nu-i taie fraza.
  async function waitForSilence() {
    for (let tries = 0; tries < 60 && isUserTalking(); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return !isUserTalking();
  }

  // Rezultatul de pe laptop se spune pe scurt, dacă Argus ascultă în acel moment.
  async function report(text: string) {
    // Dacă Argus tocmai vorbește sau se gândește, rezultatul așteaptă rândul (cel mult un minut).
    for (let tries = 0; tries < 120 && activeRef.current && phaseRef.current !== "listening"; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!(await waitForSilence())) return;
    if (!activeRef.current || silentRef.current || phaseRef.current !== "listening" || answers.current.size > 0) return;
    await say(text);
    if (activeRef.current && (phaseRef.current as Phase) === "speaking") {
      setPhase("listening");
      listen();
    }
  }

  async function say(text: string) {
    if (!activeRef.current || !text || silentRef.current) return;
    stopListening();
    setPhase("speaking");
    await speak(text);
  }

  // Ascultă cât timp conversația e pornită și Argus nu vorbește.
  // Cât e deschisă o fereastră de confirmare, ascultă doar „Argus, accept” / „Argus, refuz”.
  function listen() {
    if (!activeRef.current || silentRef.current || phaseRef.current === "speaking") return;
    const confirming = answers.current.size > 0;
    if (!confirming && phaseRef.current === "thinking") return;
    if (!confirming) setPhase("listening");
    stopListening();
    const generation = listenGenRef.current;
    let finalText = "";
    stopListenRef.current = listenOnce(
      ({ text, final }) => {
        if (generation !== listenGenRef.current) return;
        setHeard(text === "…" ? "Transcriu…" : text);
        levelRef.current = 0.6;
        // La final rămâne ce s-a auzit ultima dată; vocea se oprește singură după o pauză.
        if (final || text.length >= finalText.length) finalText = text;
      },
      (error, message) => {
        if (generation !== listenGenRef.current) return;
        setHeard("");
        if (!activeRef.current) return;
        if (error === "not-allowed" || error === "service-not-allowed") {
          setError("Am nevoie de acces la microfon. Permite-l din setările browserului și mai încearcă.");
          end();
          return;
        }
        if (error === "server") {
          // Transcrierea n-a mers: spune de ce și ascultă din nou.
          setError(message || "Nu te-am putut auzi. Mai spune o dată.");
          setTimeout(listen, 600);
          return;
        }
        // Microfonul a fost luat (un apel, Siri): îl cerem din nou o dată; dacă nu merge, oprim cu un mesaj, fără buclă.
        if (error === "start") {
          if (micRetryRef.current >= 2) {
            micRetryRef.current = 0;
            setError("Microfonul nu mai răspunde. Atinge din nou ca să pornești.");
            end();
            return;
          }
          micRetryRef.current += 1;
          void openMic().then((problem) => {
            if (!activeRef.current) return;
            if (problem) {
              setError("Microfonul nu mai răspunde. Atinge din nou ca să pornești.");
              end();
            } else setTimeout(listen, 300);
          });
          return;
        }
        micRetryRef.current = 0;
        if (error === "unsupported") {
          setError("Browserul ăsta nu știe dictare. Scrie-i lui Argus în câmpul de mai jos.");
          end();
          return;
        }
        if (finalText && answers.current.size > 0) {
          const spoken = spokenAnswer(finalText);
          const pending = [...answers.current.keys()].pop();
          if (spoken && pending) settle(pending, spoken);
          if (activeRef.current && answers.current.size > 0) setTimeout(listen, 150);
          return;
        }
        // Așteaptă „Argus”: orice altceva auzit în mașină (radio, pasageri) se lasă deoparte.
        if (standbyRef.current) {
          const called = finalText.match(WAKE_WORD);
          if (!called) {
            if (Date.now() - standbyRef.current > STANDBY_MS || !drivingRef.current) end();
            else setTimeout(listen, 150);
            return;
          }
          leaveStandby();
          const rest = finalText.slice(called[0].length).trim();
          if (rest.length > 2) void ask(rest);
          else
            void say(spokenLanguage() === "ro" ? "Da?" : "Yes?").then(() => {
              if (activeRef.current) {
                setPhase("listening");
                listen();
              }
            });
          return;
        }
        if (finalText && phaseRef.current === "listening") {
          quietRef.current = 0;
          void ask(finalText);
          return;
        }
        if (phaseRef.current === "listening" || answers.current.size > 0) {
          quietRef.current += 1;
          const limit = drivingRef.current ? DRIVING_QUIET_ROUNDS : QUIET_ROUNDS;
          if (quietRef.current >= limit && answers.current.size === 0) {
            if (drivingRef.current && wakeWordRef.current) {
              enterStandby();
              setTimeout(listen, 150);
            } else end();
          } else setTimeout(listen, 150);
        }
      },
      (level) => {
        if (generation === listenGenRef.current) levelRef.current = Math.max(levelRef.current, level);
      },
    );
  }

  async function runTool(block: Anthropic.Beta.BetaToolUseBlock): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
    const tool = clientTools[block.name as keyof typeof clientTools] as ((input: never) => unknown) | undefined;
    if (!tool) return { type: "tool_result", tool_use_id: block.id, content: "Unealta nu există.", is_error: true };
    try {
      const result = await tool(block.input as never);
      return { type: "tool_result", tool_use_id: block.id, content: String(result ?? "Gata.") };
    } catch {
      return { type: "tool_result", tool_use_id: block.id, content: "Unealta a dat eroare.", is_error: true };
    }
  }

  // O cerere a lui Daniel: Claude răspunde, cheamă unelte (ferestre, agendă, buget), apoi vorbește.
  async function ask(text: string, image?: string) {
    if (!activeRef.current) return;
    stopListening();
    setPhase("thinking");
    log("user", image ? `📷 ${text}` : text);
    if (historyRef.current.length > MAX_MESSAGES || !cleanRef.current) historyRef.current = await fetchMemory();
    cleanRef.current = false;
    const asked = `${nowLine()}\n${text}`;
    historyRef.current.push({
      role: "user",
      content: image
        ? [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
            { type: "text", text: asked },
          ]
        : asked,
    });

    for (let step = 0; step < MAX_STEPS && activeRef.current; step += 1) {
      let data: { content?: Anthropic.Beta.BetaContentBlock[]; stop_reason?: string; error?: string };
      // Partea vorbită pornește de la prima propoziție completă, cât Claude încă scrie restul.
      let speaker: ReturnType<typeof speakStream> | null = null;
      let spokenUsed = 0;
      const feed = (text: string, done: boolean) => {
        const part = spokenPart(text);
        if (!part || silentRef.current || !activeRef.current) return;
        const fresh = part.body.slice(spokenUsed);
        const cut = done || part.closed ? fresh.length : lastSentenceEnd(fresh);
        if (cut <= 0 || !fresh.slice(0, cut).trim()) return;
        if (!speaker) {
          stopListening();
          setPhase("speaking");
          speaker = speakStream();
        }
        speaker.push(fresh.slice(0, cut));
        spokenUsed += cut;
      };
      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: historyRef.current,
            limba: spokenLanguage(),
            flux: true,
            volan: drivingRef.current,
            memorie: memorySnapshot,
          }),
          cache: "no-store",
        });
        if (response.status === 401) {
          window.location.reload();
          return;
        }
        if (response.ok && response.body && response.headers.get("Content-Type")?.includes("ndjson")) {
          data = {};
          let streamed = "";
          let pending = "";
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue;
              const event = JSON.parse(line) as {
                t: string;
                d?: string;
                error?: string;
                content?: Anthropic.Beta.BetaContentBlock[];
                stop_reason?: string;
              };
              if (event.t === "d" && event.d) {
                streamed += event.d;
                feed(streamed, false);
              } else if (event.t === "end") data = { content: event.content, stop_reason: event.stop_reason };
              else if (event.t === "strip") stripThinking(historyRef.current);
              else if (event.t === "err") throw new Error(event.error || "Ceva n-a mers. Mai încearcă.");
            }
          }
          if (!data.content) throw new Error("Răspunsul s-a întrerupt. Mai încearcă.");
        } else {
          data = await response.json();
          if (!response.ok || !data.content) throw new Error(data.error || "Ceva n-a mers. Mai încearcă.");
          if ((data as { strip?: boolean }).strip) stripThinking(historyRef.current);
        }
      } catch (caught) {
        stopSpeaking();
        // Cererea fără răspuns iese din istoric, ca următoarea să pornească curat.
        historyRef.current = [];
        setError(caught instanceof Error ? caught.message : String(caught));
        end();
        return;
      }
      if (!activeRef.current) return;
      historyRef.current.push({ role: "assistant", content: data.content as Anthropic.Beta.BetaContentBlockParam[] });

      const raw = data.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
      const reply = raw ? splitReply(raw) : null;
      if (reply?.ro) log("agent", reply.ro);
      const tools = data.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use");
      // Ce n-a fost încă spus din răspuns: restul, dacă a început deja pe bucăți, altfel tot.
      const speakReply = async () => {
        if (speaker) {
          feed(raw, true);
          await (speaker as ReturnType<typeof speakStream>).finish();
        } else if (reply) await say(reply.spoken);
      };

      if (data.stop_reason === "refusal") {
        await say("Sorry, I can't help with that one.");
        break;
      }
      // Căutarea pe internet a făcut o pauză: retrimitem, iar Claude continuă de unde a rămas.
      if (data.stop_reason === "pause_turn") {
        await speakReply();
        continue;
      }
      if (data.stop_reason !== "tool_use" || tools.length === 0) {
        if (raw) remember(asked, raw);
        journal("Telefon", text, reply?.ro || raw);
        await speakReply();
        break;
      }
      // Fraza dinaintea uneltelor („îți arăt pe ecran…”) se spune întâi; abia apoi se deschide fereastra și ascultăm.
      await speakReply();
      if (!activeRef.current) return;
      setPhase("thinking");
      const results = await Promise.all(tools.map(runTool));
      historyRef.current.push({ role: "user", content: results });
      // O unealtă a închis conversația (de exemplu a deschis Spotify): nu mai cerem și nu mai spunem nimic.
      if (!activeRef.current) return;
    }
    if (!activeRef.current) return;
    cleanRef.current = historyRef.current.at(-1)?.role === "assistant";
    // Poza a fost văzută; în istoric rămâne doar o notă, ca următoarele cereri să plece repede.
    // Gândirea e legată de istoricul exact, deci pleacă și ea când istoricul se schimbă.
    if (image) {
      stripThinking(historyRef.current);
      for (const message of historyRef.current) {
        if (Array.isArray(message.content)) {
          message.content = message.content.map((block) =>
            block.type === "image" ? { type: "text" as const, text: "[Poza trimisă de Daniel mai devreme]" } : block,
          );
        }
      }
    }
    if (silentRef.current) {
      // Mod scris: fără microfon după răspuns; conversația rămâne pentru următorul mesaj.
      activeRef.current = false;
      setPhase("idle");
      return;
    }
    // Pe iPhone, Spotify ia sunetul și microfonul paginii: după „pune muzică” conversația se închide,
    // iar o atingere o pornește din nou, curat. În mașină rămâne cum era (așteaptă „Argus”).
    if (musicOnRef.current && !drivingRef.current) {
      musicOnRef.current = false;
      end();
      return;
    }
    quietRef.current = 0;
    setPhase("listening");
    listen();
  }

  async function begin() {
    setError("");
    // Cât vorbește cu Argus, muzica ia pauză și pornește la loc la final. Cerem pauza înainte de microfon:
    // pe iPhone microfonul o oprește oricum, iar după aceea Spotify n-ar mai ști că a cântat.
    if (spotifyConnected) {
      // Cânta acum câteva secunde: o pornim la loc la final chiar dacă iPhone-ul a oprit-o deja la atingere.
      const seen = musicSeenRef.current;
      musicPausedRef.current = seen.canta && Date.now() - seen.at < 40000;
      pauseMusic();
    }
    primeSpeech();
    const micError = await openMic();
    if (micError) {
      setError(
        micError === "not-allowed"
          ? "Am nevoie de acces la microfon. Permite-l din setările browserului și mai încearcă."
          : "Nu am putut porni microfonul. Mai încearcă.",
      );
      return;
    }
    activeRef.current = true;
    silentRef.current = false;
    // Memoria vine cât Argus salută, nu înainte.
    const memory = fetchMemory();
    quietRef.current = 0;
    let greetedAt = 0;
    try {
      greetedAt = Number(localStorage.getItem(GREETED_KEY)) || 0;
    } catch {}
    if (Date.now() - greetedAt > GREET_EVERY_MS) {
      try {
        localStorage.setItem(GREETED_KEY, String(Date.now()));
      } catch {}
      log("agent", GREETING.ro);
      await say(greetingFor(spokenLanguage()));
    }
    historyRef.current = await memory;
    cleanRef.current = true;
    // Ce a venit cât a fost „nu mă deranja” (sau ce a notat serverul noaptea): se arată și se spune o singură dată, după salut.
    const brief = briefDue();
    const heldItems = fetch("/api/nu-deranja", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { amanate?: { titlu: string; text: string }[] } | null) => {
        const held = data?.amanate ?? [];
        if (!held.length) return held;
        addCard({
          id: crypto.randomUUID(),
          kind: "summary",
          title: "Între timp",
          text: held.map((item) => `${item.titlu}: ${item.text}`).join("\n"),
        });
        // Dimineața le spune brief-ul, ca să nu vorbească doi deodată.
        if (brief) return held;
        const titles = held.slice(0, 3).map((item) => item.titlu).join("; ");
        void report(
          spokenLanguage() === "ro"
            ? `Între timp ${held.length === 1 ? "a venit un lucru" : `au venit ${held.length} lucruri`}: ${titles}.`
            : `While you were away, ${held.length} things came in: ${titles}.`,
        );
        return held;
      })
      .catch(() => [] as { titlu: string; text: string }[]);
    if (brief && activeRef.current) {
      const held = await heldItems;
      const extra = held.length ? ` Între timp au venit: ${held.slice(0, 5).map((item) => item.titlu).join("; ")}.` : "";
      await ask(`Brief-ul zilei (pornit singur, la prima deschidere de dimineață).${extra}`);
      return;
    }
    if (activeRef.current) {
      setPhase("listening");
      listen();
    }
  }

  // Muzica se oprește cât vorbește cu Argus și pornește la loc când el doar așteaptă.
  function pauseMusic() {
    if (!spotifyConnected) return;
    void fetch("/api/spotify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actiune: "pauza_daca_canta" }) })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { pauzat?: boolean } | null) => {
        if (!data?.pauzat) return;
        musicPausedRef.current = true;
        // Conversația s-a terminat sau așteaptă deja „Argus” cât venea răspunsul: muzica pornește la loc.
        if (!activeRef.current || standbyRef.current) resumeMusic();
      })
      .catch(() => {});
  }

  function resumeMusic() {
    if (!musicPausedRef.current) return;
    musicPausedRef.current = false;
    void fetch("/api/spotify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actiune: "reia" }) }).catch(() => {});
  }

  function enterStandby() {
    standbyRef.current = Date.now();
    setStandby(true);
    quietRef.current = 0;
    resumeMusic();
  }

  function leaveStandby() {
    standbyRef.current = 0;
    setStandby(false);
    quietRef.current = 0;
    if (drivingRef.current || morningRef.current) pauseMusic();
  }

  function end() {
    standbyRef.current = 0;
    setStandby(false);
    if (musicPausedRef.current) {
      musicPausedRef.current = false;
      // Dacă iPhone-ul a adormit Spotify cât am vorbit, îl deschidem; serverul pornește muzica de îndată ce apare.
      void fetch("/api/spotify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actiune: "reia" }) })
        .then((response) => response.json())
        .then((data: { deschide?: string }) => {
          if (!data?.deschide || activeRef.current || document.visibilityState !== "visible") return;
          // iPhone-ul poate refuza deschiderea fără o atingere: rămâne și un buton, un minut.
          setMusicButton(true);
          setTimeout(() => setMusicButton(false), 60000);
          window.location.href = data.deschide;
        })
        .catch(() => {});
    }
    activeRef.current = false;
    stopListening();
    stopSpeaking();
    closeMic();
    releaseAudio();
    setHeard("");
    setPhase("idle");
    // O confirmare rămasă deschisă când se închide conversația nu mai poate aproba nimic.
    for (const id of [...answers.current.keys()]) settle(id, "fără răspuns");
  }

  // Confirmările deschise cât Argus tace se pot da și cu vocea.
  useEffect(() => {
    if (activeRef.current && cards.some((card) => card.kind === "confirm") && phaseRef.current === "thinking") listen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards]);

  const connected = phase !== "idle";

  // Modul mașină: ecranul rămâne aprins și vede următoarea întâlnire (azi sau mâine).
  const [nextMeeting, setNextMeeting] = useState<{ id: string; titlu: string; inceput: string; loc?: string } | null>(null);
  const warnedRef = useRef(new Set<string>());
  useEffect(() => {
    if (!driving) return;
    let lock: { release: () => Promise<void> } | null = null;
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      const nav = navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } };
      nav.wakeLock
        ?.request("screen")
        .then((sentinel) => (lock = sentinel))
        .catch(() => {});
    };
    const load = async () => {
      if (!googleConnected) return;
      const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString("en-CA", { timeZone: "Europe/Bucharest" });
      try {
        const response = await fetch(`/api/agenda?pana_la=${tomorrow}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { evenimente?: { id: string; titlu: string; inceput?: string; loc?: string }[] };
        const next = (data.evenimente ?? []).find((event) => event.inceput && new Date(event.inceput).getTime() > Date.now());
        setNextMeeting(next ? { id: next.id, titlu: next.titlu, inceput: next.inceput as string, loc: next.loc } : null);
      } catch {
        // rămâne ce era
      }
    };
    wake();
    void load();
    const refresh = setInterval(load, 5 * 60_000);
    const onVisible = () => {
      wake();
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(refresh);
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => {});
    };
  }, [driving, googleConnected]);

  // Cât e Argus deschis pe ecran, ecranul nu se stinge (Daniel îl ține pornit lângă el). Se cere din nou la întoarcere.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } };
    const keepOn = () => {
      if (document.visibilityState !== "visible" || !nav.wakeLock) return;
      nav.wakeLock
        .request("screen")
        .then((sentinel) => (lock = sentinel))
        .catch(() => {});
    };
    // iPhone-ul refuză uneori cererea fără o atingere sau n-o știe deloc în aplicația de pe ecran: la fiecare atingere
    // o mai cerem o dată și pornim și un clip negru, mut, în buclă, care ține ecranul aprins fără să atingă muzica.
    const video = document.createElement("video");
    video.src = "/treaz.mp4";
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("aria-hidden", "true");
    video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;left:0;top:0;";
    document.body.appendChild(video);
    const onTouch = () => {
      keepOn();
      if (video.paused) void video.play().catch(() => {});
    };
    onTouch();
    document.addEventListener("visibilitychange", onTouch);
    document.addEventListener("pointerdown", onTouch);
    return () => {
      document.removeEventListener("visibilitychange", onTouch);
      document.removeEventListener("pointerdown", onTouch);
      video.remove();
      void lock?.release().catch(() => {});
    };
  }, []);

  // Cât Argus doar stă deschis, ține minte dacă merge muzica. Pe iPhone, atingerea „Vorbește” oprește Spotify înainte
  // ca serverul să apuce să vadă că a cântat; așa știm totuși să o pornim la loc după conversație.
  useEffect(() => {
    if (!spotifyConnected) return;
    const check = () => {
      if (document.visibilityState !== "visible" || activeRef.current) return;
      void fetch("/api/spotify")
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { canta?: boolean } | null) => {
          if (data && !activeRef.current) musicSeenRef.current = { canta: Boolean(data.canta), at: Date.now() };
        })
        .catch(() => {});
    };
    check();
    const timer = setInterval(check, 15000);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotifyConnected]);

  // Cu 15 minute înainte de o întâlnire, Argus o spune o dată, dacă ascultă în acel moment.
  useEffect(() => {
    if (!driving || !nextMeeting) return;
    const check = () => {
      const minutes = Math.round((new Date(nextMeeting.inceput).getTime() - Date.now()) / 60_000);
      if (minutes > 15 || minutes < 1 || warnedRef.current.has(nextMeeting.id)) return;
      if (!activeRef.current || phaseRef.current !== "listening") return;
      warnedRef.current.add(nextMeeting.id);
      const where = nextMeeting.loc ? `, la ${nextMeeting.loc}` : "";
      void report(
        spokenLanguage() === "ro"
          ? `În ${minutes} minute ai ${nextMeeting.titlu}${where}.`
          : `In ${minutes} minutes you have ${nextMeeting.titlu}${where}.`,
      );
    };
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driving, nextMeeting]);
  const pendingConfirm = cards.find((card) => card.kind === "confirm");
  const [canListenNow, setCanListenNow] = useState(true);
  useEffect(() => setCanListenNow(canListen()), []);

  // Nucleul pulsează cât vorbește Argus și tresare când te aude.
  useEffect(() => {
    const setLevel = (value: number) => {
      levelRef.current = value;
      hudRef.current?.style.setProperty("--level", value.toFixed(3));
      meterRef.current?.style.setProperty("--level", value.toFixed(3));
    };
    if (phase === "idle") {
      setLevel(0);
      return;
    }
    let frame = 0;
    const tick = (time: number) => {
      const target =
        phase === "speaking"
          ? 0.35 + 0.3 * Math.abs(Math.sin(time / 110)) * (0.6 + 0.4 * Math.sin(time / 37))
          : levelRef.current * 0.94;
      setLevel(Math.max(0, Math.min(1, target)));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  useEffect(() => () => end(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleRef = useRef(() => {});
  toggleRef.current = toggle;
  // Cât vorbește, îl poți opri vorbind (dacă e pornit în Setări).
  useEffect(() => {
    if (!bargeIn || phase !== "speaking") return;
    return watchVoice(() => {
      if (phaseRef.current === "speaking") toggleRef.current();
    });
  }, [bargeIn, phase]);
  function toggle() {
    if (phaseRef.current === "idle") void begin();
    else if (phaseRef.current === "speaking") {
      // Atingerea cât vorbește îl întrerupe și trece la ascultat.
      stopSpeaking();
      setPhase("listening");
      listen();
    } else end();
  }

  function submitTyped(event: FormEvent) {
    event.preventDefault();
    const text = typed.trim();
    if (!text || phaseRef.current === "thinking") return;
    setTyped("");
    setError("");
    // Scris = răspuns doar în scris, fără voce și fără microfon (pentru când nu poți vorbi).
    stopListening();
    stopSpeaking();
    silentRef.current = true;
    activeRef.current = true;
    void ask(text);
  }

  // O atingere pe o cifră întreabă detaliile: cu vocea dacă vorbiți deja, altfel în scris.
  function askFromTile(text: string) {
    if (phaseRef.current === "thinking") return;
    if (phaseRef.current === "idle") silentRef.current = true;
    stopListening();
    stopSpeaking();
    activeRef.current = true;
    setError("");
    void ask(text);
  }

  function pickVoice(name: string) {
    chooseVoice(name);
    setVoiceName(name);
    primeSpeech();
    void speak(VOICE_CHECK[spokenLanguage()]);
    preloadPhrase(greetingFor(spokenLanguage()));
  }

  const activeProjects = projects.filter((item) => ["nouă", "în lucru", "confirmată", "așteaptă confirmare"].includes(item.status)).length;

  // Ecranul „Lucrări”: ce face laptopul în fundal, la ce pas e și ce a ieșit.
  function openProjects() {
    setProjectsOpen((open) => !open);
    fetch("/api/cereri", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { cereri?: Cerere[] } | null) => data?.cereri && setProjects(data.cereri))
      .catch(() => {});
  }

  function showProject(item: Cerere) {
    const shaped = !item.vizual ? pointsFromText(item.rezultat || "") : undefined;
    addCard({
      id: crypto.randomUUID(),
      kind: "summary",
      title: item.titlu,
      text: shaped ? shaped.text : item.rezultat || "",
      vizual: shaped ? shaped.vizual : item.vizual,
    });
    setProjectsOpen(false);
  }

  function pickLanguage(next: Language) {
    chooseLanguage(next);
    setLanguage(next);
    primeSpeech();
    void speak(VOICE_CHECK[next]);
    preloadPhrase(greetingFor(next));
  }

  // Pe desktop, Space pornește și oprește conversația.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code === "Space" && !(event.target instanceof HTMLInputElement)) {
        event.preventDefault();
        toggleRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Pe laptop, ARGUS pornește cu un ecran de inițializare: un clic pornește sunetul, animația și ecranul complet.
  useEffect(() => {
    setArmed(!window.matchMedia("(pointer: fine)").matches);
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  function powerUp() {
    setArmed(true);
    bootSound();
    orbRef.current?.boot();
    void document.documentElement.requestFullscreen?.().catch(() => {});
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  }

  const hudState: HudState = phase === "thinking" ? "connecting" : phase === "speaking" ? "speaking" : phase === "listening" ? "listening" : "idle";
  const label = {
    idle: "Atinge nucleul ca să vorbești",
    listening: heard ? `„${heard}”` : "Te ascult...",
    thinking: cards.some((card) => card.kind === "confirm") ? "Aștept „Argus, accept” sau „Argus, refuz”" : "Mă gândesc...",
    speaking: "ARGUS vorbește",
  }[phase];
  const link = { idle: "În așteptare", listening: "Activ", thinking: "Activ", speaking: "Activ" }[phase];

  return (
    <main className="console">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">A</span>
          <span className="brand-name">ARGUS</span>
        </div>
        <button className="work-toggle" onClick={openProjects} aria-expanded={projectsOpen}>
          Lucrări{activeProjects ? ` · ${activeProjects}` : ""}
          {laptopOff !== null && <span className="laptop-off"> · laptop oprit</span>}
        </button>
        <button className="car-toggle" onClick={toggleDriving} aria-pressed={driving}>
          Mașină
        </button>
        <button className="settings-toggle" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen}>
          {settingsOpen ? "Închide" : "Setări"}
        </button>
        <button className="fullscreen" onClick={toggleFullscreen} aria-label={fullscreen ? "Ieși din ecranul complet" : "Ecran complet"}>
          {fullscreen ? "Ieși din ecran complet" : "Ecran complet"}
        </button>
        <div className="clock" suppressHydrationWarning>
          <span className="clock-time">{now ? timeOf(now) : "--:--"}</span>
          <span className="clock-date">
            {now ? now.toLocaleDateString("ro-RO", { timeZone: "Europe/Bucharest", weekday: "long", day: "numeric", month: "long" }) : ""}
          </span>
        </div>
      </header>

      <aside className={`panel panel-left${settingsOpen ? " open" : ""}`}>
        <h2 className="panel-title">Sistem</h2>
        <dl className="readout">
          <div>
            <dt>Legătură</dt>
            <dd className={connected ? "ok" : ""}>{link}</dd>
          </div>
          <div>
            <dt>Semnal</dt>
            <dd>
              <span ref={meterRef} className="meter" />
            </dd>
          </div>
          <div>
            <dt>La volan</dt>
            <dd>
              <button type="button" className="voice" onClick={toggleDriving} aria-pressed={driving}>
                {driving ? "Pornit" : "Oprit"}
              </button>
            </dd>
          </div>
          <div>
            <dt>„Argus” în mașină</dt>
            <dd>
              <button
                type="button"
                className="voice"
                onClick={() => {
                  const next = !wakeWord;
                  try {
                    if (next) localStorage.setItem(WAKE_KEY, "1");
                    else localStorage.removeItem(WAKE_KEY);
                  } catch {
                    // fără memorare
                  }
                  wakeWordRef.current = next;
                  setWakeWord(next);
                }}
                aria-pressed={wakeWord}
                title="În modul mașină, după ce tace, Argus așteaptă să-l strigi pe nume (cel mult o oră). Tot ce se aude în mașină trece prin transcriere."
              >
                {wakeWord ? "Pornit" : "Oprit"}
              </button>
            </dd>
          </div>
          <div>
            <dt>Întrerupe vorbind</dt>
            <dd>
              <button
                type="button"
                className="voice"
                onClick={() => {
                  const next = !bargeIn;
                  try {
                    if (next) localStorage.setItem(BARGE_KEY, "1");
                    else localStorage.removeItem(BARGE_KEY);
                  } catch {
                    // fără memorare
                  }
                  setBargeIn(next);
                }}
                aria-pressed={bargeIn}
                title="În test: cât vorbește Argus, dacă începi să vorbești, el tace și te ascultă. Dacă se oprește singur din cauza propriei voci, oprește-l."
              >
                {bargeIn ? "Pornit (test)" : "Oprit"}
              </button>
            </dd>
          </div>
          <div>
            <dt>Muzică dimineața</dt>
            <dd>
              <input
                className="voice"
                value={morningMusic}
                placeholder="Numele playlistului"
                aria-label="Playlist pentru dimineață"
                title="Ce pune Argus când deschizi adresa ?dimineata=1 (de exemplu din automatizarea alarmei din iPhone). Gol: continuă ce ascultai."
                onChange={(event) => {
                  const next = event.target.value;
                  setMorningMusic(next);
                  try {
                    if (next.trim()) localStorage.setItem(MORNING_MUSIC_KEY, next);
                    else localStorage.removeItem(MORNING_MUSIC_KEY);
                  } catch {
                    // fără memorare
                  }
                }}
              />
            </dd>
          </div>
          <div>
            <dt>Link Scurtături</dt>
            <dd>
              <button
                type="button"
                className="voice"
                title="Pentru automatizarea de dimineață: acțiunea Play din Spotify, apoi „Obține conținutul URL-ului” cu acest link. Merge și cu telefonul blocat."
                onClick={() => {
                  fetch("/api/spotify/dimineata", { cache: "no-store" })
                    .then((response) => (response.ok ? response.json() : null))
                    .then((data: { link?: string } | null) => {
                      if (!data?.link) throw new Error();
                      const link = data.link + encodeURIComponent(morningMusic.trim());
                      return navigator.clipboard.writeText(link).then(
                        () => setMorningLink("Copiat"),
                        () => setMorningLink(link),
                      );
                    })
                    .catch(() => setMorningLink("Nu merge acum"));
                }}
              >
                {morningLink && morningLink.length < 20 ? morningLink : "Copiază linkul"}
              </button>
              {morningLink.length >= 20 && <span className="hint" style={{ wordBreak: "break-all", userSelect: "all" }}>{morningLink}</span>}
            </dd>
          </div>
          <div>
            <dt>Brief dimineața</dt>
            <dd>
              <button
                type="button"
                className="voice"
                onClick={() => {
                  const next = !briefAuto;
                  try {
                    if (next) localStorage.setItem(BRIEF_KEY, "1");
                    else localStorage.removeItem(BRIEF_KEY);
                  } catch {
                    // fără memorare
                  }
                  setBriefAuto(next);
                }}
                aria-pressed={briefAuto}
                title="Prima dată când pornești Argus între 5 și 11, îți spune singur agenda, sarcinile, bugetul și vremea."
              >
                {briefAuto ? "Pornit" : "Oprit"}
              </button>
            </dd>
          </div>
          <div>
            <dt>Limbă</dt>
            <dd>
              <select id="language" className="voice" value={language} onChange={(event) => pickLanguage(event.target.value as Language)} aria-label="Limba în care vorbește Argus">
                <option value="en">Engleză</option>
                <option value="ro">Română</option>
              </select>
            </dd>
          </div>
          {canListenNow && (
            <div>
              <dt>Auz instant</dt>
              <dd>
                <button
                  type="button"
                  className="voice"
                  onClick={() => {
                    chooseFastHearing(!fastOn);
                    setFastOn(!fastOn);
                    setFastStatus(fastHearingStatus());
                  }}
                  aria-pressed={fastOn}
                  title="În test: Argus te aude în timp real, deci răspunde mai repede"
                >
                  {fastOn ? "Pornit (test)" : "Oprit"}
                </button>
                {fastOn && fastStatus && <span className="module-state"> {fastStatus}</span>}
              </dd>
            </div>
          )}
          <div>
            <dt>Voce</dt>
            <dd>
              {voices.length > 0 ? (
                <select id="voice" className="voice" value={voiceName} onChange={(event) => pickVoice(event.target.value)} aria-label="Vocea lui Argus">
                  {voices.map((name) => (
                    <option key={name} value={name}>
                      {name.replace(/^Microsoft\s+/, "").replace(/\s*-\s*English.*$/, "")}
                    </option>
                  ))}
                </select>
              ) : (
                "implicită"
              )}
            </dd>
          </div>
        </dl>
        <h2 className="panel-title">Module</h2>
        <ul className="modules">
          {MODULES.map((module) => {
            const online = module.ready && (!module.google || googleConnected);
            const state = online ? "online" : module.google && module.ready ? "neconectat" : "în curând";
            return (
              <li key={module.name} className={online ? "ready" : ""}>
                <span className="dot" />
                {module.name}
                <span className="module-state">{state}</span>
              </li>
            );
          })}
        </ul>
      </aside>

      <section className="center">
        {panou && (
          <div className="stats">
            <button type="button" className="stat" onClick={() => askFromTile("Care e următoarea mea întâlnire? Pregătește-mă pe scurt.")} disabled={!panou.intalnire}>
              <span className="stat-label">Următoarea</span>
              <span className="stat-value">{panou.intalnire ? meetingWhen(panou.intalnire.inceput) : "liber"}</span>
              <span className="stat-sub">{panou.intalnire?.titlu ?? "nimic în 2 zile"}</span>
            </button>
            <button type="button" className={`stat right${panou.buget && panou.buget.procent >= 90 ? " warn" : ""}`} onClick={() => askFromTile("Cum stau cu bugetul luna asta?")} disabled={!panou.buget}>
              <span className="stat-label">Buget</span>
              <span className="stat-value">{panou.buget ? `${panou.buget.procent}%` : "—"}</span>
              <span className="stat-sub">{panou.buget
                  ? panou.buget.bani !== undefined
                    ? `ai ${panou.buget.bani.toLocaleString("ro-RO")} lei`
                    : `de plătit ${(panou.buget.deplata ?? panou.buget.ramas).toLocaleString("ro-RO")} lei`
                  : "nu am acces"}</span>
              {panou.buget && <span className="stat-bar"><i style={{ width: `${Math.min(100, panou.buget.procent)}%` }} /></span>}
            </button>
          </div>
        )}
        <div className="orb-slot">
        {use2d ? (
          <Hud ref={hudRef} state={hudState} onToggle={toggle} label={connected ? "Oprește conversația" : "Pornește conversația"} />
        ) : (
          <Orb
            ref={orbRef}
            state={phase === "thinking" || (working > 0 && phase !== "speaking") ? "working" : hudState}
            active={cards.flatMap((card) => (card.module ? [card.module] : []))}
            getLevel={() => levelRef.current}
            onTap={toggle}
            label={connected ? "Oprește conversația" : "Pornește conversația"}
            onUnsupported={() => setUse2d(true)}
          />
        )}
        </div>
        {panou && (
          <div className="stats">
            <button type="button" className="stat" onClick={() => setTeamPick((open) => !open)} aria-expanded={teamPick}>
              <span className="stat-label">Echipa</span>
              <span className="stat-value">{panou.echipa ? `${panou.echipa.raportat}/${panou.echipa.total}` : "—"}</span>
              <span className="stat-sub">
                {panou.echipa
                  ? panou.echipa.analize !== undefined && panou.echipa.tel
                    ? `${panou.echipa.analize}/${panou.echipa.tel} analize`
                    : "au raportat"
                  : "apasă și alegi"}
              </span>
              {panou.echipa?.analize !== undefined && panou.echipa.tel ? (
                <span className="stat-bar"><i style={{ width: `${Math.min(100, Math.round((panou.echipa.analize / panou.echipa.tel) * 100))}%` }} /></span>
              ) : null}
            </button>
            <button type="button" className={`stat right${panou.sarcini && panou.sarcini.azi > 0 ? " warn" : ""}`} onClick={() => askFromTile("Ce sarcini am azi?")} disabled={!panou.sarcini}>
              <span className="stat-label">Sarcini</span>
              <span className="stat-value">{panou.sarcini ? panou.sarcini.ramase : "—"}</span>
              <span className="stat-sub">{panou.sarcini ? (panou.sarcini.azi ? `${panou.sarcini.azi} pentru azi` : "nimic azi") : "nu am acces"}</span>
            </button>
          </div>
        )}
        {teamPick && (
          <div className="team-pick" role="group" aria-label="Ce vrei să vezi la echipă">
            {TEAM_VIEWS.map((view) => (
              <button key={view.label} type="button" onClick={() => { setTeamPick(false); askFromTile(view.ask); }}>
                {view.label}
              </button>
            ))}
          </div>
        )}
        <p className="status">{label}</p>
        {connected && (
          <p className="hint">{phase === "speaking" ? "Atinge ca să-l întrerupi." : "Atinge din nou ca să închizi."}</p>
        )}
        <form className="ask" onSubmit={submitTyped}>
          <input
            id="ask-text"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={canListenNow ? "Sau scrie-i lui Argus..." : "Scrie-i lui Argus..."}
            aria-label="Scrie-i lui Argus"
            autoComplete="off"
          />
          <button type="button" onClick={() => photoRef.current?.click()} aria-label="Trimite o poză lui Argus">
            Poză
          </button>
          <button type="submit" disabled={!typed.trim()}>
            Trimite
          </button>
          <input
            ref={photoRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void sendPhoto(file);
            }}
          />
        </form>
        {error && <p className="error">{error}</p>}
        {googleNotice && <p className="hint">{googleNotice}</p>}
        {pushState === "off" && (
          <button type="button" className="connect connect-quiet" onClick={enablePush}>
            Pornește notificările
          </button>
        )}
        {musicButton && (
          <a
            className="connect"
            href="spotify:"
            onClick={() => {
              setMusicButton(false);
              void fetch("/api/spotify", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actiune: "reia" }) }).catch(() => {});
            }}
          >
            Pornește muzica la loc
          </a>
        )}
        {pushState === "denied" && <p className="hint">Notificările sunt oprite din setările telefonului.</p>}
        <div className="connect-row">
        <a className={googleConnected ? "connect connect-quiet" : "connect"} href="/api/google/connect">
          {googleConnected ? "Reconectează Google" : "Conectează Google (agendă, to-do, buget)"}
        </a>
        <a className={spotifyConnected ? "connect connect-quiet" : "connect"} href="/api/spotify/connect">
          {spotifyConnected ? "Reconectează Spotify" : "Conectează Spotify (muzică)"}
        </a>
        </div>
      </section>

      <aside className="panel panel-right">
        <h2 className="panel-title">Jurnal</h2>
        <div className="log" ref={logRef} aria-live="polite">
          {lines.length === 0 && <p className="log-empty">Conversația apare aici.</p>}
          {lines.map((line, index) => (
            <p key={index} className={`log-line log-${line.role}`}>
              <span className="log-meta">
                {line.at} · {line.role === "user" ? "Daniel" : "ARGUS"}
              </span>
              {line.text}
            </p>
          ))}
        </div>
      </aside>

      <CardStack cards={cards} onClose={closeCard} onAnswer={settle} />

      {driving && (
        <div className="car" role="dialog" aria-label="Mod mașină">
          <div className="car-top">
            <span className="car-time" suppressHydrationWarning>
              {now ? timeOf(now) : "--:--"}
            </span>
            <button type="button" className="car-exit" onClick={toggleDriving}>
              Ieși din mașină
            </button>
          </div>
          <div className="car-next">
            {nextMeeting ? (
              <>
                <span className="car-next-label">
                  Următoarea ·{" "}
                  {new Date(nextMeeting.inceput).toLocaleString("ro-RO", {
                    timeZone: "Europe/Bucharest",
                    ...(new Date(nextMeeting.inceput).toDateString() === new Date().toDateString() ? {} : { weekday: "long" }),
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <span className="car-next-title">{nextMeeting.titlu}</span>
                {nextMeeting.loc && (
                  <a className="car-next-go" href={`https://waze.com/ul?q=${encodeURIComponent(nextMeeting.loc)}&navigate=yes`}>
                    {nextMeeting.loc}
                  </a>
                )}
              </>
            ) : (
              <span className="car-next-label">{googleConnected ? "Nicio întâlnire azi" : "Agenda nu e conectată"}</span>
            )}
          </div>
          <button
            type="button"
            className={`car-mic car-${phase}`}
            onClick={toggle}
            aria-label={connected ? "Oprește conversația" : "Pornește conversația"}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z" />
            </svg>
          </button>
          <p className="car-status">{phase === "idle" ? "Atinge ca să vorbești" : standby ? "Spune „Argus” când ai nevoie" : label}</p>
          {pendingConfirm && pendingConfirm.kind === "confirm" && (
            <div className="car-confirm">
              <p>{pendingConfirm.title}</p>
              <div>
                <button type="button" onClick={() => settle(pendingConfirm.id, "da")}>
                  Accept
                </button>
                <button type="button" onClick={() => settle(pendingConfirm.id, "nu")}>
                  Refuz
                </button>
              </div>
            </div>
          )}
          {error && <p className="car-error">{error}</p>}
        </div>
      )}

      {projectsOpen && (
        <div className="projects" role="dialog" aria-label="Lucrări">
          <div className="projects-head">
            <h2>Lucrări</h2>
            <button onClick={() => setProjectsOpen(false)}>Închide</button>
          </div>
          {laptopOff !== null && (
            <p className="laptop-warning">
              Laptopul nu mai răspunde de {awayText(laptopOff)}. Cererile noi așteaptă și pornesc singure când revine.
            </p>
          )}
          {projects.length === 0 ? (
            <p className="projects-empty">Încă nimic. Cere-i lui Argus un proiect („fă-mi o prezentare despre…”) și îl vezi aici cât lucrează.</p>
          ) : (
            <ul className="projects-list">
              {projects.slice(0, 20).map((item) => {
                const state = PROJECT_STATE[item.status];
                const first = (item.rezultat || "").split("\n").find((line) => line.trim()) ?? "";
                const link = (item.rezultat || "").split("\n").find((line) => /https:\/\//.test(line));
                return (
                  <li key={item.id} className={`project project-${state.tone}`}>
                    <div className="project-top">
                      <span className="project-state">{state.label}</span>
                      <span className="project-time">{sinceText(item.status === "gata" || item.status === "eroare" ? item.actualizat : item.creat)}</span>
                    </div>
                    <div className="project-title">{item.titlu}</div>
                    {state.tone === "active" && <div className="project-progress">{item.progres || "Pornește…"}</div>}
                    {(item.status === "gata" || item.status === "eroare") && first && (
                      <div className="project-result">
                        <Linked line={first.slice(0, 220)} />
                      </div>
                    )}
                    {link && link !== first && (
                      <div className="project-result">
                        <Linked line={link} />
                      </div>
                    )}
                    {item.status === "gata" && (
                      <button className="project-open" onClick={() => showProject(item)}>
                        Vezi tot
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      {quickStart && !driving && phase === "idle" && (
        <button
          type="button"
          className="quickstart"
          onClick={() => {
            setQuickStart(false);
            void begin();
          }}
        >
          Atinge oriunde ca să vorbești
        </button>
      )}
      {!use2d && <WindowLinks cards={cards} orb={orbRef} />}

      {!armed && (
        <button className="power" onClick={powerUp}>
          <span className="power-title">ARGUS</span>
          <span className="power-hint">Clic pentru inițializare</span>
        </button>
      )}
    </main>
  );
}
