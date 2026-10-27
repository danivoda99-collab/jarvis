"use client";

import { useState } from "react";
import type { Vizual } from "@/lib/vizual";

// Cifre mari, bare de progres, grafice și imagini în ferestre, în culorile sferei.
const SERIES = ["var(--flame)", "var(--gold)", "var(--ivory-muted)"];

const format = (value: number) =>
  Math.abs(value) >= 1000 ? Math.round(value).toLocaleString("ro-RO") : String(Math.round(value * 10) / 10).replace(".", ",");

const NIVEL = { urgent: "Urgent", important: "De răspuns", info: "Info" } as const;

// Mâine, în fusul orar al lui Daniel (Google Tasks ține doar data).
function tomorrow() {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bucharest" }).format(new Date(Date.now() + 86_400_000));
  return date.slice(0, 10);
}

// „Gata” bifează sarcina, „Mâine” o mută pe mâine; o singură atingere, fără întrebări în plus.
function TaskActions({ id }: { id: string }) {
  const [state, setState] = useState<"" | "lucru" | "gata" | "maine" | "eroare">("");
  const act = async (done: boolean) => {
    setState("lucru");
    const response = await fetch("/api/sarcini", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(done ? { id } : { id, scadenta: tomorrow() }),
    }).catch(() => null);
    setState(response?.ok ? (done ? "gata" : "maine") : "eroare");
  };
  if (state === "gata") return <span className="viz-task-done">Bifată ✓</span>;
  if (state === "maine") return <span className="viz-task-done">Mutată pe mâine</span>;
  return (
    <div className="viz-task-actions">
      <button className="viz-point-send" disabled={state === "lucru"} onClick={() => void act(true)}>
        Gata
      </button>
      <button className="viz-point-send viz-task-later" disabled={state === "lucru"} onClick={() => void act(false)}>
        Mâine
      </button>
      {state === "eroare" && <span className="viz-task-error">N-a mers, mai încearcă.</span>}
    </div>
  );
}

