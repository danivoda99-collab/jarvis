"use client";

import { useState } from "react";

export default function Login() {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (response.ok) {
      window.location.reload();
      return;
    }
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    setError(response.status === 401 ? "Cod greșit. Mai încearcă." : data.error || "Ceva n-a mers.");
  }

  return (
    <main className="screen">
      <div className="brand">
        <span className="brand-mark">J</span>
        <span className="brand-name">JARVIS</span>
      </div>
      <form className="login" onSubmit={submit}>
        <label htmlFor="code">Codul tău de acces</label>
        <input
          id="code"
          type="password"
          inputMode="text"
          autoComplete="current-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoFocus
        />
        <button type="submit" disabled={busy || code.length === 0}>
          {busy ? "Verific..." : "Intră"}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </main>
  );
}
