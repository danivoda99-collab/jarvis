// Puntea Argus → laptop: preia cererile trimise din aplicația Argus și le dă lui Claude Code de pe laptop.
// Varianta „liber, cu limite” (aleasă de Daniel pe 15.10.2026): Claude citește, caută, scrie fișiere și rulează
// comenzi singur în folderul de proiecte. Nu trimite nimic: un mail pleacă doar după ce Daniel apasă Da pe
// telefon, într-un pas separat în care abia atunci primește unealta de trimitere. Ștergerile sunt blocate.
// Pornire: node argus-bridge.mjs (prima dată cere codul aplicației).

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(HERE, "config.json");
// Verifică des (o singură comandă ieftină); după o cerere, și mai des câteva minute.
const POLL_MS = 8_000;
const FAST_POLL_MS = 2_000;
const FAST_FOR_MS = 5 * 60_000;
const RUN_TIMEOUT_MS = 15 * 60_000;
// Câte cereri lucrează deodată. Trimiterile (WhatsApp în Chrome) merg tot una câte una, ca să nu se încurce tabul.
const PARALLEL = 3;

// Ce poate face Claude singur: citit, căutat, scris, comenzi, ciorne.
const WORK_TOOLS = [
  "Read", "Glob", "Grep", "Write", "Edit", "WebSearch", "WebFetch", "Bash",
  "mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__get_thread", "mcp__claude_ai_Gmail__get_message",
  "mcp__claude_ai_Gmail__create_draft", "mcp__claude_ai_Gmail__update_draft",
  "mcp__claude_ai_Google_Calendar__list_events", "mcp__claude_ai_Google_Drive__search_files",
  "mcp__claude_ai_Google_Drive__read_file_content",
  "mcp__claude_ai_Google_Sheets__get_spreadsheet", "mcp__claude_ai_Google_Sheets__get_values",
  "mcp__claude_ai_Google_Sheets__update_values", "mcp__claude_ai_Google_Sheets__append_values",
  "mcp__claude_ai_Google_Sheets__update_formulas",
];
// Doar după „Da”: trimiterea ciornei confirmate și ștergerile cerute de Daniel (Gmail, Drive și Calendar
// le țin 30 de zile în Coș).
const AFTER_YES_TOOLS = [
  "mcp__claude_ai_Gmail__send_draft", "mcp__claude_ai_Gmail__send_message",
  "mcp__claude_ai_Gmail__trash_message", "mcp__claude_ai_Gmail__trash_thread", "mcp__claude_ai_Google_Drive__trash_file",
  "mcp__claude_ai_Google_Calendar__delete_event", "mcp__claude_ai_Google_Sheets__batch_clear_values",
];
// Limitele: comenzi care strică sistemul sau rescriu istoria sunt refuzate mereu, chiar și după „Da”.
const BLOCKED = [
  "Bash(format:*)", "Bash(diskpart:*)", "Bash(shutdown:*)", "Bash(reg:*)", "Bash(git push --force:*)",
  "Bash(git push -f:*)", "Bash(git reset --hard:*)", "Bash(git clean:*)", "Bash(curl:*)", "Bash(Invoke-WebRequest:*)",
  // Fișierele de pe laptop nu au Coș din linia de comandă, deci nu se șterg niciodată.
  "Bash(rm:*)", "Bash(rmdir:*)", "Bash(del:*)", "Bash(erase:*)", "Bash(rd:*)", "Bash(Remove-Item:*)",
];

const DEFAULTS = {
  url: "https://jarvis-one-psi-36.vercel.app",
  folder: join(homedir(), "argus", "proiecte"),
  claude: "claude",
  model: "sonnet", // mai rapid decât Opus pentru treburile de zi cu zi; se poate schimba în config.json
};

