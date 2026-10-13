#!/usr/bin/env node
// casm - multi-node coding-agent session manager for Claude Code, opencode, and pi.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dim, cyan, green, magenta, yellow, blue, die } from "../lib/util.mjs";
import { cmdList, cmdSearch, cmdShow, cmdResume, cmdContinue } from "../lib/commands.mjs";

// Every option each command accepts. Anything else that looks like a flag is a
// mistake and is refused, rather than silently ignored.
const FLAGS = {
  list:     ["-n", "--agent", "--project"],
  search:   ["-n", "--agent"],
  show:     ["-n"],
  resume:   [],
  continue: ["-n", "--agent"],
};

const VALUE_FLAGS = new Set(["-n", "--agent", "--project"]);

function checkFlags(cmd, args) {
  const known = FLAGS[cmd];
  if (!known) return;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--" || !a.startsWith("-") || a === "-") continue;
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    if (known.includes(name)) {
      if (eq !== -1 && !VALUE_FLAGS.has(name))
        die(`option '${name}' for 'casm ${cmd}' does not take a value`);
      if (VALUE_FLAGS.has(name)) {
        const value = eq === -1 ? args[i + 1] : a.slice(eq + 1);
        if (!value || (eq === -1 && value.startsWith("-")))
          die(`option '${name}' for 'casm ${cmd}' needs a value`);
        if (eq === -1) i++;
      }
      continue;
    }
    const near = known.find((k) => k.replace(/[^a-z]/g, "").startsWith(name.replace(/[^a-z]/g, "").slice(0, 6)));
    die(`unknown option '${name}' for 'casm ${cmd}'` +
        (near ? ` - did you mean ${near}?` : ` - try: casm help`));
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = { list: cmdList, search: cmdSearch, show: cmdShow, resume: cmdResume, continue: cmdContinue };

// fileURLToPath, not new URL().pathname: a checkout under a path with a space
// comes back percent-encoded from the latter and the read fails.
const version = () =>
  JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;

// The two things people install casm for. Kept to a headline, one sentence and
// something you can paste - the usage above is the reference, this is the part
// that answers "what is this for".
const USE_CASES = [
  ["continue from anywhere",
   "your most recent sessions across every agent, newest first. pick one and\ncasm changes into its directory and resumes it with its own agent.",
   "casm continue"],
  ["search and resume",
   "full-text over every transcript, with the match shown in context.\nthen resume the hit by id.",
   `casm search "rate limiting"`],
];

function help() {
  console.log(`casm ${dim(version())} - coding-agent session manager
${dim("  agents:")} claude code ${cyan("cc")} · codex ${blue("cx")} · opencode ${magenta("oc")} · pi ${yellow("pi")}

usage:
  casm continue [-n 10] [--agent X]              pick a recent session and resume it
  casm list   [-n 20] [--agent X] [--project P]  newest sessions across agents
  casm search <term> [-n 25] [--agent X]         full-text search of transcripts
  casm show   <id-prefix> [-n 30]                preview a conversation
  casm resume <id-prefix>                        resume with its own agent, in its cwd
  casm help | casm version                       this screen; the installed version`);

  for (const [title, desc, example] of USE_CASES) {
    console.log(`\n${green(title)}`);
    for (const line of desc.split("\n")) console.log(dim("  " + line));
    console.log(`  ${cyan("$ " + example)}`);
  }
}

if (cmd === "help" || cmd === "--help" || cmd === "-h") { help(); process.exit(0); }
if (cmd === "version" || cmd === "--version" || cmd === "-v") { console.log(version()); process.exit(0); }

if (!cmd) {
  help();
  process.exit(0);
} else if (!commands[cmd]) {
  die(`unknown command '${cmd}' - try: casm help`);
} else {
  checkFlags(cmd, rest);
  Promise.resolve(commands[cmd](rest)).catch((e) => die(e.message));
}
