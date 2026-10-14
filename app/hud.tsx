"use client";

import { forwardRef } from "react";

export type HudState = "idle" | "connecting" | "listening" | "speaking";

type Props = {
  state: HudState;
  onToggle: () => void;
  label: string;
};

// Nucleul ARGUS: inele HUD care se rotesc în jurul unui miez luminos.
// --level (0..1), setat din afară, mărește strălucirea după volumul vocii.
const Hud = forwardRef<HTMLButtonElement, Props>(function Hud({ state, onToggle, label }, ref) {
  return (
    <button ref={ref} className={`hud hud-${state}`} onClick={onToggle} aria-label={label}>
      <svg viewBox="0 0 400 400" className="hud-svg" aria-hidden="true">
        <defs>
          <radialGradient id="core-fill" cx="50%" cy="45%" r="55%">
            <stop offset="0%" stopColor="#fff4dc" />
            <stop offset="35%" stopColor="#ffb05a" />
            <stop offset="75%" stopColor="#ff6a13" />
            <stop offset="100%" stopColor="#7a2a06" />
          </radialGradient>
        </defs>

        {/* Inelul exterior: gradații fine, rotație lentă */}
        <g className="ring ring-outer">
          <circle cx="200" cy="200" r="188" className="stroke-gold-faint" />
          <circle cx="200" cy="200" r="180" className="ticks" strokeDasharray="1.5 7.9" />
          <path d="M 200 12 A 188 188 0 0 1 388 200" className="stroke-gold arc-bold" />
          <path d="M 200 388 A 188 188 0 0 1 12 200" className="stroke-gold arc-bold" />
        </g>

        {/* Inelul de mijloc: segmente, rotație inversă */}
        <g className="ring ring-middle">
          <circle cx="200" cy="200" r="150" className="stroke-flame segments" strokeDasharray="60 18 8 18" />
          <circle cx="200" cy="200" r="138" className="stroke-gold-faint" />
        </g>

        {/* Inelul interior: arce scurte, rotație rapidă */}
        <g className="ring ring-inner">
          <circle cx="200" cy="200" r="112" className="stroke-ivory arcs" strokeDasharray="22 48" />
          <circle cx="200" cy="200" r="102" className="stroke-gold-faint" />
        </g>

        {/* Miezul */}
        <circle cx="200" cy="200" r="78" fill="url(#core-fill)" className="core" />
        <circle cx="200" cy="200" r="78" className="stroke-gold core-edge" />
      </svg>
    </button>
  );
});

export default Hud;