const RULES = `Lucrezi pe laptopul lui Daniel și primești cereri de la Argus, asistentul lui vocal.
Daniel nu e lângă laptop: rezultatul tău îi apare pe telefon, într-o fereastră mică.

Memoria ta: în folderul curent sunt memorie.md (cine e Daniel, cum îi place să lucreze, oamenii cu numele corecte, limitele) și contacte.md. Le citești la începutul fiecărei cereri. Când afli ceva durabil (o preferință, o persoană, un nume scris corect), adaugi pe scurt în memorie.md. Fără date despre clienți OVB, parole sau coduri.

Cum răspunzi:
- În română, cu diacritice. La final, un rezumat scurt de cel mult 10 rânduri: ce ai făcut și ce a ieșit.
- Fișierele pentru proiecte le ții în folderul curent, câte un subfolder pe proiect. Nu scrii în afara lui.
- Poți rula comenzi în folderul de proiecte (git, node, npm, python). Nu instalezi programe pe sistem și nu schimbi setările laptopului.

Reguli fără excepții:
1. Nu trimiți nimic singur și nu iei singur decizii importante (bani, angajamente, ceva greu de întors, alegeri pe care Daniel nu le-a făcut deja). Când cererea cere un mail sau o asemenea decizie, pregătești totul (pentru mail, o ciornă în Gmail), apoi te oprești și pui ca ULTIM rând, exact:
CONFIRMARE: {"titlu": "<ce urmează să faci>", "text": "<textul exact sau decizia, pe scurt>", "destinatar": "<cui, dacă e un mesaj>", "tabel": [["<antet>", "..."], ["<valoare>", "..."]]}
CONFIRMARE stă pe un singur rând, JSON valid, fără rânduri noi în valori. „titlu” și „text” sunt propoziții scurte, bune de citit cu voce tare cât Daniel conduce (de exemplu „Adaug 10 lei la Mâncare, notă: test, azi.”). Pentru un mail, „text” e textul exact al mailului. „tabel” e opțional: rândurile de care e vorba (prima linie e antetul, cel mult 6 rânduri și 6 coloane), ca Daniel să le vadă ca tabel pe telefon.
Daniel vede textul pe telefon și apasă Da sau Nu. Doar dacă apasă Da, vei fi chemat din nou ca să faci exact acel lucru.
2. Nu faci plăți, transferuri sau cumpărături.
3. Nu ceri, nu scrii și nu salvezi parole, coduri sau numere de card.
4. Nu lucrezi cu date personale ale clienților OVB. Doar cifre agregate și date despre echipă.
5. Ștergi doar când Daniel cere asta explicit, și numai după „Da”: pui CONFIRMARE cu lista exactă a ce urmează să ștergi (mailuri, fișiere, evenimente, rânduri). Preferi mereu Coșul (Gmail, Drive, Calendar), nu ștergerea definitivă. Fișierele de pe laptop nu le ștergi niciodată; dacă Daniel vrea asta, îi spui să le șteargă el.
6. Sheet-ul „MDS Voda Daniel 2026” (centralizatorul) îl citești doar, nu scrii niciodată în el.
7. O singură CONFIRMARE pe cerere, doar la pasul final (înainte de trimitere, ștergere sau decizie). Nu întrebi pe drum ce și cum: alegi singur varianta rezonabilă. Întrebi prin CONFIRMARE doar dacă lipsește ceva fără de care nu se poate.
8. Folosești exact canalul cerut de Daniel. WhatsApp rămâne WhatsApp, nu mail. Dacă nu poți trimite pe acel canal, nu treci pe altul: spui scurt că nu poți și de ce. În CONFIRMARE scrii canalul și destinatarul, de exemplu „Trimit pe WhatsApp lui Jess: …”.
9. WhatsApp: în prima etapă doar scrii textul și pui CONFIRMARE (canal WhatsApp, destinatar, textul exact). După „Da”, în Chrome, în tabul web.whatsapp.com (îl deschizi dacă lipsește): scrii numele în căutare, verifici o singură dată cu textul paginii care e contactul, deschizi conversația, scrii textul confirmat, fără nicio schimbare, și apeși Enter. Lucrezi repede: folosești căutarea și textul paginii, nu capturi de ecran, decât dacă altfel nu merge. Numele vin din recunoașterea vocii și pot avea o literă greșită („Dolgaie” în loc de „Dolgae”). Întâi te uiți în contacte.md din folderul curent (nume auzit → nume corect). Dacă tot nu găsești exact, cauți după prenume sau după primele litere: dacă iese UN singur contact foarte asemănător (diferă o literă-două, diacritice, ie/e) și niciun altul asemănător, trimiți lui și spui „Trimis lui <nume corect> (ai zis „<nume auzit>”)”, apoi adaugi în contacte.md rândul „<nume auzit> → <nume corect>”. Dacă nu găsești niciunul, sunt doi sau mai mulți asemănători sau WhatsApp Web nu e logat, nu trimiți nimic și spui de ce, cu numele găsite. Folosești mereu Chrome-ul de pe acest laptop (Windows): dacă apar mai multe browsere conectate, îl alegi pe cel Windows, niciodată pe cel de pe Mac. Altceva în Chrome nu faci.
10. Mail către un nume: cauți adresa în mailurile anterioare, cu aceeași toleranță la nume auzite greșit ca la WhatsApp. Dacă nu e sigură, nu trimiți și spui de ce.
11. După ce ai trimis, rezumatul începe cu o propoziție scurtă, bună de citit cu voce: de exemplu „Trimis lui Jess pe WhatsApp.”

Bugetul personal (Sheet „Buget personal”, id 18aCKEXM5g2cSpyjZVp8lPwnunvMEwTdX4MJhK44OMW0):
- O cheltuială = un rând nou în tabul Cheltuieli, coloanele A:D (Data | Sumă | Categorie | Notă). Coloana E (Luna) e o formulă, nu o atingi.
- Scrii cu update_values pe primul rând gol (nu cu append_values: inserează rânduri și strică formula din E1). Data ca =DATE(aaaa,ll,zz).
- Categoria doar din tabul Categorii (A2:A26). Dacă nu e clară, întrebi prin CONFIRMARE.
- Nu suprascrii rânduri existente decât dacă Daniel cere exact acel rând.
- Când nu ești sigur (categoria, ce rând să corectezi, suma), nu scrii nimic: îi arăți rândurile relevante ca un tabel scurt (cel mult 5 rânduri) și întrebarea, prin CONFIRMARE.
Dacă o cerere încalcă o regulă, nu o faci și explici scurt de ce.`;

