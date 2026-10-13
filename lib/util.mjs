// shared helpers: terminal colors, flag parsing, file readers.
import fs from "node:fs";
import os from "node:os";
import readline from "node:readline";

export const HOME = os.homedir();

export const dim = (s) => `\x1b[2m${s}\x1b[0m`;
export const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
export const green = (s) => `\x1b[32m${s}\x1b[0m`;
export const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
export const magenta = (s) => `\x1b[35m${s}\x1b[0m`;
export const blue = (s) => `\x1b[34m${s}\x1b[0m`;
// Anything that came out of a transcript is untrusted terminal input, not text.
// Agent sessions are full of pasted build logs, git output and screen captures,
// so escape sequences reach casm routinely - and one printed verbatim drives
// *your* terminal: ESC[8m conceals everything typed afterwards, ESC[?1049h
// switches to the alt screen, a lone CR overwrites the line. Strip the lot at
// the point the text enters casm and every column, snippet and preview below is
// plain text by construction.
//
// Order matters. The string-introducers go first, since their payload can
// contain anything including CSI-looking bytes; then CSI, terminated or not,
// because an unterminated one is exactly what a truncate leaves behind; then
// whatever single-character escape is left - ESC c alone resets the whole
// terminal, and its final byte is outside the usual two-character range. Tab
// and CR become spaces because callers collapse whitespace anyway.
export const plain = (s) =>
  String(s ?? "")
    .replace(/\x1b[\]P^_X][\s\S]*?(?:\x07|\x1b\\|$)/g, "")  // OSC/DCS/PM/APC/SOS, to BEL or ST
    .replace(/\x1b\[[0-9;?<>=!]*[\x20-\x2f]*[@-~]?/g, "")   // CSI, terminated or not
    .replace(/\x1b[\x20-\x7e]?/g, "")                       // any other escape, and a lone ESC
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")  // remaining C0/C1
    .replace(/[\t\r]/g, " ");

// Cutting a coloured string mid-sequence is how a terminal ends up waiting for
// a final byte that never comes, swallowing the newline and the front of your
// shell prompt with it. Callers should be handing these plain text, but they
// also pass casm's own colours through, so refuse to leave a chopped escape
// behind rather than trusting every call site to have got it right.
const cut = (s, n) => {
  const out = s.slice(0, n);
  const open = out.search(/\x1b(\[[0-9;?<>=!]*[\x20-\x2f]*)?$/);
  return (open === -1 ? out : out.slice(0, open)) + "…";
};
export const pad = (s, n) => (s.length > n ? cut(s, n - 1) : s.padEnd(n));
export const truncate = (s, n) => (s.length > n ? cut(s, n - 1) : s);
// Cut a finished row to the terminal width rather than letting it wrap. A
// wrapped row is worse than a truncated one: it doubles the line count and
// breaks the column alignment that makes a listing readable at a glance.
//
// Escape sequences are zero-width, so they are copied through without counting,
// and the result is closed with a reset - cutting mid-colour would otherwise
// leak it into whatever prints next.
export function fitLine(s, cols) {
  if (!cols || cols < 8) return s;
  let out = "", width = 0, i = 0;
  while (i < s.length) {
    const esc = /^\x1b\[[0-9;?<>=!]*[\x20-\x2f]*[@-~]/.exec(s.slice(i));
    if (esc) { out += esc[0]; i += esc[0].length; continue; }
    if (width >= cols - 1) return out + "…\x1b[0m";
    out += s[i]; width++; i++;
  }
  return out;
}

export const fmtAge = (s) =>
  s < 60 ? `${Math.round(s)}s`
  : s < 3600 ? `${Math.round(s / 60)}m`
  : s < 172800 ? `${(s / 3600).toFixed(1)}h`
  : `${(s / 86400).toFixed(1)}d`;
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const shq0 = (s) => `'${String(s).replace(/'/g, "''")}'`; // sql-quote

// Failure messages routinely carry text casm did not write - an id you typed,
// a path out of a transcript - so the whole message is stripped rather than
// trusting each caller.
export function die(msg) { console.error(`casm: ${plain(msg)}`); process.exit(1); }

// listings show ids truncated with a "…"; tolerate it being pasted straight back
export const normalizeIdPrefix = (p) => (p ? p.replace(/[….]+$/, "") : p);

// resolves null if the input ends without an answer (ctrl-D), so callers can
// treat that as an abort instead of hanging or exiting silently
export function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    let answered = false;
    rl.on("close", () => { if (!answered) res(null); });
    rl.question(question, (a) => { answered = true; rl.close(); res(a.trim()); });
  });
}
export function readLines(file, cb, maxBytesTail = null) {
  let text;
  if (maxBytesTail) {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytesTail);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString("utf8");
  } else {
    text = fs.readFileSync(file, "utf8");
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (cb(obj) === false) return;
  }
}
export function headEntries(file, maxLines = 60) {
  const out = [];
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(64 * 1024);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  for (const line of buf.toString("utf8", 0, n).split("\n").slice(0, maxLines)) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}
// The one door transcript text comes through for claude and pi - preview,
// search and show all land here - so this is where it stops being terminal
// input and starts being text.
export function extractText(content) {
  if (typeof content === "string") return plain(content);
  if (Array.isArray(content))
    return plain(content.map((b) => (typeof b === "string" ? b : b.text ?? "")).join(" "));
  return "";
}

export const strFlag = (args, name, dflt) => {
  const i = args.findIndex((a) => a === name || a.startsWith(name + "="));
  if (i < 0) return dflt;
  return args[i] === name ? args[i + 1] : args[i].slice(name.length + 1);
};
export const intFlag = (args, name, dflt) => {
  const raw = strFlag(args, name, null);
  if (raw === null) return dflt;
  if (!/^\d+$/.test(raw)) die(`option '${name}' needs a non-negative integer`);
  return Number(raw);
};
export const positionals = (args, valueFlags = []) => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("-")) { if (valueFlags.includes(args[i])) i++; continue; }
    out.push(args[i]);
  }
  return out;
};
// the cwd is read out of a transcript like everything else, so it is no more
// trustworthy than the preview beside it
export const shortProject = (cwdOrDir) => {
  const p = plain(cwdOrDir ?? "").split("/").filter(Boolean);
  return p.slice(-2).join("/") || plain(cwdOrDir ?? "") || "?";
};
// The window is cut at arbitrary offsets either side of the match, so on raw
// text it would happily emit an opener without its closer, or start halfway
// through a sequence. plain() here means the slices are always plain text and
// the only escapes in the result are the ones this line adds.
export const snippet = (text, idx, len) => {
  const t = plain(text);
  const start = Math.max(0, idx - 40);
  return t.slice(start, idx) + yellow(t.slice(idx, idx + len)) + t.slice(idx + len, idx + len + 40);
};