function Points({ items }: { items: NonNullable<Vizual["puncte"]> }) {
  return (
    <ul className="viz-points">
      {items.map((item, index) => (
        <li key={index} className={`viz-point viz-point-${item.nivel}`}>
          <i className="viz-point-dot" aria-hidden />
          <div className="viz-point-body">
            <div className="viz-point-head">
              <strong>{item.titlu}</strong>
              {item.nivel !== "info" && <span className="viz-point-tag">{NIVEL[item.nivel]}</span>}
            </div>
            {item.text && <span className="viz-point-text">{item.text}</span>}
            {item.sarcina && <TaskActions id={item.sarcina} />}
            {item.mesaj && (
              <div className="viz-point-draft">
                <span className="viz-point-draft-text">„{item.mesaj.text}”</span>
                <button
                  className="viz-point-send"
                  onClick={() => window.dispatchEvent(new CustomEvent("argus-trimite", { detail: item.mesaj }))}
                >
                  Trimite pe WhatsApp
                </button>
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Tiles({ items }: { items: NonNullable<Vizual["cifre"]> }) {
  return (
    <div className="viz-tiles">
      {items.map((item, index) => (
        <div className="viz-tile" key={index}>
          <span className="viz-tile-label">{item.eticheta}</span>
          <strong className="viz-tile-value">{item.valoare}</strong>
          {item.nota && <span className="viz-tile-note">{item.nota}</span>}
        </div>
      ))}
    </div>
  );
}

function ProgressBars({ items }: { items: NonNullable<Vizual["progres"]> }) {
  return (
    <ul className="viz-progress">
      {items.map((item, index) => {
        const ratio = item.valoare / item.maxim;
        const state = ratio > 1 ? "over" : ratio > 0.85 ? "near" : "ok";
        return (
          <li key={index} className={`viz-progress-${state}`}>
            <div className="viz-progress-head">
              <span>{item.eticheta}</span>
              <span className="viz-progress-value">
                {format(item.valoare)} / {format(item.maxim)}
                {item.unitate ? ` ${item.unitate}` : ""} · {Math.round(ratio * 100)}%
              </span>
            </div>
            <div className="viz-progress-track" role="progressbar" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className="viz-progress-fill" style={{ width: `${Math.min(ratio, 1) * 100}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Bars({ data }: { data: NonNullable<Vizual["bare"]> }) {
  const compare = data.elemente.some((item) => item.valoare2 !== undefined);
  const max = Math.max(1, ...data.elemente.flatMap((item) => [item.valoare, item.valoare2 ?? 0]));
  return (
    <figure className="viz-chart">
      {data.titlu && <figcaption>{data.titlu}</figcaption>}
      {compare && data.legenda && data.legenda.length > 0 && (
        <div className="viz-legend">
          {data.legenda.map((name, index) => (
            <span key={index}>
              <i style={{ background: SERIES[index] }} />
              {name}
            </span>
          ))}
        </div>
      )}
      <ul className="viz-bars">
        {data.elemente.map((item, index) => (
          <li key={index}>
            <span className="viz-bar-label">{item.eticheta}</span>
            <span className="viz-bar-tracks">
              <span className="viz-bar" style={{ width: `${(Math.max(item.valoare, 0) / max) * 100}%`, background: SERIES[0] }} />
              {compare && (
                <span className="viz-bar" style={{ width: `${(Math.max(item.valoare2 ?? 0, 0) / max) * 100}%`, background: SERIES[1] }} />
              )}
            </span>
            <span className="viz-bar-value">
              {format(item.valoare)}
              {compare && item.valoare2 !== undefined ? ` / ${format(item.valoare2)}` : ""}
              {data.unitate ? ` ${data.unitate}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function LineChart({ data }: { data: NonNullable<Vizual["linie"]> }) {
  const width = 320;
  const height = 140;
  const pad = { top: 10, right: 10, bottom: 22, left: 36 };
  const values = data.serii.flatMap((serie) => serie.valori);
  // Axa pornește de la zero doar când valorile sunt mici față de maxim; altfel diferențele s-ar vedea plate.
  const low = Math.min(...values);
  const high = Math.max(...values);
  const min = low < 0 || low < high * 0.4 ? Math.min(0, low) : Math.floor(low - (high - low) * 0.15);
  const max = Math.max(high, min + 1);
  const x = (index: number) => pad.left + (index / Math.max(data.etichete.length - 1, 1)) * (width - pad.left - pad.right);
  const y = (value: number) => pad.top + (1 - (value - min) / (max - min)) * (height - pad.top - pad.bottom);
  const step = Math.ceil(data.etichete.length / 6);
  return (
    <figure className="viz-chart">
      {data.titlu && <figcaption>{data.titlu}</figcaption>}
      {data.serii.length > 1 && (
        <div className="viz-legend">
          {data.serii.map((serie, index) => (
            <span key={index}>
              <i style={{ background: SERIES[index] }} />
              {serie.nume}
            </span>
          ))}
        </div>
      )}
      <svg viewBox={`0 0 ${width} ${height}`} className="viz-line" role="img" aria-label={data.titlu ?? "Grafic"}>
        {[min, max - min > 10 ? Math.round((min + max) / 2) : (min + max) / 2, max].map((tick, index) => (
          <g key={index}>
            <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} className="viz-grid" />
            <text x={pad.left - 6} y={y(tick) + 4} textAnchor="end" className="viz-axis">
              {format(tick)}
            </text>
          </g>
        ))}
        {data.etichete.map((label, index) =>
          index % step === 0 || index === data.etichete.length - 1 ? (
            <text key={index} x={x(index)} y={height - 6} textAnchor="middle" className="viz-axis">
              {label}
            </text>
          ) : null,
        )}
        {data.serii.map((serie, index) => (
          <g key={index}>
            <polyline
              fill="none"
              stroke={SERIES[index]}
              strokeWidth={2}
              strokeLinejoin="round"
              points={serie.valori.map((value, at) => `${x(at)},${y(value)}`).join(" ")}
            />
            {serie.valori.map((value, at) => (
              <circle key={at} cx={x(at)} cy={y(value)} r={2.5} fill={SERIES[index]} />
            ))}
          </g>
        ))}
      </svg>
    </figure>
  );
}

function Table({ rows }: { rows: string[][] }) {
  return (
    <div className="card-table">
      <table>
        <thead>
          <tr>
            {rows[0].map((cell, index) => (
              <th key={index}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(1).map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td key={index}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Visual({ data }: { data: Vizual }) {
  return (
    <div className="viz">
      {data.puncte && <Points items={data.puncte} />}
      {data.cifre && <Tiles items={data.cifre} />}
      {data.progres && <ProgressBars items={data.progres} />}
      {data.bare && <Bars data={data.bare} />}
      {data.linie && <LineChart data={data.linie} />}
      {data.tabel && <Table rows={data.tabel} />}
      {data.imagine && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="viz-image" src={data.imagine} alt="" loading="lazy" referrerPolicy="no-referrer" />
      )}
    </div>
  );
}