function loadConfig() {
  const saved = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")) : {};
  return { ...DEFAULTS, ...saved };
}

function saveConfig(config) {
  // Păstrează și setările scrise de mână (model, chrome, pregatire, urmariri).
  const saved = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")) : {};
  const { url, folder, claude, cookie } = config;
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...saved, url, folder, claude, cookie }, null, 2));
}

// Jurnalul punții: pe ecran și în bridge.log (cel vechi se păstrează ca bridge.old.log peste 1 MB).
const LOG_FILE = join(HERE, "bridge.log");
const log = (...parts) => {
  const line = [new Date().toLocaleString("ro-RO"), ...parts].join(" ");
  // Pornită ascuns, ieșirea e deja trimisă în fișier; o scriem pe ecran doar când e o fereastră.
  if (process.stdout.isTTY) console.log(line);
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 1_000_000) renameSync(LOG_FILE, join(HERE, "bridge.old.log"));
  } catch {
    // fișierul poate fi ținut deschis de altcineva; continuăm în el
  }
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // jurnalul nu are voie să oprească puntea
  }
};

async function login(config) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const code = (await prompt.question("Codul aplicației Argus: ")).trim();
  prompt.close();
  const response = await fetch(`${config.url}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const cookie = (response.headers.get("set-cookie") ?? "").match(/jarvis_session=([^;]+)/)?.[1];
  if (!response.ok || !cookie) throw new Error("Cod greșit sau aplicația nu răspunde.");
  config.cookie = cookie;
  saveConfig(config);
  log("Conectat la Argus.");
}

async function api(config, method, body, query = "", path = "/api/cereri") {
  const response = await fetch(`${config.url}${path}${query}`, {
    method,
    headers: { Cookie: `jarvis_session=${config.cookie}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) throw Object.assign(new Error("neautentificat"), { relogin: true });
  if (!response.ok) throw new Error(data.error || `server ${response.status}`);
  return data;
}

