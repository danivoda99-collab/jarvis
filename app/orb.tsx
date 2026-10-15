"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

export type OrbState = "idle" | "connecting" | "listening" | "speaking" | "working";
export type Module = "agenda" | "sarcini" | "buget" | "gmail";

export type OrbHandle = {
  // Poziția pe ecran a cuvântului unui modul (pentru linia spre fereastră), sau null dacă nu e pe ecran.
  wordPos: (module: Module) => { x: number; y: number } | null;
  // Centrul sferei pe ecran.
  center: () => { x: number; y: number } | null;
  boot: () => void;
  scan: () => void;
};

type Props = {
  state: OrbState;
  active: Module[];
  getLevel: () => number;
  onTap: () => void;
  label: string;
  onUnsupported: () => void;
};

const FLAME = 0xff6a13;
const GOLD = 0xd4a64a;
const IVORY = 0xf4ecd8;

const WORDS = ["AGENDA", "SARCINI", "BUGET", "GMAIL", "TEAM VODA", "RUPEM TOPURILE", "WHATSAPP", "ONLINE", "MDS 2026", "FILODOXIA"];
const WORD_OF: Record<Module, string> = { agenda: "AGENDA", sarcini: "SARCINI", buget: "BUGET", gmail: "GMAIL" };

// Zgomot pentru flacăra din miez (value noise + fbm), scris direct în shader.
const NOISE =
  "float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }" +
  "float vnoise(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);" +
  " return mix(mix(mix(hash(i), hash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y)," +
  " mix(mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z); }" +
  "float fbm(vec3 p){ float v = 0.0; float a = 0.5; for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; } return v; }";

const VERTEX =
  "varying vec3 vN; varying vec3 vP; void main(){ vN = normalize(normalMatrix * normal); vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }";

const CORE_FRAGMENT =
  NOISE +
  "uniform float t; uniform float heat; varying vec3 vN; varying vec3 vP; void main(){" +
  " vec3 q = vP * 2.4; float w = fbm(q * 1.4 + vec3(t * 0.25, -t * 0.4, 0.0)); float n = fbm(q + vec3(0.0, -t * 1.1, 0.0) + w * 1.3);" +
  " vec3 deep = vec3(0.32, 0.06, 0.01); vec3 flame = vec3(1.0, 0.36, 0.04); vec3 hot = vec3(1.0, 0.84, 0.55);" +
  " vec3 c = mix(deep, flame, smoothstep(0.3, 0.55, n)); c = mix(c, hot, smoothstep(0.58, 0.78, n));" +
  " float f = pow(1.0 - abs(vN.z), 1.5); c = mix(c, flame * 0.7, f * 0.45); gl_FragColor = vec4(c * (0.82 + 0.25 * heat), 1.0); }";

const CORONA_FRAGMENT =
  NOISE +
  "uniform float t; varying vec3 vN; varying vec3 vP; void main(){ float f = pow(1.0 - abs(vN.z), 2.2);" +
  " float n = fbm(vP * 3.2 + vec3(0.0, -t * 1.6, t * 0.3)); float a = f * smoothstep(0.35, 0.75, n) * 1.4; gl_FragColor = vec4(vec3(1.0, 0.45, 0.08) * a, a); }";

const ease = (x: number) => {
  const v = Math.min(1, Math.max(0, x));
  return 1 - Math.pow(1 - v, 3);
};

