"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { Card } from "./cards";
import type { OrbHandle } from "./orb";

// Liniile dintre sferă și ferestre: o scânteie zboară din cuvântul modulului (sau din miez)
// la fereastră, apoi rămâne o linie subțire care urmărește cuvântul cât timp se rotește.
export default function WindowLinks({ cards, orb }: { cards: Card[]; orb: RefObject<OrbHandle | null> }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const NS = "http://www.w3.org/2000/svg";
    svg.replaceChildren();
    const items = cards.map((card) => {
      const path = document.createElementNS(NS, "path");
      const end = document.createElementNS(NS, "circle");
      const start = document.createElementNS(NS, "circle");
      end.setAttribute("r", "2.5");
      start.setAttribute("r", "3.5");
      svg.append(path, end, start);
      return { card, path, end, start, fresh: !seen.current.has(card.id) };
    });
    seen.current = new Set(cards.map((card) => card.id));

    const geometry = (card: Card) => {
      const element = document.querySelector<HTMLElement>(`[data-card-id="${card.id}"]`);
      const handle = orb.current;
      if (!element || !handle) return null;
      const box = element.getBoundingClientRect();
      const word = card.module ? handle.wordPos(card.module) : null;
      const origin = word ?? handle.center();
      if (!origin) return null;
      const side = box.left > origin.x;
      const ax = side ? box.left : box.left + box.width / 2;
      const ay = side ? box.top + Math.min(36, box.height / 2) : box.top;
      let sx = origin.x;
      let sy = origin.y;
      if (!word) {
        // Din miez: linia pornește de la marginea lui, nu din centru.
        const angle = Math.atan2(ay - origin.y, ax - origin.x);
        sx += Math.cos(angle) * 60;
        sy += Math.sin(angle) * 60;
      }
      const d = side ? `M${sx} ${sy} L${ax - 24} ${ay} L${ax} ${ay}` : `M${sx} ${sy} L${ax} ${ay - 18} L${ax} ${ay}`;
      return { d, sx, sy, ax, ay, word: Boolean(word) };
    };

    // Scânteia și linia care se desenează, doar pentru ferestrele noi.
    for (const item of items) {
      if (!item.fresh || reduce) continue;
      requestAnimationFrame(() => {
        const g = geometry(item.card);
        if (!g) return;
        item.path.setAttribute("d", g.d);
        const length = item.path.getTotalLength();
        item.path.style.strokeDasharray = `${length}`;
        const draw = item.path.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], {
          duration: 340,
          easing: "cubic-bezier(.5,0,.2,1)",
        });
        draw.onfinish = () => (item.path.style.strokeDasharray = "none");
        const spark = document.createElement("div");
        spark.className = "spark";
        spark.style.left = `${g.sx}px`;
        spark.style.top = `${g.sy}px`;
        document.body.appendChild(spark);
        spark.animate(
          [
            { transform: "translate(0, 0) scale(1)", opacity: 1 },
            { transform: `translate(${g.ax - g.sx}px, ${g.ay - g.sy}px) scale(.6)`, opacity: 0.2 },
          ],
          { duration: 340, easing: "cubic-bezier(.5,0,.2,1)" },
        ).onfinish = () => spark.remove();
      });
    }

    let frame = 0;
    const tick = () => {
      for (const item of items) {
        const g = geometry(item.card);
        const show = g ? "" : "none";
        item.path.style.display = item.end.style.display = show;
        item.start.style.display = g?.word ? "" : "none";
        if (!g) continue;
        item.path.setAttribute("d", g.d);
        item.end.setAttribute("cx", `${g.ax}`);
        item.end.setAttribute("cy", `${g.ay}`);
        item.start.setAttribute("cx", `${g.sx}`);
        item.start.setAttribute("cy", `${g.sy}`);
      }
      frame = requestAnimationFrame(tick);
    };
    if (items.length) frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [cards, orb]);

  return <svg ref={svgRef} className="links" aria-hidden="true" />;
}