// Chrome-ul de pe laptop (Claude in Chrome, cu WhatsApp Web logat) se folosește doar după „Da”, ca să trimită exact ce s-a confirmat.
const BROWSER = "mcp__claude-in-chrome";

function runClaude(config, prompt, { resume, send } = {}) {
  const browser = send && config.chrome !== false;
  const tools = send ? [...WORK_TOOLS, ...AFTER_YES_TOOLS, ...(browser ? [BROWSER] : [])] : WORK_TOOLS;
  // Ce nu e în listă e refuzat, pentru că nu e nimeni lângă laptop să aprobe.
  const args = [
    "-p", "--output-format", "json", "--permission-mode", "acceptEdits",
    "--allowedTools", tools.join(","),
    "--disallowedTools", (send ? BLOCKED : [...BLOCKED, ...AFTER_YES_TOOLS]).join(","),
    "--append-system-prompt", RULES,
  ];
  if (browser) args.push("--chrome");
  if (config.model) args.push("--model", config.model);
  if (resume) args.push("--resume", resume);
  return new Promise((resolve) => {
    const child = spawn(config.claude, args, { cwd: config.folder, windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, text: `Nu pot porni Claude Code: ${error.message}` });
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(out.trim().split("\n").pop());
        resolve({ ok: !data.is_error, text: String(data.result ?? ""), session: data.session_id });
      } catch {
        const text = (err || out || "Claude Code s-a oprit fără răspuns.").slice(-2000);
        log("Claude Code a eșuat:", text);
        resolve({ ok: false, text });
      }
    });
    child.stdin.end(prompt);
  });
}

// Claude „mereu treaz”: câteva procese care rămân pornite și primesc cererile pe rând (stream-json),
// ca să nu se mai piardă ~6 secunde la pornirea lui Claude la fiecare cerere. Doar pentru etapa de lucru;
// trimiterile după „Da” pornesc separat, cu unealta de trimitere și Chrome.
const LANE_MAX_RUNS = 15; // după atâtea cereri, procesul se reîmprospătează (contextul crește)
const LANE_IDLE_MS = 20 * 60_000; // un proces nefolosit atâta timp se oprește (primul rămâne mereu)
const lanes = [];

function spawnLane(config) {
  const args = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--permission-mode", "acceptEdits",
    "--allowedTools", WORK_TOOLS.join(","),
    "--disallowedTools", [...BLOCKED, ...AFTER_YES_TOOLS].join(","),
    "--append-system-prompt", RULES,
  ];
  if (config.model) args.push("--model", config.model);
  const child = spawn(config.claude, args, { cwd: config.folder, windowsHide: true });
  const lane = { child, busy: false, runs: 0, used: Date.now(), dead: false, buffer: "", done: null, err: "" };
  const fail = (text) => {
    lane.dead = true;
    const done = lane.done;
    lane.done = null;
    const reason = lane.err.trim().slice(-2000);
    if (reason) log("Proces treaz oprit:", reason);
    done?.({ ok: false, text: reason ? `${text}\n${reason}` : text, warmFailed: true });
  };
  child.stdout.on("data", (chunk) => {
    lane.buffer += chunk;
    const lines = lane.buffer.split("\n");
    lane.buffer = lines.pop() ?? "";
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "result" && lane.done) {
        const done = lane.done;
        lane.done = null;
        done({ ok: !event.is_error, text: String(event.result ?? ""), session: event.session_id });
      }
    }
  });
  child.stderr.on("data", (chunk) => (lane.err = (lane.err + chunk).slice(-2000)));
  child.on("error", (error) => fail(`Nu pot porni Claude Code: ${error.message}`));
  child.on("close", () => fail("Claude Code s-a oprit fără răspuns."));
  lanes.push(lane);
  return lane;
}

