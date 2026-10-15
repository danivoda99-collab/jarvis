"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type Anthropic from "@anthropic-ai/sdk";
import Hud, { type HudState } from "./hud";
import CardStack, { type Answer, type Card } from "./cards";
import Orb, { type Module, type OrbHandle } from "./orb";
import WindowLinks from "./links";
import { blipSound, bootSound } from "./sounds";
import type { Cerere } from "@/lib/cereri";
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

// Ce s-a vorbit rămâne pe telefon (doar textul, fără unelte), ca Argus să continue de unde ați rămas.
const MEMORY_KEY = "argus-memorie";
const MEMORY_KEEP = 24; // ultimele 12 schimburi
function loadMemory(): Message[] {
  try {
    const saved = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? "[]") as { role: "user" | "assistant"; content: string }[];
    const messages = saved.filter((item) => typeof item.content === "string" && item.content);
    while (messages.length && messages[0].role !== "user") messages.shift();
    return messages.at(-1)?.role === "assistant" ? messages : [];
  } catch {
    return [];
  }
}
function remember(user: string, assistant: string) {
  try {
    const messages = [
      ...loadMemory(),
      { role: "user", content: user },
      { role: "assistant", content: assistant },
    ].slice(-MEMORY_KEEP);
    localStorage.setItem(MEMORY_KEY, JSON.stringify(messages));
  } catch {
    // fără memorare, următoarea conversație începe de la zero
  }
}
const MAX_STEPS = 8; // câte runde de unelte poate face Argus pentru o singură cerere
const QUIET_ROUNDS = 3; // după atâtea ascultări fără nimic spus, Argus se oprește

export default function Jarvis({ googleConnected = false }: { googleConnected?: boolean }) {
  return <Assistant googleConnected={googleConnected} />;
}

