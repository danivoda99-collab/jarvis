"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type Anthropic from "@anthropic-ai/sdk";
import Hud, { type HudState } from "./hud";
import CardStack, { type Answer, type Card } from "./cards";
import Orb, { type Module, type OrbHandle } from "./orb";
import WindowLinks from "./links";
import { blipSound, bootSound } from "./sounds";
import type { Cerere } from "@/lib/cereri";
import { budgetVizual, cleanVizual, pointsFromText } from "@/lib/vizual";
import {
  canListen,
  chooseVoice,
  chosenVoiceName,
  closeMic,
  englishVoices,
  isUserTalking,
  listenOnce,
  openMic,
  primeSpeech,
  setCloudVoice,
  speak,
  speakStream,
  chooseLanguage,
  spokenLanguage,
  splitReply,
  stopSpeaking,
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
    blipSound();
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
      const data = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok) return `Eroare: ${data.error ?? response.status}`;
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
    spotify: (parameters: { actiune?: unknown; ce?: unknown; tip?: unknown; valoare?: unknown }) =>
      asText(parameters.actiune) === "ce_canta"
        ? callApi("/api/spotify")
        : callApi("/api/spotify", "POST", {
            actiune: asText(parameters.actiune),
            ce: asText(parameters.ce),
            tip: asText(parameters.tip) || undefined,
            valoare: typeof parameters.valoare === "number" ? parameters.valoare : undefined,
          }),
    fisier_citeste: (parameters: { id?: unknown }) => callApi(`/api/fisiere?id=${encodeURIComponent(asText(parameters.id))}`),
    buget_categorii: () => callApi("/api/buget"),
    // Cât s-a cheltuit luna asta pe fiecare categorie, față de buget: tabel pe ecran, rezumat cu voce.
    buget_situatie: async () => {
      const raw = await callApi("/api/buget?situatie=1");
      if (raw.startsWith("Eroare")) return raw;
      const data = JSON.parse(raw) as { luna?: string; tabel?: string[][] };
      if (data.tabel && data.tabel.length > 1) {
        // Bare de progres pe fiecare categorie (cele aproape de limită sus); tabelul doar dacă nu se pot citi cifrele.
        const vizual = budgetVizual(data.tabel);
        addCard({
          id: crypto.randomUUID(),
          kind: "summary",
          title: `Buget ${data.luna ?? ""}`.trim(),
          vizual,
          table: vizual ? undefined : data.tabel,
          module: "buget",
        });
      }
      return `${raw}\nBarele de progres sunt pe ecran. Spune pe scurt totalul și ce categorii au depășit bugetul.`;
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
        const response = await fetch("/api/cereri?semnal=1&tel=1", { cache: "no-store" });
        if (response.ok) {
          const { semnal } = (await response.json()) as { semnal?: string };
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
  const [language, setLanguage] = useState<Language>("en");
  // „La volan”: răspunsuri foarte scurte, totul cu vocea, nimic de citit.
  const [driving, setDriving] = useState(false);
  const drivingRef = useRef(false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("argus-volan") === "1";
      drivingRef.current = saved;
      setDriving(saved);
    } catch {
      // implicit oprit
    }
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
      })
      .catch(() => {});
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
        if (finalText && phaseRef.current === "listening") {
          quietRef.current = 0;
          void ask(finalText);
          return;
        }
        if (phaseRef.current === "listening" || answers.current.size > 0) {
          quietRef.current += 1;
          if (quietRef.current >= QUIET_ROUNDS && answers.current.size === 0) end();
          else setTimeout(listen, 150);
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
    quietRef.current = 0;
    setPhase("listening");
    listen();
  }

  async function begin() {
    setError("");
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
    historyRef.current = await fetchMemory();
    cleanRef.current = true;
    quietRef.current = 0;
    log("agent", GREETING.ro);
    await say(spokenLanguage() === "ro" ? GREETING.ro : GREETING.spoken);
    if (activeRef.current) {
      setPhase("listening");
      listen();
    }
  }

  function end() {
    activeRef.current = false;
    stopListening();
    stopSpeaking();
    closeMic();
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

  function pickVoice(name: string) {
    chooseVoice(name);
    setVoiceName(name);
    primeSpeech();
    void speak(VOICE_CHECK[spokenLanguage()]);
  }

  function pickLanguage(next: Language) {
    chooseLanguage(next);
    setLanguage(next);
    primeSpeech();
    void speak(VOICE_CHECK[next]);
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
            <dt>Limbă</dt>
            <dd>
              <select id="language" className="voice" value={language} onChange={(event) => pickLanguage(event.target.value as Language)} aria-label="Limba în care vorbește Argus">
                <option value="en">Engleză</option>
                <option value="ro">Română</option>
              </select>
            </dd>
          </div>
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
        {pushState === "denied" && <p className="hint">Notificările sunt oprite din setările telefonului.</p>}
        <a className={googleConnected ? "connect connect-quiet" : "connect"} href="/api/google/connect">
          {googleConnected ? "Reconectează Google" : "Conectează Google (agendă, to-do, buget)"}
        </a>
        <a className={spotifyConnected ? "connect connect-quiet" : "connect"} href="/api/spotify/connect">
          {spotifyConnected ? "Reconectează Spotify" : "Conectează Spotify (muzică)"}
        </a>
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