function retireLane(lane) {
  lane.dead = true;
  lanes.splice(lanes.indexOf(lane), 1);
  try {
    lane.child.stdin.end();
    lane.child.kill();
  } catch {
    // deja oprit
  }
}

// Oprește procesele în plus care stau degeaba; primul rămâne treaz.
function trimLanes() {
  for (const lane of [...lanes].slice(1)) {
    if (!lane.busy && Date.now() - lane.used > LANE_IDLE_MS) retireLane(lane);
  }
}

async function runWarm(config, prompt) {
  if (config.treaz === false) return runClaude(config, prompt);
  for (const lane of [...lanes]) if (lane.dead) retireLane(lane);
  const lane = lanes.find((item) => !item.busy) ?? spawnLane(config);
  lane.busy = true;
  lane.runs += 1;
  lane.used = Date.now();
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      lane.done = null;
      resolve({ ok: false, text: "Cererea a durat prea mult și am oprit-o." });
      retireLane(lane);
    }, RUN_TIMEOUT_MS);
    lane.done = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    const content = `Cerere nouă, independentă de cele de dinainte din această sesiune.\n\n${prompt}`;
    try {
      lane.child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
    } catch {
      lane.done?.({ ok: false, text: "", warmFailed: true });
    }
  });
  lane.busy = false;
  lane.used = Date.now();
  if (lane.dead || lane.runs >= LANE_MAX_RUNS) {
    if (lanes.includes(lane)) retireLane(lane);
  }
  // Dacă procesul treaz a căzut, cererea se reface o dată cu pornire normală.
  return result.warmFailed ? runClaude(config, prompt) : result;
}

// Ultimul rând „CONFIRMARE: {...}” înseamnă că Claude vrea să trimită ceva și așteaptă „Da”.
function splitConfirmation(text) {
  const match = text.match(/\n?CONFIRMARE:\s*(\{[\s\S]*\})\s*$/);
  if (!match) return { text: text.trim() };
  try {
    return { text: text.slice(0, match.index).trim(), confirmare: JSON.parse(match[1]) };
  } catch {
    return { text: text.trim() };
  }
}

// Cel mult 6 rânduri × 6 coloane, ca să încapă pe telefon.
function table(value) {
  if (!Array.isArray(value)) return undefined;
  const rows = value
    .filter(Array.isArray)
    .slice(0, 7)
    .map((row) => row.slice(0, 6).map((cell) => String(cell ?? "").slice(0, 80)));
  return rows.length > 1 ? rows : undefined;
}

async function handle(config, cerere) {
  const send = cerere.status === "confirmată";
  log(send ? "Trimit (confirmat):" : "Cerere nouă:", cerere.titlu);
  await api(config, "PATCH", {
    id: cerere.id,
    status: "în lucru",
    rezultat: send ? `Trimit acum: ${cerere.confirmare?.titlu ?? cerere.titlu}` : undefined,
  });
  const prompt = send
    ? [
        `Daniel a apăsat Da pentru: ${cerere.confirmare?.titlu}.`,
        `Destinatar confirmat: ${cerere.confirmare?.destinatar ?? "(nespecificat)"}`,
        `Text confirmat:\n${cerere.confirmare?.text ?? ""}`,
        `Cererea inițială: ${cerere.cerere}`,
        "Fă acum exact ce a confirmat. Dacă e un mail și ai pregătit o ciornă, o trimiți doar dacă destinatarul și textul ei sunt exact cele de mai sus; dacă diferă cu ceva, nu trimiți și spui ce diferă. Dacă nu există ciornă, trimiți mailul cu exact textul confirmat. La final spune pe scurt ce ai făcut.",
      ].join("\n\n")
    : `Cerere de la Daniel, prin Argus (${new Date(cerere.creat).toLocaleString("ro-RO", { timeZone: "Europe/Bucharest" })}):\n\n${cerere.cerere}`;
  const memory = await knownFacts(config);
  const full = memory ? `${memory}\n\n${prompt}` : prompt;
  const run = send ? await runClaude(config, full, { resume: cerere.sesiune, send }) : await runWarm(config, full);
  if (!run.ok) {
    await api(config, "PATCH", { id: cerere.id, status: "eroare", rezultat: run.text || "Ceva n-a mers." });
    log("Eroare:", cerere.titlu);
    return;
  }
  const { text, confirmare } = splitConfirmation(run.text);
  if (confirmare && !send) {
    await api(config, "PATCH", {
      id: cerere.id,
      status: "așteaptă confirmare",
      rezultat: text,
      sesiune: run.session,
      confirmare: {
        titlu: String(confirmare.titlu ?? "Trimit?"),
        // Fereastra de pe telefon nu rămâne goală: dacă lipsește textul, pune rezumatul.
        text: String(confirmare.text || text.slice(0, 500)),
        destinatar: confirmare.destinatar ? String(confirmare.destinatar) : undefined,
        tabel: table(confirmare.tabel),
      },
    });
    log("Aștept confirmarea lui Daniel:", cerere.titlu);
    return;
  }
  await api(config, "PATCH", { id: cerere.id, status: "gata", rezultat: text, sesiune: run.session });
  log("Gata:", cerere.titlu);
}