function nowLine() {
  const now = new Date();
  const date = now.toLocaleDateString("ro-RO", { timeZone: "Europe/Bucharest", weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const time = now.toLocaleTimeString("ro-RO", { timeZone: "Europe/Bucharest", hour: "2-digit", minute: "2-digit" });
  const iso = now.toLocaleDateString("sv-SE", { timeZone: "Europe/Bucharest" });
  return `[Acum: ${date} (${iso}), ora ${time}, ora României]`;
}

function useClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function timeOf(date: Date) {
  return date.toLocaleTimeString("ro-RO", { hour: "2-digit", minute: "2-digit" });
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

function Assistant({ googleConnected }: { googleConnected: boolean }) {
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
    const result = new URLSearchParams(window.location.search).get("google");
    if (!result) return;
    setGoogleNotice(
      result === "conectat"
        ? "Google e conectat. Argus îți vede acum agenda și lista de to-do."
        : "Conectarea la Google n-a mers. Mai încearcă.",
    );
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

  // Unelte pe care agentul ARGUS le cheamă ca să arate ferestre pe ecran.
  const clientTools = {
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
      const answer = await confirm("Adaug în agendă?", `${title}\n${when}`, undefined, "agenda");
      if (answer !== "da") return "Daniel nu a confirmat. Evenimentul NU a fost adăugat.";
      return callApi("/api/agenda", "POST", {
        titlu: title,
        inceput: start,
        sfarsit: end || undefined,
        descriere: asText(parameters.descriere) || undefined,
      });
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
      const answer = await confirm("Adaug în to-do?", due ? `${title}\nScadență: ${due}` : title, undefined, "sarcini");
      if (answer !== "da") return "Daniel nu a confirmat. Sarcina NU a fost adăugată.";
      return callApi("/api/sarcini", "POST", {
        titlu: title,
        scadenta: due || undefined,
        notite: asText(parameters.notite) || undefined,
      });
    },
    sarcini_bifeaza: async (parameters: { id?: unknown; titlu?: unknown }) => {
      const answer = await confirm("Bifez ca făcută?", asText(parameters.titlu) || "Sarcina aleasă", undefined, "sarcini");
      if (answer !== "da") return "Daniel nu a confirmat. Sarcina NU a fost bifată.";
      return callApi("/api/sarcini", "PATCH", { id: asText(parameters.id) });
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
      const answer = await confirm("Modific în to-do?", details, undefined, "sarcini");
      if (answer !== "da") return "Daniel nu a confirmat. Sarcina NU a fost modificată.";
      return callApi("/api/sarcini", "PATCH", {
        id: asText(parameters.id),
        titlu: title || undefined,
        scadenta: due || undefined,
        notite: notes || undefined,
      });
    },
    buget_categorii: () => callApi("/api/buget"),
    // Cât s-a cheltuit luna asta pe fiecare categorie, față de buget: tabel pe ecran, rezumat cu voce.
    buget_situatie: async () => {
      const raw = await callApi("/api/buget?situatie=1");
      if (raw.startsWith("Eroare")) return raw;
      const data = JSON.parse(raw) as { luna?: string; tabel?: string[][] };
      if (data.tabel && data.tabel.length > 1) {
        addCard({
          id: crypto.randomUUID(),
          kind: "summary",
          title: `Buget ${data.luna ?? ""}`.trim(),
          table: data.tabel,
          module: "buget",
        });
      }
      return `${raw}\nTabelul e pe ecran. Spune pe scurt totalul și ce categorii au depășit bugetul.`;
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
      const answer = await confirm("Trec în buget?", "", undefined, "buget", table);
      if (answer !== "da") return "Daniel nu a confirmat. Cheltuiala NU a fost trecută.";
      return callApi("/api/buget", "POST", { suma: amount, categorie: category, nota: note, data: date || undefined });
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
        const response = await fetch("/api/cereri?semnal=1", { cache: "no-store" });
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
          addCard({ id: crypto.randomUUID(), kind: "summary", title, text: item.rezultat || "" });
          log("agent", title);
          // Prima propoziție din rezultat („Trimis lui Jess pe WhatsApp.”) se spune cu voce.
          const first = (item.rezultat || "").split(/(?<=[.!?])\s|\n/)[0]?.slice(0, 200) || title;
          void report(item.status === "gata" ? first : `Claude n-a reușit: ${first}`);
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
  const [settingsOpen, setSettingsOpen] = useState(false); // pe telefon, panoul Sistem se deschide din „Setări”
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
  async function ask(text: string) {
    if (!activeRef.current) return;
    stopListening();
    setPhase("thinking");
    log("user", text);
    if (historyRef.current.length > MAX_MESSAGES || !cleanRef.current) historyRef.current = loadMemory();
    cleanRef.current = false;
    const asked = `${nowLine()}\n${text}`;
    historyRef.current.push({ role: "user", content: asked });

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
          body: JSON.stringify({ messages: historyRef.current, limba: spokenLanguage(), flux: true }),
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
              else if (event.t === "err") throw new Error(event.error || "Ceva n-a mers. Mai încearcă.");
            }
          }
          if (!data.content) throw new Error("Răspunsul s-a întrerupt. Mai încearcă.");
        } else {
          data = await response.json();
          if (!response.ok || !data.content) throw new Error(data.error || "Ceva n-a mers. Mai încearcă.");
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
      if (data.stop_reason !== "tool_use" || tools.length === 0) {
        if (raw) remember(asked, raw);
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
    historyRef.current = loadMemory();
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
            {now ? now.toLocaleDateString("ro-RO", { weekday: "long", day: "numeric", month: "long" }) : ""}
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
          <button type="submit" disabled={!typed.trim()}>
            Trimite
          </button>
        </form>
        {error && <p className="error">{error}</p>}
        {googleNotice && <p className="hint">{googleNotice}</p>}
        <a className={googleConnected ? "connect connect-quiet" : "connect"} href="/api/google/connect">
          {googleConnected ? "Reconectează Google" : "Conectează Google (agendă, to-do, buget)"}
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
