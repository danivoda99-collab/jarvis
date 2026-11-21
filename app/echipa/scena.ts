// Sfera Argus cu agenții pe orbită (ecranul „Echipa”), după preview-ul ales de Daniel (orbita v5).
// Miezul e aceeași flacără ca în aplicație; fiecare agent e o piatră pe orbită, colorată după ce face.
// Cine așteaptă Da-ul lui Daniel coboară pe inelul interior; când un agent raportează, o cometă zboară spre miez.

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

export type Ton = "work" | "wait" | "ok" | "idle" | "urgent" | "sleep";
export type Satelit = { id: string; nume: string; ton: Ton; eticheta: string; forma?: string };

export type Scena = {
  actualizeaza: (agenti: Satelit[]) => void;
  raport: (id: string) => void;
  alege: (id: string) => void;
  noapte: (on: boolean) => void;
  opreste: () => void;
};

const FLAME = 0xff6a13;
const GOLD = 0xd4a64a;
const IVORY = 0xf4ecd8;
const CULOARE: Record<Ton, number> = { work: 0xff6a13, wait: 0xf2b33d, ok: 0x6fbf8e, idle: 0xd4a64a, urgent: 0xff5a4f, sleep: 0x4a4038 };

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
const WORDS = ["AGENDA", "SARCINI", "BUGET", "GMAIL", "TEAM VODA", "RUPEM TOPURILE", "WHATSAPP", "ONLINE", "MDS 2026", "FILODOXIA"];

const ORBIT_R = 4.3;
const INNER_R = 3.45;

function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.3, "rgba(255,255,255,.45)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// Fiecare agent are forma lui pe orbită, după personalitate.
function forma(nume?: string): THREE.BufferGeometry {
  const T = THREE;
  switch (nume) {
    case "scut": // Paznicul: un dodecaedru solid, ca un scut rotund
      return new T.DodecahedronGeometry(0.22, 0);
    case "cheie": // Suportul: o piuliță hexagonală
      return new T.CylinderGeometry(0.2, 0.2, 0.12, 6).rotateX(Math.PI / 2);
    case "carte": // Secretarul: o carte
      return new T.BoxGeometry(0.3, 0.38, 0.1);
    case "steag": // Managerul: un vârf ascuțit, ca un steag pe culme
      return new T.ConeGeometry(0.2, 0.42, 4);
    case "ochi": // Santinela: un ochi, sferă turtită
      return new T.SphereGeometry(0.2, 24, 12).scale(1.3, 0.75, 0.75);
    case "scanteie": // Evenimente: o stea cu patru colțuri
      return new T.OctahedronGeometry(0.24, 0).scale(1, 1.5, 0.45);
    case "spirala": // Îmbunătățirea: un nod care se tot rotește
      return new T.TorusKnotGeometry(0.13, 0.04, 64, 8);
    case "moneda": // Traderul: o monedă
      return new T.CylinderGeometry(0.22, 0.22, 0.06, 32).rotateX(Math.PI / 2);
    default:
      return new T.OctahedronGeometry(0.2, 0);
  }
}

type Sat = {
  g: THREE.Group;
  gem: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  cage: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  aura: THREE.Sprite;
  sel: THREE.Mesh;
  beam: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  parts: { s: THREE.Sprite; t: number; dir: number; sp: number }[];
  angle: number;
  flash: number;
  r: number;
  wp: THREE.Vector3;
  ton: Ton;
  el: HTMLButtonElement;
};