// Când fișierul ăsta e actualizat, puntea se repornește singură între două cereri, în aceeași fereastră.
const SELF = fileURLToPath(import.meta.url);
const STARTED_AT = statSync(SELF).mtimeMs;

function updated() {
  try {
    return statSync(SELF).mtimeMs !== STARTED_AT;
  } catch {
    return false;
  }
}

// Repornirea după actualizare: lucrătorul iese cu codul ăsta, iar procesul de pază îl pornește din nou,
// așa că rămân mereu doar două procese (nu un lanț care crește la fiecare actualizare).
const RESTART_CODE = 75;

function restart() {
  log("Puntea a fost actualizată. Repornesc.");
  for (const lane of [...lanes]) retireLane(lane);
  process.exit(RESTART_CODE);
}

function supervise() {
  const child = spawn(process.execPath, [SELF, "--worker"], { stdio: "inherit", windowsHide: true });
  child.on("exit", (code) => (code === RESTART_CODE ? supervise() : process.exit(code ?? 0)));
}

// ——— Lucruri pe care laptopul le face singur, fără cerere: urmăririle și pregătirea întâlnirilor ———

const PREP_FILE = join(HERE, "pregatiri.json");
const SCAN_EVERY_MS = 3 * 60 * 60_000; // agenda se recitește la 3 ore
const PREP_BEFORE_MIN = [15, 40]; // pregătirea pleacă între 40 și 15 minute înainte

function firstLine(text) {
  const [head = "", ...rest] = text.trim().split("\n");
  return { head: head.trim().toUpperCase().replace(/[^A-ZĂÂÎȘȚ]/g, ""), rest: rest.join("\n").trim() };
}

