// Puntea Argus → laptop: preia cererile trimise din aplicația Argus și le dă lui Claude Code de pe laptop.
// Varianta „liber, cu limite” (aleasă de Daniel pe 15.10.2026): Claude citește, caută, scrie fișiere și rulează
// comenzi singur în folderul de proiecte. Nu trimite nimic: un mail pleacă doar după ce Daniel apasă Da pe
// telefon, într-un pas separat în care abia atunci primește unealta de trimitere. Ștergerile sunt blocate.
// Pornire: node argus-bridge.mjs (prima dată cere codul aplicației).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(HERE, "config.json");
const POLL_MS = 15_000;
const RUN_TIMEOUT_MS = 15 * 60_000;

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
};

const RULES = `Lucrezi pe laptopul lui Daniel și primești cereri de la Argus, asistentul lui vocal.
Daniel nu e lângă laptop: rezultatul tău îi apare pe telefon, într-o fereastră mică.

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
  const { url, folder, claude, cookie } = config;
  writeFileSync(CONFIG_FILE, JSON.stringify({ url, folder, claude, cookie }, null, 2));
}

const log = (...parts) => console.log(new Date().toLocaleString("ro-RO"), ...parts);

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

async function api(config, method, body) {
  const response = await fetch(`${config.url}/api/cereri`, {
    method,
    headers: { Cookie: `jarvis_session=${config.cookie}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) throw Object.assign(new Error("neautentificat"), { relogin: true });
  if (!response.ok) throw new Error(data.error || `server ${response.status}`);
  return data;
}

function runClaude(config, prompt, { resume, send } = {}) {
  const tools = send ? [...WORK_TOOLS, ...AFTER_YES_TOOLS] : WORK_TOOLS;
  // Ce nu e în listă e refuzat, pentru că nu e nimeni lângă laptop să aprobe.
  const args = [
    "-p", "--output-format", "json", "--permission-mode", "acceptEdits",
    "--allowedTools", tools.join(","),
    "--disallowedTools", (send ? BLOCKED : [...BLOCKED, ...AFTER_YES_TOOLS]).join(","),
    "--append-system-prompt", RULES,
  ];
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
        resolve({ ok: false, text: (err || out || "Claude Code s-a oprit fără răspuns.").slice(-1500) });
      }
    });
    child.stdin.end(prompt);
  });
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
  await api(config, "PATCH", { id: cerere.id, status: "în lucru" });
  const prompt = send
    ? [
        `Daniel a apăsat Da pentru: ${cerere.confirmare?.titlu}.`,
        `Destinatar confirmat: ${cerere.confirmare?.destinatar ?? "(nespecificat)"}`,
        `Text confirmat:\n${cerere.confirmare?.text ?? ""}`,
        "Fă acum exact ce a confirmat. Dacă e un mail, trimite ciorna doar dacă destinatarul și textul ei sunt exact cele de mai sus; dacă diferă cu ceva, nu trimite și spune ce diferă. La final spune pe scurt ce ai făcut.",
      ].join("\n\n")
    : `Cerere de la Daniel, prin Argus (${new Date(cerere.creat).toLocaleString("ro-RO", { timeZone: "Europe/Bucharest" })}):\n\n${cerere.cerere}`;
  const run = await runClaude(config, prompt, { resume: send ? cerere.sesiune : undefined, send });
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

function restart() {
  log("Puntea a fost actualizată. Repornesc.");
  const child = spawn(process.execPath, [SELF], { stdio: "inherit", windowsHide: true });
  child.on("exit", (code) => process.exit(code ?? 0));
}

async function main() {
  const config = loadConfig();
  mkdirSync(config.folder, { recursive: true });
  if (!config.cookie) await login(config);
  log(`Puntea Argus pornită. Verific cererile la ${POLL_MS / 1000} secunde. Folder: ${config.folder}`);
  for (;;) {
    if (updated()) return restart();
    try {
      const { cereri = [] } = await api(config, "GET");
      // Cele mai vechi primele; una câte una.
      const next = [...cereri].reverse().find((item) => item.status === "nouă" || item.status === "confirmată");
      if (next) {
        await handle(config, next);
        continue;
      }
    } catch (error) {
      if (error.relogin) {
        log("Sesiunea a expirat (s-a schimbat codul?). Repornește puntea și dă codul din nou.");
        delete config.cookie;
        saveConfig(config);
        process.exit(1);
      }
      log("Nu pot verifica cererile:", error.message);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

main().catch((error) => {
  log("Oprit:", error.message);
  process.exit(1);
});
