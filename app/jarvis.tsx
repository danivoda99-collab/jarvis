"use client";

import { useEffect, useRef, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";

type Line = { role: "user" | "agent"; text: string };

export default function Jarvis() {
  return (
    <ConversationProvider>
      <Assistant />
    </ConversationProvider>
  );
}

function Assistant() {
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const orbRef = useRef<HTMLButtonElement>(null);

  const conversation = useConversation({
    onMessage: ({ message, source }) => {
      setLines((previous) =>
        [...previous, { role: source === "user" ? "user" : "agent", text: message } as Line].slice(-4),
      );
    },
    onError: (message) => setError(message || "Ceva n-a mers. Mai încearcă."),
  });

  const { status, isSpeaking } = conversation;
  const connected = status === "connected";
  const busy = starting || status === "connecting";

  // Orbul pulsează după volumul vocii: a lui JARVIS când vorbește, a ta când asculți.
  useEffect(() => {
    if (!connected) {
      orbRef.current?.style.setProperty("--level", "0");
      return;
    }
    let frame = 0;
    const tick = () => {
      const level = isSpeaking ? conversation.getOutputVolume() : conversation.getInputVolume();
      orbRef.current?.style.setProperty("--level", Math.min(1, level * 2.5).toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [connected, isSpeaking, conversation]);

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
      setLines([]);
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

  const label = busy
    ? "Mă conectez..."
    : !connected
      ? "Atinge ca să vorbești"
      : isSpeaking
        ? "JARVIS vorbește"
        : "Te ascult...";

  const orbState = !connected ? "idle" : isSpeaking ? "speaking" : "listening";

  return (
    <main className="screen">
      <div className="brand">
        <span className="brand-mark">J</span>
        <span className="brand-name">JARVIS</span>
      </div>

      <button
        ref={orbRef}
        className={`orb orb-${orbState}${busy ? " orb-busy" : ""}`}
        onClick={toggle}
        aria-label={connected ? "Oprește conversația" : "Pornește conversația"}
      >
        <span className="orb-core" />
      </button>

      <p className="status">{label}</p>
      {connected && <p className="hint">Atinge din nou ca să închizi.</p>}
      {error && <p className="error">{error}</p>}

      <section className="transcript" aria-live="polite">
        {lines.map((line, index) => (
          <p key={index} className={`line line-${line.role}`}>
            {line.text}
          </p>
        ))}
      </section>
    </main>
  );
}