export function construiesteScena(stage: HTMLElement, labels: HTMLElement, agenti: Satelit[], laAlegere: (id: string) => void): Scena {
  const T = THREE;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new T.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x0d0a09, 1);
  stage.prepend(renderer.domElement);
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(45, 1, 0.1, 100);
  const root = new T.Group();
  scene.add(root);
  const additive = { transparent: true, blending: T.AdditiveBlending, depthWrite: false };
  const edges = (geo: THREE.BufferGeometry, color: number, opacity: number) =>
    new T.LineSegments(new T.EdgesGeometry(geo), new T.LineBasicMaterial({ color, opacity, ...additive }));
  const points = (count: number, place: (i: number, p: Float32Array, k: number) => void, color: number, size: number, opacity: number) => {
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) place(i, pos, i * 3);
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(pos, 3));
    return new T.Points(g, new T.PointsMaterial({ color, size, opacity, ...additive }));
  };
  const GLOW = glowTexture();
  const sprite = (color: number, size: number, opacity: number) => {
    const s = new T.Sprite(new T.SpriteMaterial({ map: GLOW, color, opacity, ...additive }));
    s.scale.set(size, size, 1);
    return s;
  };

  // Miezul cu flacără, coroana, carcasele și cuvintele: aceeași sferă ca pe ecranul principal.
  const coreMat = new T.ShaderMaterial({ uniforms: { t: { value: 0 }, heat: { value: 0.4 } }, vertexShader: VERTEX, fragmentShader: CORE_FRAGMENT });
  const coronaMat = new T.ShaderMaterial({ uniforms: { t: { value: 0 } }, vertexShader: VERTEX, fragmentShader: CORONA_FRAGMENT, ...additive });
  root.add(new T.Mesh(new T.SphereGeometry(0.95, 96, 96), coreMat), new T.Mesh(new T.SphereGeometry(1.1, 64, 64), coronaMat));
  const shellA = edges(new T.IcosahedronGeometry(1.35, 1), GOLD, 0.75);
  const shellB = edges(new T.IcosahedronGeometry(1.8, 2), FLAME, 0.35);
  const shellC = edges(new T.IcosahedronGeometry(2.25, 1), GOLD, 0.18);
  root.add(shellA, shellB, shellC);
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
  const words = new T.Group();
  WORDS.forEach((word, i) => {
    const paint = document.createElement("canvas");
    paint.width = 512;
    paint.height = 96;
    const pen = paint.getContext("2d")!;
    pen.font = '600 50px -apple-system, "Segoe UI", system-ui, sans-serif';
    pen.textBaseline = "middle";
    pen.fillStyle = i % 3 === 0 ? "#ff6a13" : "#d4a64a";
    pen.fillText(word, 8, 50);
    const tex = new T.CanvasTexture(paint);
    tex.minFilter = T.LinearFilter;
    const s = new T.Sprite(new T.SpriteMaterial({ map: tex, opacity: 0.55, ...additive }));
    const lat = (i / 10 - 0.45) * 2.2;
    const lon = i * 2.4;
    s.position.set(Math.cos(lon) * Math.cos(lat) * 2.05, Math.sin(lat) * 2.05 * 0.8, Math.sin(lon) * Math.cos(lat) * 2.05);
    s.scale.set(1.1, 0.21, 1);
    words.add(s);
  });
  root.add(words);
  const ring = new T.Mesh(new T.TorusGeometry(2.7, 0.01, 8, 200), new T.MeshBasicMaterial({ color: GOLD }));
  ring.rotation.x = Math.PI / 2.3;
  const debris = new T.Group();
  const shard = new T.TetrahedronGeometry(0.045);
  for (let i = 0; i < 54; i++) {
    const m = new T.Mesh(shard, new T.MeshBasicMaterial({ color: i % 4 ? FLAME : GOLD }));
    m.userData = { a: Math.random() * Math.PI * 2, r: 2.7 + (Math.random() - 0.5) * 0.32, s: 0.2 + Math.random() * 0.3, z: (Math.random() - 0.5) * 0.14 };
    debris.add(m);
  }
  ring.add(debris);
  const circle = (r: number) => Array.from({ length: 241 }, (_, i) => new T.Vector3(Math.cos((i / 240) * Math.PI * 2) * r, 0, Math.sin((i / 240) * Math.PI * 2) * r));
  const dashed = new T.Line(new T.BufferGeometry().setFromPoints(circle(3)), new T.LineDashedMaterial({ color: FLAME, dashSize: 0.35, gapSize: 0.18 }));
  dashed.computeLineDistances();
  dashed.rotation.x = Math.PI / 1.8;
  dashed.rotation.z = 0.35;
  scene.add(ring, dashed);
  const dust = points(
    900,
    (_, p, k) => {
      const r = 2.5 + Math.random() * 3.5;
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

  // Orbita agenților și inelul interior (cine așteaptă Da-ul lui Daniel).
  const orbit = new T.Group();
  orbit.rotation.x = 0.32;
  orbit.rotation.z = -0.08;
  scene.add(orbit);
  orbit.add(new T.Line(new T.BufferGeometry().setFromPoints(circle(ORBIT_R)), new T.LineBasicMaterial({ color: GOLD, opacity: 0.22, ...additive })));
  orbit.add(new T.Line(new T.BufferGeometry().setFromPoints(circle(INNER_R)), new T.LineBasicMaterial({ color: FLAME, opacity: 0.16, ...additive })));

  const sats = new Map<string, Sat>();
  const pickables: THREE.Mesh[] = [];
  const CORE = new T.Vector3();
  let selected = "";
  let night = false;

  agenti.forEach((a, i) => {
    const col = CULOARE[a.ton];
    const g = new T.Group();
    orbit.add(g);
    const gem = new T.Mesh(forma(a.forma), new T.MeshBasicMaterial({ color: col }));
    if (!a.forma) gem.scale.y = 1.4;
    const cage = edges(new T.IcosahedronGeometry(0.36, 0), col, 0.55);
    const aura = sprite(col, 1.5, 0.55);
    const sel = new T.Mesh(new T.TorusGeometry(0.5, 0.012, 6, 64), new T.MeshBasicMaterial({ color: GOLD, ...additive }));
    sel.visible = false;
    const hit = new T.Mesh(new T.SphereGeometry(0.6, 8, 8), new T.MeshBasicMaterial({ visible: false }));
    hit.userData.id = a.id;
    g.add(gem, cage, aura, sel, hit);
    pickables.push(hit);
    const beam = new T.Line(
      new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]),
      new T.LineBasicMaterial({ color: col, opacity: 0.3, ...additive }),
    );
    scene.add(beam);
    const parts = Array.from({ length: 6 }, (_, k) => {
      const s = sprite(k % 2 ? col : 0xfff1dc, 0.22, 1);
      scene.add(s);
      return { s, t: Math.random(), dir: k % 3 ? 1 : -1, sp: 0.35 + Math.random() * 0.3 };
    });
    const el = document.createElement("button");
    el.type = "button";
    el.innerHTML = '<span class="nm"></span><span class="dt"></span>';
    el.querySelector(".nm")!.textContent = a.nume;
    el.addEventListener("click", () => laAlegere(a.id));
    labels.appendChild(el);
    const sat: Sat = { g, gem, cage, aura, sel, beam, parts, angle: (i / agenti.length) * Math.PI * 2, flash: 0, r: ORBIT_R, wp: new T.Vector3(), ton: a.ton, el };
    sats.set(a.id, sat);
    paint(a.id, a.ton, a.eticheta);
  });

  function tonVizibil(s: Sat, id: string): Ton {
    return night && id !== "paznic" && (s.ton === "idle" || s.ton === "ok") ? "sleep" : s.ton;
  }

  function paint(id: string, ton: Ton, eticheta?: string) {
    const s = sats.get(id);
    if (!s) return;
    s.ton = ton;
    const vis = tonVizibil(s, id);
    const col = CULOARE[vis];
    s.gem.material.color.setHex(col);
    s.cage.material.color.setHex(col);
    (s.aura.material as THREE.SpriteMaterial).color.setHex(col);
    s.beam.material.color.setHex(col);
    s.beam.material.opacity = vis === "sleep" ? 0.03 : vis === "idle" ? 0.08 : 0.3;
    // Particulele dintre agent și miez: multe cât lucrează, câteva cât e ok, una cât așteaptă.
    const n = vis === "work" || vis === "urgent" ? 6 : vis === "ok" ? 2 : vis === "wait" ? 1 : 0;
    s.parts.forEach((p, k) => (p.s.visible = k < n));
    s.el.className = `sat ${vis}${id === selected ? " sel" : ""}`;
    if (eticheta !== undefined) s.el.querySelector(".dt")!.textContent = eticheta;
  }

  const comets: { s: Sat; head: THREE.Sprite; tail: THREE.Sprite[]; k: number }[] = [];
  let flare = 0;
  function raport(id: string) {
    const s = sats.get(id);
    if (!s || reduce) return;
    s.flash = 1;
    const col = CULOARE[s.ton];
    const head = sprite(0xfff1dc, 0.55, 1);
    scene.add(head);
    const tail = Array.from({ length: 6 }, (_, k) => {
      const t = sprite(col, 0.38 - k * 0.05, 0.7 - k * 0.1);
      scene.add(t);
      return t;
    });
    comets.push({ s, head, tail, k: 0 });
  }

  let composer: EffectComposer | null = null;
  let bloom: UnrealBloomPass | null = null;
  try {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new T.Vector2(512, 512), 0.7, 0.45, 0.5);
    composer.addPass(bloom);
  } catch {
    composer = null;
  }
  let zoom = 11;
  function resize() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    renderer.setSize(w, h, false);
    composer?.setSize(w, h);
    camera.aspect = w / h;
    // Pe telefon (ecran îngust) camera se trage înapoi, ca toată orbita să încapă.
    zoom = camera.aspect < 1.2 ? (11 / Math.max(camera.aspect, 0.5)) * 1.25 : 11;
    camera.updateProjectionMatrix();
  }
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(stage);

  let rotY = 0;
  let rotX = 0.18;
  let vel = 0;
  let down: { x: number; y: number } | null = null;
  let moved = 0;
  const ray = new T.Raycaster();
  const ndc = new T.Vector2();
  const cv = renderer.domElement;
  cv.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY };
    moved = 0;
  });
  cv.addEventListener("pointermove", (e) => {
    if (!down) return;
    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    moved += Math.abs(dx) + Math.abs(dy);
    // Doar tragerea orizontală rotește; cea verticală lasă pagina să se deruleze pe telefon.
    if (Math.abs(dx) < Math.abs(dy) && e.pointerType === "touch") return;
    rotY += dx * 0.006;
    rotX = Math.max(-0.4, Math.min(0.7, rotX + dy * 0.004));
    vel = dx * 0.006;
    down = { x: e.clientX, y: e.clientY };
  });
  const up = (e: PointerEvent) => {
    if (down && moved < 8) {
      const r = cv.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const h = ray.intersectObjects(pickables)[0];
      if (h) laAlegere(h.object.userData.id as string);
    }
    down = null;
  };
  cv.addEventListener("pointerup", up);
  cv.addEventListener("pointercancel", () => (down = null));

  const v = new T.Vector3();
  let last = performance.now();
  let raf = 0;
  let running = true;
  function frame(now: number) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now / 1000;
    const sp = reduce ? 0 : 1;
    coreMat.uniforms.t.value = t;
    coronaMat.uniforms.t.value = t;
    shellA.rotation.y += 0.12 * sp * dt;
    shellA.rotation.x += 0.05 * sp * dt;
    shellB.rotation.y -= 0.08 * sp * dt;
    shellB.rotation.z += 0.04 * sp * dt;
    shellC.rotation.y += 0.03 * sp * dt;
    spiral.rotation.y -= 0.25 * sp * dt;
    dashed.rotation.y += 0.1 * sp * dt;
    dust.rotation.y += 0.01 * sp * dt;
    words.rotation.y -= 0.05 * sp * dt;
    for (const m of debris.children) {
      const u = m.userData as { a: number; r: number; s: number; z: number };
      u.a += u.s * sp * dt;
      m.position.set(Math.cos(u.a) * u.r, Math.sin(u.a) * u.r, u.z);
      m.rotation.x += dt * 2 * sp;
    }
    if (!down) {
      vel *= 0.94;
      rotY += vel + 0.04 * sp * dt;
    }
    root.rotation.set(0, rotY * 0.6, 0);
    camera.position.set(Math.sin(rotY) * zoom * Math.cos(rotX), Math.sin(rotX) * zoom + 1.2, Math.cos(rotY) * zoom * Math.cos(rotX));
    camera.lookAt(0, 0, 0);
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    for (const [id, s] of sats) {
      const st = tonVizibil(s, id);
      const busy = st === "work" || st === "urgent";
      s.angle += dt * sp * (st === "sleep" ? 0.04 : 0.12);
      const target = st === "urgent" ? 3.0 : st === "wait" ? INNER_R : ORBIT_R;
      s.r += (target - s.r) * Math.min(1, dt * 1.8);
      s.g.position.set(Math.cos(s.angle) * s.r, Math.sin(t * 1.3 + s.angle * 3) * 0.12 * sp, Math.sin(s.angle) * s.r);
      s.gem.rotation.y += dt * sp * (busy ? 2.4 : 0.8);
      s.cage.rotation.y -= dt * sp * (busy ? 1.2 : 0.4);
      s.cage.rotation.x += dt * sp * 0.5;
      s.flash = Math.max(0, s.flash - dt * 1.1);
      const pulse = st === "urgent" ? (Math.sin(t * 9) + 1) * 0.35 : st === "wait" ? (Math.sin(t * 4) + 1) * 0.18 : 0;
      (s.aura.material as THREE.SpriteMaterial).opacity =
        st === "sleep" ? 0.08 : 0.45 + s.flash * 0.6 + pulse + (busy ? Math.sin(t * 5 + s.angle) * 0.12 : 0);
      s.aura.scale.setScalar(1.5 + s.flash * 1.2 + pulse * 1.2);
      s.sel.lookAt(camera.position);
      s.sel.visible = id === selected;
      s.g.getWorldPosition(s.wp);
      const pos = s.beam.geometry.attributes.position as THREE.BufferAttribute;
      pos.setXYZ(0, s.wp.x, s.wp.y, s.wp.z);
      pos.setXYZ(1, 0, 0, 0);
      pos.needsUpdate = true;
      for (const p of s.parts) {
        if (!p.s.visible) continue;
        p.t = (p.t + dt * p.sp * sp) % 1;
        const k = p.dir > 0 ? p.t : 1 - p.t;
        p.s.position.lerpVectors(s.wp, CORE, k);
        (p.s.material as THREE.SpriteMaterial).opacity = Math.sin(k * Math.PI);
      }
      v.copy(s.wp).project(camera);
      s.el.style.left = `${((v.x + 1) / 2) * w}px`;
      s.el.style.top = `${((1 - v.y) / 2) * h}px`;
      const behind = s.wp.clone().sub(camera.position).length() > camera.position.length() + 0.5;
      s.el.style.opacity = behind ? "0.35" : "1";
    }
    for (let i = comets.length - 1; i >= 0; i--) {
      const c = comets[i];
      c.k = Math.min(1, c.k + dt / 0.95);
      const e = c.k * c.k * (3 - 2 * c.k);
      c.head.position.lerpVectors(c.s.wp, CORE, e);
      c.tail.forEach((tl, j) => tl.position.lerpVectors(c.s.wp, CORE, Math.max(0, e - (j + 1) * 0.05)));
      if (c.k >= 1) {
        scene.remove(c.head, ...c.tail);
        comets.splice(i, 1);
        flare = 1;
      }
    }
    flare = Math.max(0, flare - dt * 1.4);
    coreMat.uniforms.heat.value = (night ? 0.05 : 0.4) + flare * 0.9;
    if (bloom) bloom.strength = (night ? 0.4 : 0.6) + Math.sin(t * 1.8) * 0.08 + flare * 0.55;
    words.children.forEach((wd) => (((wd as THREE.Sprite).material as THREE.SpriteMaterial).opacity = night ? 0.15 : 0.55));
    if (composer) composer.render();
    else renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  // Pagina ascunsă (telefon blocat, alt tab): sfera nu mai consumă baterie.
  const visibility = () => {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(raf);
    } else if (!running) {
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };
  document.addEventListener("visibilitychange", visibility);

  return {
    actualizeaza(lista) {
      for (const a of lista) paint(a.id, a.ton, a.eticheta);
    },
    raport,
    alege(id) {
      selected = id;
      for (const [k, s] of sats) paint(k, s.ton);
    },
    noapte(on) {
      night = on;
      renderer.setClearColor(on ? 0x070504 : 0x0d0a09, 1);
      for (const [k, s] of sats) paint(k, s.ton);
    },
    opreste() {
      running = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      labels.replaceChildren();
      renderer.dispose();
      cv.remove();
    },
  };
}
