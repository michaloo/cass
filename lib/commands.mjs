// command implementations
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  dim, cyan, green, pad, truncate, fmtAge, die,
  ask, readLines, intFlag, strFlag, positionals,
  shortProject, snippet, fitLine,
} from "./util.mjs";
import { AGENTS, activeAgents, allSessions, findSession, displayCmd } from "./agents.mjs";

// every listing row goes through here, so a narrow terminal truncates instead
// of wrapping and the columns stay lined up
const row = (line) => console.log(fitLine(line, process.stdout.columns));

// Column widths for a listing, given the terminal. The date, agent, id and
// context columns are fixed; what is left is split between the project and the
// opening message. Without this a narrow terminal spends everything on a padded
// project column and leaves one letter of preview, which is worse than useless -
// the preview is how you recognise the session you want.
function cols(fixed) {
  const total = process.stdout.columns || 120;
  const rest = Math.max(24, total - fixed);
  const project = Math.max(12, Math.min(26, Math.round(rest * 0.42)));
  return { project, preview: Math.max(12, rest - project - 2) };
}

export async function cmdList(args) {
  const n = intFlag(args, "-n", 20);
  const agent = strFlag(args, "--agent", null);
  const project = strFlag(args, "--project", null);
  let sessions = allSessions(agent);
  if (project) {
    const abs = path.resolve(project);
    sessions = sessions.filter((s) => {
      const c = AGENTS[s.agent].enrich(s).cwd ?? "";
      return c === abs || c.startsWith(abs + "/");
    });
  }
  const w = cols(16 + 2 + 2 + 2 + 11 + 2 + 2 + 5 + 2);
  for (const s of sessions.slice(0, n)) {
    AGENTS[s.agent].enrich(s);
    const when = s.mtime.toISOString().slice(0, 16).replace("T", " ");
    row(
      `${dim(when)}  ${AGENTS[s.agent].tag()}  ${cyan(pad(s.id, 11))}  ${green(pad(shortProject(s.cwd), w.project))}  ${ctxCol(ctxOf(s.agent, s))}  ${truncate(s.preview || dim("(untitled)"), w.preview)}`
    );
  }
  if (!sessions.length) console.log("no sessions found");
}

export async function cmdSearch(args) {
  const agentFlagVal = strFlag(args, "--agent", null);
  const [term] = positionals(args, ["-n", "--agent"]);
  if (!term) die("usage: casm search <term> [--agent claude|codex|opencode|pi] [-n N]");
  const n = intFlag(args, "-n", 25);
  const needle = term.toLowerCase();
  let hits = 0;

  for (const name of activeAgents(agentFlagVal)) {
    if (hits >= n) break;
    const A = AGENTS[name];
    if (A.search) {
      for (const h of A.search(term, n - hits)) {
        hits++;
        row(`${dim(h.mtime.toISOString().slice(0, 10))}  ${A.tag()}  ${cyan(pad(h.id, 11))}  ${green(pad(shortProject(h.cwd), 24))}  …${snippet(h.text, h.idx, term.length)}…`);
      }
      continue;
    }
    for (const s of A.sessions().sort((a, b) => b.mtime - a.mtime)) {
      if (hits >= n) break;
      let found = null;
      readLines(s.file, (o) => {
        const raw = A.searchEntry(o);
        if (!raw) return;
        // matched on the same string the snippet is cut from: the offset used
        // to come from the unflattened text, so collapsing whitespace shifted
        // the highlight off the term by however many runs preceded it
        const text = raw.replace(/\s+/g, " ");
        const idx = text.toLowerCase().indexOf(needle);
        if (idx === -1) return;
        found = snippet(text, idx, term.length);
        return false;
      });
      if (found) {
        hits++;
        A.enrich(s);
        row(`${dim(s.mtime.toISOString().slice(0, 10))}  ${A.tag()}  ${cyan(pad(s.id, 11))}  ${green(pad(shortProject(s.cwd), 24))}  …${found}…`);
      }
    }
  }
  if (!hits) console.log("no matches");
}