// Nucleul ARGUS: sferă 3D cu flacără în miez, carcase de rețea, cuvintele modulelor pe orbită și inelul auriu.
// Atingerea scurtă pornește/oprește conversația; tragerea rotește sfera sau, pe inel, înclină inelul.
const Orb = forwardRef<OrbHandle, Props>(function Orb({ state, active, getLevel, onTap, label, onUnsupported }, ref) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef({ state, active, getLevel, onTap });
  live.current = { state, active, getLevel, onTap };
  const api = useRef<OrbHandle | null>(null);
  const [booted, setBooted] = useState(false);

  useImperativeHandle(ref, () => ({
    wordPos: (module) => api.current?.wordPos(module) ?? null,
    center: () => api.current?.center() ?? null,
    boot: () => api.current?.boot(),
    scan: () => api.current?.scan(),
  }));

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    } catch {
      onUnsupported();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x0d0a09, 1);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.z = 8.2;
    const root = new THREE.Group();
    scene.add(root);

    const additive = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false } as const;
    const edges = (geometry: THREE.BufferGeometry, color: number, opacity: number) =>
      new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color, opacity, ...additive }));
    const points = (count: number, place: (i: number, p: Float32Array, k: number) => void, color: number, size: number, opacity: number) => {
      const positions = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) place(i, positions, i * 3);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      return new THREE.Points(geometry, new THREE.PointsMaterial({ color, size, opacity, ...additive }));
    };

    // Miezul în flăcări, cu o coroană care iese pe margine
    const core = new THREE.Group();
    const coreMat = new THREE.ShaderMaterial({ uniforms: { t: { value: 0 }, heat: { value: 0 } }, vertexShader: VERTEX, fragmentShader: CORE_FRAGMENT });
    const coronaMat = new THREE.ShaderMaterial({ uniforms: { t: { value: 0 } }, vertexShader: VERTEX, fragmentShader: CORONA_FRAGMENT, ...additive });
    core.add(new THREE.Mesh(new THREE.SphereGeometry(0.95, 96, 96), coreMat));
    core.add(new THREE.Mesh(new THREE.SphereGeometry(1.1, 64, 64), coronaMat));
    root.add(core);

    // Carcase de rețea
    const shellA = edges(new THREE.IcosahedronGeometry(1.35, 1), GOLD, 0.75);
    const shellB = edges(new THREE.IcosahedronGeometry(1.8, 2), FLAME, 0.35);
    const shellC = edges(new THREE.IcosahedronGeometry(2.25, 1), GOLD, 0.18);
    root.add(shellA, shellB, shellC);

    // Spirala de lumină
    const N = 700;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const spiral = points(
      N,
      (i, p, k) => {
        const y = 1 - (i / (N - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        const th = golden * i;
        p[k] = Math.cos(th) * r * 1.18;
        p[k + 1] = y * 1.18;
        p[k + 2] = Math.sin(th) * r * 1.18;
      },
      IVORY,
      0.028,
      0.85,
    );
    root.add(spiral);

    // Cuvintele modulelor, pe orbită
    const words = new THREE.Group();
    WORDS.forEach((word, i) => {
      const paint = document.createElement("canvas");
      paint.width = 512;
      paint.height = 96;
      const pen = paint.getContext("2d")!;
      pen.font = '600 50px "Segoe UI", system-ui, sans-serif';
      pen.textBaseline = "middle";
      pen.fillStyle = i % 3 === 0 ? "#ff6a13" : "#d4a64a";
      pen.fillText(word, 8, 50);
      const texture = new THREE.CanvasTexture(paint);
      texture.minFilter = THREE.LinearFilter;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, opacity: 0.75, ...additive }));
      const lat = (i / 10 - 0.45) * 2.2;
      const lon = i * 2.4;
      sprite.position.set(Math.cos(lon) * Math.cos(lat) * 2.05, Math.sin(lat) * 2.05 * 0.8, Math.sin(lon) * Math.cos(lat) * 2.05);
      sprite.scale.set(1.1, 0.21, 1);
      sprite.userData = { word, size: 1 };
      words.add(sprite);
    });
    root.add(words);

    // Inelul auriu (se poate înclina) cu fragmentele care circulă pe el, plus inelul punctat
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.7, 0.01, 8, 200), new THREE.MeshBasicMaterial({ color: GOLD }));
    const ringRest = Math.PI / 2.3;
    ring.rotation.x = ringRest;
    const ringHit = new THREE.Mesh(new THREE.TorusGeometry(2.7, 0.22, 8, 120), new THREE.MeshBasicMaterial({ visible: false }));
    ring.add(ringHit);
    const debris = new THREE.Group();
    const shard = new THREE.TetrahedronGeometry(0.045);
    for (let i = 0; i < 54; i++) {
      const piece = new THREE.Mesh(shard, new THREE.MeshBasicMaterial({ color: i % 4 ? FLAME : GOLD }));
      piece.userData = { a: Math.random() * Math.PI * 2, r: 2.7 + (Math.random() - 0.5) * 0.32, s: 0.2 + Math.random() * 0.3, z: (Math.random() - 0.5) * 0.14 };
      debris.add(piece);
    }
    ring.add(debris);
    const dashed = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: 241 }, (_, i) => {
          const a = (i / 240) * Math.PI * 2;
          return new THREE.Vector3(Math.cos(a) * 3, 0, Math.sin(a) * 3);
        }),
      ),
      new THREE.LineDashedMaterial({ color: FLAME, dashSize: 0.35, gapSize: 0.18 }),
    );
    dashed.computeLineDistances();
    dashed.rotation.x = Math.PI / 1.8;
    dashed.rotation.z = 0.35;
    scene.add(ring, dashed);

    // Praf în jur
    const dust = points(
      900,
      (_, p, k) => {
        const r = 2.5 + Math.random() * 2.5;
        const t = Math.random() * Math.PI * 2;
        const u = Math.acos(2 * Math.random() - 1);
        p[k] = r * Math.sin(u) * Math.cos(t);
        p[k + 1] = r * Math.cos(u);
        p[k + 2] = r * Math.sin(u) * Math.sin(t);
      },
      GOLD,
      0.02,
      0.45,
    );
    scene.add(dust);

    // Scanarea: un inel de lumină care trece prin sferă
    const scanRing = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 6, 160), new THREE.MeshBasicMaterial({ color: 0xffd9a8, opacity: 0, ...additive }));
    const scanDisc = new THREE.Mesh(new THREE.CircleGeometry(1, 96), new THREE.MeshBasicMaterial({ color: FLAME, opacity: 0, side: THREE.DoubleSide, ...additive }));
    scanRing.rotation.x = scanDisc.rotation.x = Math.PI / 2;
    scene.add(scanRing, scanDisc);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.6, 0.45, 0.5);
    composer.addPass(bloom);

    const resize = () => {
      const box = wrap.getBoundingClientRect();
      if (!box.width) return;
      renderer.setSize(box.width, box.height, false);
      composer.setSize(box.width, box.height);
      camera.aspect = box.width / box.height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    resize();

    // Atingere, tragere, ciupit
    let rotX = 0.3;
    let rotY = 0;
    let velX = 0;
    let velY = 0;
    let zoom = 8.2;
    let ringVX = 0;
    let ringVZ = 0;
    let target: "ring" | "sphere" | null = null;
    let down: { x: number; y: number; at: number; moved: number } | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const onRing = (event: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      ndc.set(((event.clientX - box.left) / box.width) * 2 - 1, -((event.clientY - box.top) / box.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      return ray.intersectObject(ringHit).length > 0;
    };
    const onDown = (event: PointerEvent) => {
      canvas.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 1) {
        target = onRing(event) ? "ring" : "sphere";
        down = { x: event.clientX, y: event.clientY, at: performance.now(), moved: 0 };
      } else {
        down = null; // două degete = zoom, nu atingere
      }
    };
    const onMove = (event: PointerEvent) => {
      const p = pointers.get(event.pointerId);
      if (!p) {
        canvas.style.cursor = onRing(event) ? "grab" : "pointer";
        return;
      }
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const before = Math.hypot(a.x - b.x, a.y - b.y);
        p.x = event.clientX;
        p.y = event.clientY;
        const [c, d] = [...pointers.values()];
        zoom = Math.min(10, Math.max(4.2, zoom - (Math.hypot(c.x - d.x, c.y - d.y) - before) * 0.02));
        return;
      }
      const dx = (event.clientX - p.x) * 0.006;
      const dy = (event.clientY - p.y) * 0.006;
      if (down) down.moved += Math.abs(event.clientX - p.x) + Math.abs(event.clientY - p.y);
      if (down && down.moved < 6) {
        p.x = event.clientX;
        p.y = event.clientY;
        return;
      }
      canvas.style.cursor = "grabbing";
      if (target === "ring") {
        ringVX = dy;
        ringVZ = -dx;
        ring.rotation.x += dy;
        ring.rotation.z -= dx;
      } else {
        velY = dx;
        velX = dy;
        rotY += dx;
        rotX += dy;
      }
      p.x = event.clientX;
      p.y = event.clientY;
    };
    const onUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (down && down.moved < 6 && performance.now() - down.at < 450) live.current.onTap();
      if (!pointers.size) {
        target = null;
        down = null;
        canvas.style.cursor = "pointer";
      }
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom = Math.min(10, Math.max(4.2, zoom + event.deltaY * 0.004));
    };
    const onDouble = () => {
      ringVX = ringVZ = 0;
      ring.rotation.set(ringRest, 0, 0);
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("dblclick", onDouble);

    let bootT = 0;
    let scanT = 99;
    const v3 = new THREE.Vector3();
    const toScreen = (object: THREE.Object3D | null) => {
      const box = canvas.getBoundingClientRect();
      if (object) object.getWorldPosition(v3);
      else v3.set(0, 0, 0);
      v3.project(camera);
      return { x: box.left + ((v3.x + 1) / 2) * box.width, y: box.top + ((1 - v3.y) / 2) * box.height };
    };
    const wordSprite = (module: Module) => words.children.find((s) => s.userData.word === WORD_OF[module]) ?? null;
    api.current = {
      wordPos: (module) => {
        const sprite = wordSprite(module);
        return sprite ? toScreen(sprite) : null;
      },
      center: () => toScreen(null),
      boot: () => {
        bootT = 0;
        setBooted(false);
        window.setTimeout(() => setBooted(true), 1700);
      },
      scan: () => {
        scanT = 0;
      },
    };
    api.current.boot();

    let last = 0;
    let frame = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - (last || now)) / 1000);
      last = now;
      bootT += dt;
      scanT += dt;
      const { state: st, active: on, getLevel } = live.current;
      const speed = reduce ? 0 : { idle: 1, connecting: 1.4, listening: 1.6, speaking: 1.3, working: 3.6 }[st];
      const level = st === "speaking" || st === "listening" ? getLevel() : 0;

      // Pornire: carcasele cresc pe rând, apoi se aprinde miezul
      const sA = ease((bootT - 0.1) / 0.9);
      const sB = ease((bootT - 0.4) / 0.9);
      const sC = ease((bootT - 0.7) / 0.9);
      const sCore = ease((bootT - 1.2) / 0.6);
      shellA.scale.setScalar(sA);
      shellB.scale.setScalar(sB);
      shellC.scale.setScalar(sC);
      spiral.scale.setScalar(sA);
      core.scale.setScalar(sCore * (1 + level * 0.1 + (st === "listening" ? 0.03 : 0)));
      bloom.strength = 0.42 + 0.38 * sCore + level * 0.5 + (st === "working" ? 0.2 : 0);
      coreMat.uniforms.t.value = now / 1000;
      coreMat.uniforms.heat.value = Math.min(1, level * 1.5 + (st === "working" ? 0.6 : 0));
      coronaMat.uniforms.t.value = now / 1000;

      shellA.rotation.y += 0.12 * speed * dt;
      shellA.rotation.x += 0.05 * speed * dt;
      shellB.rotation.y -= 0.08 * speed * dt;
      shellB.rotation.z += 0.04 * speed * dt;
      shellC.rotation.y += 0.03 * speed * dt;
      spiral.rotation.y -= 0.25 * speed * dt;
      dashed.rotation.y += 0.1 * speed * dt;
      dust.rotation.y += 0.01 * speed * dt;
      words.rotation.y -= 0.05 * speed * dt;
      for (const sprite of words.children as THREE.Sprite[]) {
        const u = sprite.userData;
        const lit = on.includes((Object.keys(WORD_OF) as Module[]).find((m) => WORD_OF[m] === u.word) as Module);
        u.size += ((lit ? 1.45 : 1) - u.size) * 0.12;
        sprite.scale.set(1.1 * u.size, 0.21 * u.size, 1);
        sprite.material.opacity = (lit ? 1 : 0.7) * sC;
      }
      for (const piece of debris.children) {
        const u = piece.userData;
        u.a += u.s * speed * dt;
        piece.position.set(Math.cos(u.a) * u.r, Math.sin(u.a) * u.r, u.z + Math.sin(u.a * 3) * 0.04);
        piece.rotation.x += dt * 2;
        piece.rotation.y += dt * 1.3;
      }
      if (target !== "ring") {
        ring.rotation.x += ringVX;
        ring.rotation.z += ringVZ;
        ringVX *= 0.93;
        ringVZ *= 0.93;
      }
      (ring.material as THREE.MeshBasicMaterial).color.setHex(target === "ring" ? 0xffe6a8 : GOLD);

      // Scanare: la comandă, sau încet cât timp Argus lucrează
      const R = 2.3;
      const manual = scanT < 1.6;
      const sc = manual ? scanT / 1.6 : (now / 3000) % 1;
      const y = R * 0.95 - sc * R * 1.9;
      const r = Math.sqrt(Math.max(0.0025, R * R - y * y));
      const visible = manual ? Math.sin(Math.PI * sc) : st === "working" ? 0.55 * Math.sin(Math.PI * sc) : 0;
      scanRing.position.y = scanDisc.position.y = y;
      scanRing.scale.setScalar(r);
      scanDisc.scale.setScalar(r);
      (scanRing.material as THREE.MeshBasicMaterial).opacity = visible;
      (scanDisc.material as THREE.MeshBasicMaterial).opacity = visible * 0.12;

      if (!reduce) rotY += 0.0015 * speed;
      velX *= 0.92;
      velY *= 0.92;
      root.rotation.x = rotX;
      root.rotation.y = rotY;
      camera.position.z += (zoom - camera.position.z) * 0.12;
      composer.render();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDouble);
      api.current = null;
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(material) ? material : material ? [material] : []).forEach((m) => {
          (m as THREE.SpriteMaterial).map?.dispose();
          m.dispose();
        });
      });
      renderer.dispose();
    };
    // Scena se construiește o singură dată; starea vine prin `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={wrapRef}
      className={`orb orb-${state}`}
      role="button"
      tabIndex={0}
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Enter") onTap();
      }}
    >
      <canvas ref={canvasRef} className="orb-canvas" />
      <span className={booted ? "orb-name orb-name-on" : "orb-name"}>ARGUS</span>
    </div>
  );
});

export default Orb;
