import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { interactive } from "./commands.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "casm.mjs");

function run(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "casm-test-"));
  try {
    return spawnSync(process.execPath, [bin, ...args], {
      cwd: root,
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
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
    () => interactive(["casm-command-that-does-not-exist"], root),
    /ENOENT/,
  );
});