export async function cmdShow(args) {
  const [idPrefix] = positionals(args, ["-n"]);
  if (!idPrefix) die("usage: casm show <session-id-prefix> [-n turns]");
  const n = intFlag(args, "-n", 30);
  const s = findSession(idPrefix);
  const turns = AGENTS[s.agent].turns(s);
  for (const t of turns.slice(-n)) {
    const tag = t.role === "user" ? cyan("user     ") : green("assistant");
    console.log(`${tag} ${dim(t.ts?.slice(11, 16) ?? "")} ${truncate(t.text, 400)}\n`);
  }
  console.log(dim(`[${s.agent}] session ${s.id} - ${turns.length} text turns, last activity ${fmtAge((Date.now() - s.mtime) / 1000)} ago`));
}

export async function cmdResume(args) {
  const [idPrefix] = positionals(args);
  if (!idPrefix) die("usage: casm resume <session-id-prefix>");
  launch(findSession(idPrefix));
}

// hand the terminal to the agent, in the session's own directory. resuming by
// id (not `--continue`) so you land in the session you picked, not whatever
// happens to be newest in that directory.
function launch(s) {
  const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : process.cwd();
  if (!s.cwd || !fs.existsSync(s.cwd))
    console.error(dim(`warning: original cwd ${s.cwd ?? "?"} missing, resuming from ${cwd}`));
  const argv = AGENTS[s.agent].resumeArgv(s, cwd);
  handOver(argv, cwd);
}

// Every launch path ends here.
function handOver(argv, cwd) {
  // cut rather than wrap: this line carries a full path, and wrapped across
  // several rows it buries the command it is announcing
  console.error(fitLine(dim(`$ ${displayCmd(argv, cwd)}`), process.stderr.columns));
  process.exit(interactive(argv, cwd));
}

// An agent TUI that dies without unwinding - killed, say - leaves its last
// attributes set and its cursor hidden on *your* terminal, and the shell prompt
// inherits them. casm handed the terminal over, so casm hands it back.
//
// Deliberately only the two that are always safe to re-assert. Leaving the
// alternate screen is not: a TUI that exited cleanly has already done it, and
// doing it again would restore a saved cursor position over the output you
// wanted to keep.
function restoreTerminal() {
  if (process.stdout.isTTY) process.stdout.write("\x1b[0m\x1b[?25h");
}

export function interactive(argv, cwd) {
  try {
    const r = spawnSync(argv[0], argv.slice(1), { cwd, stdio: "inherit" });
    if (r.error) throw r.error;
    return r.status ?? 1;
  } finally {
    restoreTerminal();
  }
}

// The picker covers this machine, newest first across every agent, and resumes
// the pick with its own agent in its own directory.
export async function cmdContinue(args) {
  const n = intFlag(args, "-n", 10);
  const agentFilter = strFlag(args, "--agent", null);

  const sessions = allSessions(agentFilter).slice(0, n);
  if (!sessions.length) { console.log("no sessions found"); return; }

  sessions.forEach((s, i) => {
    AGENTS[s.agent].enrich(s);
    row(
      `${cyan(pad(`${i + 1})`, 4))} ${dim(pad(fmtAge((Date.now() - s.mtime) / 1000) + " ago", 9))} ${AGENTS[s.agent].tag()}  ${green(pad(shortProject(s.cwd), 26))}  ${ctxCol(ctxOf(s.agent, s))}  ${truncate(s.preview || dim("(untitled)"), 48)}`
    );
  });

  if (!process.stdin.isTTY) die("not a terminal - use: casm resume <id-prefix>");
  const answer = await ask(`\ncontinue [1-${sessions.length}, enter=1, q to abort]: `);
  if (answer === null || answer === "q") { console.log("aborted"); return; }
  const idx = answer === "" ? 1 : parseInt(answer, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > sessions.length) die(`invalid choice '${answer}'`);
  launch(sessions[idx - 1]);
}

// ---------- context column ----------

const fmtTokens = (t) => (t >= 1000 ? `${Math.round(t / 1000)}k` : String(t));

// context of a session: the input side of its newest assistant turn - prompt,
// history and tool results that filled the model's window last time it ran.
// shown as a column in every listing; blank when a session has no turns yet.
function ctxOf(agentName, sLike) {
  try { return AGENTS[agentName].contextUsage?.(sLike)?.ctx ?? null; } catch { return null; }
}
const ctxCol = (ctx) => (ctx != null ? cyan(pad(fmtTokens(ctx), 5)) : dim(pad("", 5)));
