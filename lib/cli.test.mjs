import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { interactive } from "./commands.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "cass.mjs");

// runs cass against a throwaway HOME; `seed(home)` can plant sessions first
function run(args, seed = null) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cass-test-"));
  try {
    seed?.(home);
    const env = { ...process.env, HOME: home };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.XDG_DATA_HOME;
    const r = spawnSync(process.execPath, [bin, ...args], { cwd: root, env, encoding: "utf8" });
    // colours stripped so the assertions read as what you see
    return { ...r, stdout: r.stdout.replace(/\x1b\[[0-9;]*m/g, "") };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("value options support equals syntax", () => {
  const r = run(["list", "--agent=definitely-invalid"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown agent 'definitely-invalid'/);
});

test("value options reject a missing value", () => {
  const r = run(["list", "--agent", "-n", "3"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /option '--agent'.*needs a value/);
});

test("integer options reject malformed values", () => {
  const r = run(["list", "-n", "nope"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /option '-n' needs a non-negative integer/);
});

test("unknown options are refused", () => {
  const r = run(["list", "--host", "rig"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown option '--host'/);
});

test("interactive propagates spawn failures", () => {
  assert.throws(
    () => interactive(["cass-command-that-does-not-exist"], root),
    /ENOENT/,
  );
});

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const CC_ID = "11111111-2222-3333-4444-555555555555";
const PI_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CX_ID = "019e0000-1111-7222-8333-944444444444";

// one session per file-based agent, each in its own project directory
function seedSessions(home) {
  const proj = (name) => { const d = path.join(home, "src", name); fs.mkdirSync(d, { recursive: true }); return d; };
  const cc = proj("alpha"), pi = proj("beta"), cx = proj("gamma");

  const ccDir = path.join(home, ".claude", "projects", cc.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(ccDir, { recursive: true });
  fs.writeFileSync(path.join(ccDir, `${CC_ID}.jsonl`), jsonl([
    { type: "user", cwd: cc, timestamp: "2026-01-01T10:00:00Z", message: { role: "user", content: "fix the flaky widget test" } },
    { type: "assistant", cwd: cc, timestamp: "2026-01-01T10:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "the widget test races on a timer" }], usage: { input_tokens: 1500 } } },
  ]));

  const piDir = path.join(home, ".pi", "agent", "sessions", "--src-beta--");
  fs.mkdirSync(piDir, { recursive: true });
  fs.writeFileSync(path.join(piDir, `2026-01-01T10-00-00_${PI_ID}.jsonl`), jsonl([
    { type: "session", cwd: pi },
    { type: "message", timestamp: "2026-01-01T10:00:00Z", message: { role: "user", content: [{ type: "text", text: "rename the parser module" }] } },
  ]));

  const cxDir = path.join(home, ".codex", "sessions", "2026", "01", "01");
  fs.mkdirSync(cxDir, { recursive: true });
  fs.writeFileSync(path.join(cxDir, `rollout-2026-01-01T10-00-00-${CX_ID}.jsonl`), jsonl([
    { type: "session_meta", payload: { cwd: cx } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>ignored</environment_context>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "add rate limiting to the api" }] } },
  ]));
}

test("list shows every agent's sessions", () => {
  const r = run(["list"], seedSessions);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cc .*src\/alpha.*flaky widget/);
  assert.match(r.stdout, /pi .*src\/beta.*parser module/);
  assert.match(r.stdout, /cx .*src\/gamma.*rate limiting/);
});

test("search finds a term inside the transcript", () => {
  const r = run(["search", "races on"], seedSessions);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /11111111-2/);
  assert.doesNotMatch(r.stdout, /aaaaaaaa/);
});

test("search skips codex's injected context", () => {
  const r = run(["search", "environment_context"], seedSessions);
  assert.match(r.stdout, /no matches/);
});

test("show prints the turns of a session by id prefix", () => {
  const r = run(["show", "1111"], seedSessions);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /user .*fix the flaky widget test/);
  assert.match(r.stdout, /assistant .*races on a timer/);
});

test("resume --print names the agent, the id and the session's directory", () => {
  for (const [prefix, cmd] of [["1111", `claude --resume ${CC_ID}`], ["aaaa", `pi --session ${PI_ID}`], ["019e", `codex resume ${CX_ID}`]]) {
    const r = run(["resume", prefix, "--print"], seedSessions);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^cd '/.*/src/(alpha|beta|gamma)' && ${cmd}\n$`));
  }
});

test("an ambiguous or unknown id is refused", () => {
  assert.match(run(["show", "nope"], seedSessions).stderr, /no session matching 'nope'/);
  assert.match(run(["resume", ""], seedSessions).stderr, /usage: cass resume/);
});
