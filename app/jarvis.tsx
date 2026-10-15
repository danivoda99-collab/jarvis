"use client";

import { useEffect, useRef, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import Hud, { type HudState } from "./hud";
import CardStack, { type Answer, type Card } from "./cards";
import Orb, { type Module, type OrbHandle } from "./orb";
import WindowLinks from "./links";
import { blipSound, bootSound } from "./sounds";

type Line = { role: "user" | "agent"; text: string; at: string };

const MODULES: { name: string; ready: boolean; google?: boolean }[] = [
  { name: "Voce", ready: true },
  { name: "Ferestre", ready: true },
  { name: "Agendă", ready: true, google: true },
  { name: "Listă to-do", ready: true, google: true },
  { name: "Buget", ready: true, google: true },
  { name: "Muzică", ready: false },
];

export default function Jarvis({ googleConnected = false }: { googleConnected?: boolean }) {
  return (
    <ConversationProvider>
      <Assistant googleConnected={googleConnected} />
    </ConversationProvider>
  );
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
  const [starting, setStarting] = useState(false);
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
  }

  // Afișează o fereastră Da/Nu și așteaptă atingerea lui Daniel.
  function confirm(title: string, details: string, recipient?: string, module?: Module) {
    const id = crypto.randomUUID();
    addCard({ id, kind: "confirm", title, details, recipient, module: module ?? guessModule(title, details) });
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
    buget_categorii: () => callApi("/api/buget"),
    buget_adauga: async (parameters: { suma?: unknown; categorie?: unknown; nota?: unknown; data?: unknown }) => {
      const amount = String(parameters.suma ?? "").trim();
      const category = asText(parameters.categorie);
      const note = asText(parameters.nota);
      const date = asText(parameters.data);
      const details = [`${amount} lei · ${category}`, note, date ? `Data: ${date}` : "Data: azi"].filter(Boolean).join("\n");
      const answer = await confirm("Trec în buget?", details, undefined, "buget");
      if (answer !== "da") return "Daniel nu a confirmat. Cheltuiala NU a fost trecută.";
      return callApi("/api/buget", "POST", { suma: amount, categorie: category, nota: note, data: date || undefined });
    },
    inchide_ferestrele: () => {
      setCards((previous) => previous.filter((card) => card.kind === "confirm"));
      return "Ferestrele sunt închise.";
    },
  };

  const conversation = useConversation({
    clientTools,
    onMessage: ({ message, source }) => {
      // Un „da” sau „nu” spus cu vocea răspunde la ultima fereastră de confirmare deschisă.
      if (source === "user" && answers.current.size > 0) {
        const spoken = spokenAnswer(message);
        const pending = [...answers.current.keys()].pop();
        if (spoken && pending) settle(pending, spoken);
      }
      const line: Line = { role: source === "user" ? "user" : "agent", text: message, at: timeOf(new Date()) };
      setLines((previous) => [...previous, line].slice(-30));
    },
    onError: (message) =>
      setError(
        /quota|credits/i.test(message ?? "")
          ? "S-au terminat minutele ElevenLabs. Treci pe un plan plătit sau așteaptă luna viitoare."
          : message || "Ceva n-a mers. Mai încearcă.",
      ),
    // O confirmare rămasă deschisă când se închide conversația nu mai poate aproba nimic.
    onDisconnect: () => {
      for (const id of [...answers.current.keys()]) settle(id, "fără răspuns");
    },
  });

  const { status, isSpeaking } = conversation;
  const connected = status === "connected";
  const busy = starting || status === "connecting";

  // Nucleul și indicatorul de semnal urmăresc volumul: vocea lui ARGUS când vorbește, a ta când asculți.
  useEffect(() => {
    const setLevel = (value: number) => {
      levelRef.current = value;
      hudRef.current?.style.setProperty("--level", value.toFixed(3));
      meterRef.current?.style.setProperty("--level", value.toFixed(3));
    };
    if (!connected) {
      setLevel(0);
      return;
    }
    let frame = 0;
    const tick = () => {
      const raw = isSpeaking ? conversation.getOutputVolume() : conversation.getInputVolume();
      setLevel(Math.min(1, raw * 2.5));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [connected, isSpeaking, conversation]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  async function start() {
    setError("");
    setStarting(true);
    try {
      // Microfonul se cere în urma atingerii, cum cere iPhone-ul.
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const response = await fetch("/api/session", { cache: "no-store" });
      if (response.status === 401) {
        window.location.reload();
        return;
      }
      const data = (await response.json()) as { token?: string; error?: string };
      if (!response.ok || !data.token) {
        throw new Error(data.error || "Nu am putut porni conversația.");
      }
      conversation.startSession({ conversationToken: data.token, connectionType: "webrtc" });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(
        message.includes("Permission") || message.includes("NotAllowed")
          ? "Am nevoie de acces la microfon. Permite-l din setări și mai încearcă."
          : message,
      );
    } finally {
      setStarting(false);
    }
  }

  const toggleRef = useRef(() => {});
  toggleRef.current = toggle;
  function toggle() {
    if (connected) {
      conversation.endSession();
    } else if (!busy) {
      void start();
    }
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

  const hudState: HudState = busy ? "connecting" : !connected ? "idle" : isSpeaking ? "speaking" : "listening";
  const label = {
    connecting: "Mă conectez...",
    idle: "Atinge nucleul ca să vorbești",
    listening: "Te ascult...",
    speaking: "ARGUS vorbește",
  }[hudState];
  const link = { connecting: "Conectare", idle: "În așteptare", listening: "Activ", speaking: "Activ" }[hudState];

  return (
    <main className="console">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">A</span>
          <span className="brand-name">ARGUS</span>
        </div>
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

      <aside className="panel panel-left">
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
            state={working > 0 && (hudState === "idle" || hudState === "listening") ? "working" : hudState}
            active={cards.flatMap((card) => (card.module ? [card.module] : []))}
            getLevel={() => levelRef.current}
            onTap={toggle}
            label={connected ? "Oprește conversația" : "Pornește conversația"}
            onUnsupported={() => setUse2d(true)}
          />
        )}
        <p className="status">{label}</p>
        {connected && <p className="hint">Atinge din nou ca să închizi.</p>}
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
