// agent providers: claude code / codex / opencode / pi.
// Uniform session shape: { agent, id, cwd, mtime(Date), preview, file? }
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { HOME, cyan, magenta, yellow, blue, die, shq, readLines, headEntries, extractText, plain, normalizeIdPrefix } from "./util.mjs";

// What `resume` echoes before it hands over. Kept separate from resumeArgv so
// the argv stays a real array - re-splitting a command string on spaces is what
// used to break any argument containing one.
export const displayCmd = (argv, cwd) => `cd ${shq(cwd)} && ${argv.map((a) => (/^[\w./@:=+-]+$/.test(a) ? a : shq(a))).join(" ")}`;

// Where each agent keeps its sessions. The agents' own redirection variables
// (CLAUDE_CONFIG_DIR, XDG_DATA_HOME) are honoured.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
const XDG_DATA = process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share");
export const CC_PROJECTS = path.join(CLAUDE_DIR, "projects");
export const PI_SESSIONS = path.join(HOME, ".pi", "agent", "sessions");
export const CODEX_SESSIONS = path.join(HOME, ".codex", "sessions");
export const OC_DB = path.join(XDG_DATA, "opencode", "opencode.db");

// opencode keeps everything in one sqlite file, read with Node's built-in sqlite.
export function sq(sql, params = [], db = OC_DB) {
  const conn = new DatabaseSync(db, { readOnly: true });
  try {
    return conn.prepare(sql).all(...params);
  } finally {
    conn.close();
  }
}
// codex sends its own context to the model as `user` messages - the environment
// block, and any AGENTS.md it picked up. Nothing there was typed by you, so it
// is skipped for previews, turns and search, where it would otherwise be the
// first thing shown for every session and would match half of them.
const CODEX_INJECTED = /^\s*(<environment_context|<user_instructions|<INSTRUCTIONS|#\s*AGENTS\.md instructions)/;
// codex message content is a list of typed blocks; only the text ones matter.
const codexText = (content) =>
  plain(Array.isArray(content) ? content.map((b) => b?.text ?? "").join(" ") : (content ?? ""));

export const AGENTS = {
  claude: {
    tag: () => cyan("cc"),
    available: () => fs.existsSync(CC_PROJECTS),
    sessions() {
      const out = [];
      for (const dir of fs.readdirSync(CC_PROJECTS)) {
        const full = path.join(CC_PROJECTS, dir);
        let entries; try { entries = fs.readdirSync(full); } catch { continue; }
        for (const f of entries) {
          if (!f.endsWith(".jsonl")) continue;
          const file = path.join(full, f);
          out.push({ agent: "claude", id: f.slice(0, -6), file, mtime: fs.statSync(file).mtime, cwd: null, preview: null });
        }
      }
      return out;
    },
    enrich(s) {
      for (const o of headEntries(s.file)) {
        if (o.cwd && !s.cwd) s.cwd = o.cwd;
        if (o.type === "user" && o.message && s.preview === null)
          s.preview = extractText(o.message.content).replace(/\s+/g, " ").trim();
        if (s.cwd && s.preview !== null) break;
      }
      s.preview ??= "";
      return s;
    },
    searchEntry: (o) => (o.type === "user" || o.type === "assistant") ? extractText(o.message?.content ?? "") : null,
    turns(s) {
      const turns = [];
      readLines(s.file, (o) => {
        if ((o.type !== "user" && o.type !== "assistant") || o.isSidechain) return;
        const text = extractText(o.message?.content ?? "").replace(/\s+/g, " ").trim();
        if (text) turns.push({ role: o.type, text, ts: o.timestamp });
      });
      return turns;
    },
    resumeArgv: (s) => ["claude", "--resume", s.id],
    // context = the input side of the newest assistant turn: what filled the
    // window last time the model ran. tail-read so long transcripts stay cheap.
    contextUsage(s) {
      let found = null;
      readLines(s.file, (o) => {
        if (o.type === "assistant" && o.message?.usage) found = o.message;
      }, 256 * 1024);
      if (!found) return null;
      const u = found.usage;
      return { model: found.model, ctx: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) };
    },
  },

  // codex stores one rollout file per session under sessions/YYYY/MM/DD/, named
  // rollout-<timestamp>-<uuid>.jsonl. The uuid is the session id `codex resume`
  // takes, and it is the last 36 characters of the name - parsed that way rather
  // than by splitting on "-", which the timestamp is full of.
  codex: {
    tag: () => blue("cx"),
    available: () => fs.existsSync(CODEX_SESSIONS),
    sessions() {
      const out = [];
      const walk = (dir, depth) => {
        let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory() && depth < 3) walk(full, depth + 1);
          else if (e.isFile() && e.name.endsWith(".jsonl") && e.name.startsWith("rollout-"))
            out.push({ agent: "codex", id: e.name.replace(/\.jsonl$/, "").slice(-36), file: full,
                       mtime: fs.statSync(full).mtime, cwd: null, preview: null });
        }
      };
      walk(CODEX_SESSIONS, 0);
      return out;
    },
    enrich(s) {
      for (const o of headEntries(s.file)) {
        if (o.type === "session_meta" && o.payload?.cwd && !s.cwd) s.cwd = o.payload.cwd;
        // the opening `developer` messages are codex's own instructions, not
        // anything you typed, so the preview comes from the first user turn
        if (s.preview === null && o.type === "response_item" && o.payload?.role === "user") {
          const t = codexText(o.payload.content);
          if (!CODEX_INJECTED.test(t)) s.preview = t.replace(/\s+/g, " ").trim();
        }
        if (s.cwd && s.preview !== null) break;
      }
      s.preview ??= "";
      return s;
    },
    searchEntry(o) {
      if (o.type !== "response_item" || o.payload?.type !== "message" || o.payload.role === "developer") return null;
      const t = codexText(o.payload.content);
      return CODEX_INJECTED.test(t) ? null : t;
    },
    turns(s) {
      const turns = [];
      readLines(s.file, (o) => {
        if (o.type !== "response_item" || o.payload?.type !== "message") return;
        const role = o.payload.role;
        if (role !== "user" && role !== "assistant") return;
        const raw = codexText(o.payload.content);
        if (CODEX_INJECTED.test(raw)) return;
        const text = raw.replace(/\s+/g, " ").trim();
        if (text) turns.push({ role, text, ts: o.timestamp });
      });
      return turns;
    },
    resumeArgv: (s) => ["codex", "resume", s.id],
    contextUsage(s) {
      let found = null;
      readLines(s.file, (o) => {
        if (o.payload?.type === "token_count" && o.payload.info) found = o.payload.info;
      }, 256 * 1024);
      const u = found?.last_token_usage;
      if (!u) return null;
      return { model: "", ctx: (u.input_tokens ?? 0) + (u.cached_input_tokens ?? 0) + (u.cache_write_input_tokens ?? 0) };
    },
  },

  pi: {
    tag: () => yellow("pi"),
    available: () => fs.existsSync(PI_SESSIONS),
    sessions() {
      const out = [];
      for (const dir of fs.readdirSync(PI_SESSIONS)) {
        const full = path.join(PI_SESSIONS, dir);
        let entries; try { entries = fs.readdirSync(full); } catch { continue; }
        for (const f of entries) {
          if (!f.endsWith(".jsonl")) continue;
          const file = path.join(full, f);
          const id = f.replace(/\.jsonl$/, "").split("_").pop();
          out.push({ agent: "pi", id, file, mtime: fs.statSync(file).mtime, cwd: null, preview: null });
        }
      }
      return out;
    },
    enrich(s) {
      for (const o of headEntries(s.file, 30)) {
        if (o.type === "session" && o.cwd) s.cwd = o.cwd;
        if (o.type === "message" && o.message?.role === "user" && s.preview === null)
          s.preview = extractText(o.message.content).replace(/\s+/g, " ").trim();
        if (s.cwd && s.preview !== null) break;
      }
      s.preview ??= "";
      return s;
    },
    searchEntry: (o) => o.type === "message" ? extractText(o.message?.content ?? "") : null,
    turns(s) {
      const turns = [];
      readLines(s.file, (o) => {
        if (o.type !== "message") return;
        const role = o.message?.role;
        if (role !== "user" && role !== "assistant") return;
        const text = extractText(o.message?.content ?? "").replace(/\s+/g, " ").trim();
        if (text) turns.push({ role, text, ts: o.timestamp });
      });
      return turns;
    },
    resumeArgv: (s) => ["pi", "--session", s.id],
    contextUsage(s) {
      let found = null;
      readLines(s.file, (o) => {
        if (o.type === "message" && o.message?.role === "assistant" && o.message.usage) found = o.message;
      }, 256 * 1024);
      if (!found) return null;
      const u = found.usage;
      return { model: found.model, ctx: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) };
    },
  },

  opencode: {
    tag: () => magenta("oc"),
    available: () => {
      return fs.existsSync(OC_DB);
    },
    sessions() {
      return sq("select id, directory, title, time_updated from session order by time_updated desc limit 500")
        // opencode's text comes from its sqlite store rather than through
        // extractText, so it is stripped here instead - a title is whatever the
        // model summarised the first prompt into, escapes included
        .map((r) => ({ agent: "opencode", id: r.id, file: null, cwd: r.directory, preview: plain(r.title ?? ""), mtime: new Date(r.time_updated) }));
    },
    enrich: (s) => s,
    turns(s) {
      const rows = sq(`select m.data as m, p.data as p from part p join message m on p.message_id = m.id where p.session_id = ? order by p.time_created`, [s.id]);
      const turns = [];
      for (const r of rows) {
        let mo, po;
        try { mo = JSON.parse(r.m); po = JSON.parse(r.p); } catch { continue; }
        if (po.type !== "text" || !po.text) continue;
        const role = mo.role;
        if (role !== "user" && role !== "assistant") continue;
        const text = plain(po.text).replace(/\s+/g, " ").trim();
        if (!text) continue;
        const last = turns[turns.length - 1];
        if (last && last.role === role && last._mid === r.m) last.text += " " + text;
        else turns.push({ role, text, ts: new Date(mo.time?.created ?? 0).toISOString(), _mid: r.m });
      }
      return turns;
    },
    search(needle, limit) {
      const esc = needle.replace(/[\\%_]/g, (c) => "\\" + c);
      const rows = sq(`select p.session_id as sid, s.directory as dir, s.time_updated as tu, p.data as data from part p join session s on s.id = p.session_id where p.data like ? escape '\\' order by s.time_updated desc limit ?`, [`%${esc}%`, limit * 4]);
      const seen = new Set(); const out = [];
      for (const r of rows) {
        if (seen.has(r.sid) || out.length >= limit) continue;
        // flattened here, not at the call site: the offset has to index the
        // same string the snippet is cut from
        let text; try { text = plain(JSON.parse(r.data).text ?? "").replace(/\s+/g, " "); } catch { continue; }
        const idx = text.toLowerCase().indexOf(needle.toLowerCase());
        if (idx === -1) continue;
        seen.add(r.sid);
        out.push({ id: r.sid, cwd: r.dir, mtime: new Date(r.tu), text, idx });
      }
      return out;
    },
    // Naming the directory is not optional: opencode otherwise ignores the
    // spawn cwd and walks up to the nearest project root. It takes
    // that as a positional - `opencode [project]` - and not as --dir, which
    // opencode 1.18 does not accept at all: it exits 1 and prints its command
    // list, which looks like cass launched nothing.
    resumeArgv: (s, cwd) => ["opencode", cwd, "-s", s.id],
    contextUsage(s) {
      const rows = sq(`select data from message where session_id = ? order by time_created desc, id desc limit 20`, [s.id]);
      for (const r of rows) {
        let m; try { m = JSON.parse(r.data); } catch { continue; }
        if (m.role !== "assistant" || !m.tokens) continue;
        return { model: m.modelID ?? "", ctx: (m.tokens.input ?? 0) + (m.tokens.cache?.read ?? 0) + (m.tokens.cache?.write ?? 0) };
      }
      return null;
    },
  },
};

export function activeAgents(agentFilter) {
  const names = agentFilter ? [agentFilter] : Object.keys(AGENTS);
  if (agentFilter && !AGENTS[agentFilter]) die(`unknown agent '${agentFilter}' (claude|codex|opencode|pi)`);
  return names.filter((n) => AGENTS[n].available());
}

export function allSessions(agentFilter) {
  const out = [];
  for (const name of activeAgents(agentFilter)) out.push(...AGENTS[name].sessions());
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export function findSession(rawPrefix) {
  const idPrefix = normalizeIdPrefix(rawPrefix);
  const matches = allSessions(null).filter((s) => s.id.startsWith(idPrefix));
  if (matches.length === 0) die(`no session matching '${idPrefix}'`);
  if (matches.length > 1) die(`ambiguous id '${idPrefix}' (${matches.length} matches) - use more characters`);
  return AGENTS[matches[0].agent].enrich(matches[0]);
}
