"use client";

import { useEffect, useRef, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import Hud, { type HudState } from "./hud";
import CardStack, { type Answer, type Card } from "./cards";

type Line = { role: "user" | "agent"; text: string; at: string };

const MODULES: { name: string; ready: boolean }[] = [
  { name: "Voce", ready: true },
  { name: "Agendă", ready: false },
  { name: "Listă to-do", ready: false },
  { name: "Buget", ready: false },
  { name: "Muzică", ready: false },
];

export default function Jarvis() {
  return (
    <ConversationProvider>
      <Assistant />
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

const CONFIRM_TIMEOUT_MS = 90_000;

function Assistant() {
  const [lines, setLines] = useState<Line[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const answers = useRef(new Map<string, (answer: Answer | "fără răspuns") => void>());
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const hudRef = useRef<HTMLButtonElement>(null);
  const meterRef = useRef<HTMLSpanElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const now = useClock();

  function addCard(card: Card) {
    setCards((previous) => [...previous.filter((item) => item.kind === "confirm"), card].slice(-4));
  }

  function closeCard(id: string) {
    setCards((previous) => previous.filter((card) => card.id !== id));
  }

  function settle(id: string, answer: Answer | "fără răspuns") {
    answers.current.get(id)?.(answer);
    answers.current.delete(id);
    closeCard(id);
  }

  // Unelte pe care agentul ARGUS le cheamă ca să arate ferestre pe ecran.
  const clientTools = {
    arata_rezumat: (parameters: { titlu?: unknown; text?: unknown; puncte?: unknown }) => {
      addCard({
        id: crypto.randomUUID(),
        kind: "summary",
        title: asText(parameters.titlu) || "Rezumat",
        text: asText(parameters.text),
        points: asList(parameters.puncte),
      });
      return "Rezumatul e afișat pe ecran.";
    },
    arata_lista: (parameters: { titlu?: unknown; elemente?: unknown }) => {
      addCard({
        id: crypto.randomUUID(),
        kind: "list",
        title: asText(parameters.titlu) || "Listă",
        items: asList(parameters.elemente),
      });
      return "Lista e afișată pe ecran.";
    },
    cere_confirmare: (parameters: { titlu?: unknown; detalii?: unknown; destinatar?: unknown }) => {
      const id = crypto.randomUUID();
      addCard({
        id,
        kind: "confirm",
        title: asText(parameters.titlu) || "Confirmi?",
        details: asText(parameters.detalii),
        recipient: asText(parameters.destinatar) || undefined,
      });
      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => settle(id, "fără răspuns"), CONFIRM_TIMEOUT_MS);
        answers.current.set(id, (answer) => {
          clearTimeout(timer);
          resolve(
            answer === "da"
              ? "Daniel a apăsat Da."
              : answer === "nu"
                ? "Daniel a apăsat Nu. Nu face acțiunea."
                : "Daniel nu a răspuns. Nu face acțiunea.",
          );
        });
      });
    },
    inchide_ferestrele: () => {
      setCards((previous) => previous.filter((card) => card.kind === "confirm"));
      return "Ferestrele sunt închise.";
    },
  };

  const conversation = useConversation({
    clientTools,
    onMessage: ({ message, source }) => {
      const line: Line = { role: source === "user" ? "user" : "agent", text: message, at: timeOf(new Date()) };
      setLines((previous) => [...previous, line].slice(-30));
    },
    onError: (message) => setError(message || "Ceva n-a mers. Mai încearcă."),
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
        hudRef.current?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
          {MODULES.map((module) => (
            <li key={module.name} className={module.ready ? "ready" : ""}>
              <span className="dot" />
              {module.name}
              <span className="module-state">{module.ready ? "online" : "în curând"}</span>
            </li>
          ))}
        </ul>
      </aside>

      <section className="center">
        <Hud ref={hudRef} state={hudState} onToggle={toggle} label={connected ? "Oprește conversația" : "Pornește conversația"} />
        <p className="status">{label}</p>
        {connected && <p className="hint">Atinge din nou ca să închizi.</p>}
        {error && <p className="error">{error}</p>}
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
    </main>
  );
}