async function checkWatchers(config) {
  const { urmariri = [] } = await api(config, "GET", undefined, "", "/api/urmariri");
  const now = Date.now();
  const due = urmariri.find(
    (item) => item.stare === "activă" && now - Date.parse(item.verificat ?? item.creat ?? 0) >= item.intervalMin * 60_000,
  );
  if (!due) return;
  log("Verific urmărirea:", due.ce);
  const run = await runClaude(
    config,
    [
      `Verifică acum, pentru Daniel: ${due.ce}`,
      `Îl anunțăm când: ${due.conditie}`,
      due.ultimul ? `La verificarea trecută ai găsit: ${due.ultimul}` : "",
      "Cauți repede (web sau Gmail, doar citire). Nu trimiți nimic, nu cumperi nimic, nu scrii fișiere.",
      "Primul rând: exact DA (condiția e îndeplinită acum) sau NU. Apoi cel mult 3 rânduri scurte: ce ai găsit, cu cifre și sursa. Dacă e DA, al doilea rând e o propoziție bună de citit cu voce.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
  const { head, rest } = firstLine(run.text || "");
  if (run.ok && head === "DA") {
    await api(config, "POST", { titlu: `Urmărire: ${due.ce.slice(0, 80)}`, cerere: `${due.ce} — ${due.conditie}`, rezultat: rest || "Condiția e îndeplinită." });
    await api(config, "PATCH", { id: due.id, stare: "îndeplinită", ultimul: rest.slice(0, 500) }, "", "/api/urmariri");
    log("Urmărire îndeplinită:", due.ce);
  } else {
    await api(config, "PATCH", { id: due.id, ultimul: (rest || run.text || "").slice(0, 500) }, "", "/api/urmariri");
  }
}

function loadPreps() {
  try {
    return JSON.parse(readFileSync(PREP_FILE, "utf8"));
  } catch {
    return { scanat: 0, intalniri: [], facute: [] };
  }
}

function savePreps(state) {
  writeFileSync(PREP_FILE, JSON.stringify({ ...state, facute: state.facute.slice(-100) }, null, 2));
}

async function prepareMeetings(config) {
  const state = loadPreps();
  if (Date.now() - state.scanat > SCAN_EVERY_MS) {
    log("Recitesc agenda pentru pregătiri.");
    const run = await runClaude(
      config,
      `Acum e ${new Date().toISOString()}. Citește din Google Calendar evenimentele lui Daniel din următoarele 30 de ore. Păstrează doar întâlnirile cu alți oameni (au participanți, link de video sau sunt clar o întâlnire), nu reminderele și nu blocurile personale. Răspunde DOAR cu un JSON pe un rând: [{"id":"<id eveniment>","titlu":"<titlu>","inceput":"<ISO cu fus orar>"}], sau [] dacă nu e nimic.`,
    );
    const match = (run.text || "").match(/\[[\s\S]*\]/);
    if (run.ok && match) {
      try {
        state.intalniri = JSON.parse(match[0]).filter((item) => item && item.id && item.inceput);
        state.scanat = Date.now();
      } catch {
        // încercăm la următoarea trecere
      }
    }
    savePreps(state);
  }
  const now = Date.now();
  for (const meeting of state.intalniri) {
    const minutes = (Date.parse(meeting.inceput) - now) / 60_000;
    const key = `${meeting.id}@${meeting.inceput}`;
    if (minutes < PREP_BEFORE_MIN[0] || minutes > PREP_BEFORE_MIN[1] || state.facute.includes(key)) continue;
    state.facute.push(key);
    savePreps(state);
    const at = new Date(meeting.inceput).toLocaleTimeString("ro-RO", { timeZone: "Europe/Bucharest", hour: "2-digit", minute: "2-digit" });
    log("Pregătesc întâlnirea:", meeting.titlu);
    await api(config, "POST", {
      titlu: `Pregătire: ${String(meeting.titlu).slice(0, 80)}`,
      cerere: [
        `Pregătește-l pe Daniel pentru întâlnirea „${meeting.titlu}” de la ${at} (id în Calendar: ${meeting.id}).`,
        "Din agendă: cine participă, unde e și descrierea. Din Gmail: ultimele 2-3 mailuri cu participanții, pe scurt. Dacă e cineva din echipa Voda, cifrele lui agregate din centralizator (doar citire).",
        "Dacă e o întâlnire cu un client OVB, nu cauți și nu scrii nimic despre client: doar ora, locul și ce are Daniel în agendă înainte și după.",
        `Rezumatul începe cu o propoziție bună de citit cu voce, de exemplu „La ${at} ai ${meeting.titlu}.”, apoi cel mult 6 rânduri și, la final, 3 puncte de discutat. Nu trimiți nimic.`,
      ].join("\n\n"),
    });
  }
}

// Ce știe Argus de pe telefon (faptele din memoria comună), pus la începutul fiecărei cereri.
let factsCache = { at: 0, text: "" };
async function knownFacts(config) {
  if (Date.now() - factsCache.at < 5 * 60_000) return factsCache.text;
  try {
    const { fapte = [] } = await api(config, "GET", undefined, "", "/api/memorie");
    factsCache = { at: Date.now(), text: fapte.length ? `Ce știe Argus despre Daniel:\n${fapte.slice(0, 60).map((fapt) => `- ${fapt}`).join("\n")}` : "" };
  } catch {
    factsCache.at = Date.now();
  }
  return factsCache.text;
}

// memorie.md de pe laptop ajunge și la Argus pe telefon (cel mult 4 KB), când se schimbă.
const MEMORY_FILE = "memorie.md";
let memorySent = 0;
async function shareMemory(config) {
  const file = join(config.folder, MEMORY_FILE);
  if (!existsSync(file)) return;
  const changed = statSync(file).mtimeMs;
  if (changed === memorySent) return;
  await api(config, "POST", { laptop: readFileSync(file, "utf8").slice(0, 4000) }, "", "/api/memorie");
  memorySent = changed;
}

let chores = false;
let choresAt = 0;
function runChores(config) {
  if (chores || Date.now() - choresAt < 60_000) return;
  chores = true;
  choresAt = Date.now();
  (async () => {
    trimLanes();
    await shareMemory(config).catch(() => {});
    if (config.urmariri !== false) await checkWatchers(config);
    if (config.pregatire !== false) await prepareMeetings(config);
  })()
    .catch((error) => log("Treburile automate n-au mers:", error.message))
    .finally(() => (chores = false));
}

async function main() {
  const config = loadConfig();
  mkdirSync(config.folder, { recursive: true });
  if (!config.cookie) await login(config);
  log(`Puntea Argus pornită. Verific cererile la ${POLL_MS / 1000} secunde. Folder: ${config.folder}`);
  let lastSignal = null;
  let busyUntil = 0;
  const running = new Map(); // id → trimitere (true) sau cerere obișnuită (false)
  const wait = () => new Promise((resolve) => setTimeout(resolve, Date.now() < busyUntil ? FAST_POLL_MS : POLL_MS));
  for (;;) {
    // Repornirea după actualizare așteaptă să se termine ce e în lucru.
    if (updated() && running.size === 0 && !chores) return restart();
    if (!updated()) runChores(config);
    try {
      // Întâi semnalul (o comandă); lista se citește doar când s-a schimbat ceva.
      const { semnal } = await api(config, "GET", undefined, "?semnal=1");
      if (semnal !== undefined && semnal === lastSignal) {
        await wait();
        continue;
      }
      lastSignal = semnal ?? null;
      busyUntil = Date.now() + FAST_FOR_MS;
      if (updated()) {
        await wait();
        continue;
      }
      const { cereri = [] } = await api(config, "GET");
      // Cele mai vechi primele; mai multe deodată, dar o singură trimitere odată.
      for (const item of [...cereri].reverse()) {
        if (running.size >= PARALLEL) break;
        if (running.has(item.id) || (item.status !== "nouă" && item.status !== "confirmată")) continue;
        const send = item.status === "confirmată";
        if (send && [...running.values()].includes(true)) continue;
        running.set(item.id, send);
        handle(config, item)
          .catch(async (error) => {
            log("Eroare:", item.titlu, error.message);
            await api(config, "PATCH", { id: item.id, status: "eroare", rezultat: "Puntea a dat eroare. Mai încearcă." }).catch(() => {});
          })
          .finally(() => {
            running.delete(item.id);
            lastSignal = null; // un loc liber: verificăm imediat dacă mai așteaptă ceva
          });
      }
    } catch (error) {
      if (error.relogin) {
        log("Sesiunea a expirat (s-a schimbat codul?). Repornește puntea și dă codul din nou.");
        delete config.cookie;
        saveConfig(config);
        process.exit(1);
      }
      log("Nu pot verifica cererile:", error.message);
      lastSignal = null; // la următoarea verificare citim din nou toată lista, ca nimic să nu rămână neluat
    }
    await wait();
  }
}

if (!process.argv.includes("--worker")) supervise();
else main().catch((error) => {
  log("Oprit:", error.message);
  process.exit(1);
});
