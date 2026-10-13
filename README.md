# cass

**Cross agent session search for Claude Code, Codex, OpenCode and pi.**

List, search and resume sessions for **Claude Code** (`cc`), **codex** (`cx`),
**opencode** (`oc`) and **pi** (`pi`) from one place. Each session is resumed
with its own agent, in its own directory.

No npm dependencies. Node 18+. macOS and Linux. Spun off from
[casm](https://github.com/michaloo/casm), without the SSH hosts, containers and
bookmarks.

## Install

```sh
npm i -g cass-cli        # installs the `cass` command
```

## Continue from anywhere

`cass` (or `cass continue`) lists your 10 most recent sessions across every
agent, newest first, with age, agent, project, context size and opening message.
Pick a number and cass starts that session's agent in the session's own
directory, resuming **by id** so you land in the session you picked rather than
whatever was newest in that folder.

```sh
cass                            # the 10 most recent, pick one
cass continue -n 20             # more of them
cass continue --agent opencode  # one agent only
```

Enter takes the first, `q` aborts. If the original directory is gone it says so
and starts where you are.

A CLI cannot change its parent shell's directory, so the agent runs in the
session's directory and your shell stays where it was once the agent exits.

## Search and resume

Full-text search across every transcript of every agent, with the matching line
shown in context. Then resume the hit.

```sh
cass search "rate limiting"       # every agent
cass search "flaky test" --agent claude
cass show 019e4ee3 -n 20          # read it first
cass resume 019e4ee3              # ...then pick it up
```

Ids can be abbreviated anywhere to a unique prefix.

## All commands

```sh
cass [continue] [-n 10] [--agent X]            # pick a recent session and resume it
cass list   [-n 20] [--agent X] [--project P]  # newest sessions across agents
cass search <term> [-n 25] [--agent X]         # full-text search of transcripts
cass show   <id-prefix> [-n 30]                # preview a conversation
cass resume <id-prefix>                        # resume with its own agent, in its cwd
cass help | cass version
```

`--agent` takes `claude`, `codex`, `opencode` or `pi`. `--project` keeps
sessions whose directory is that path or below it.

## Where sessions are read from

| Agent | Session storage | Resumed with |
|---|---|---|
| claude | `~/.claude/projects/<path-slug>/<uuid>.jsonl` (honours `CLAUDE_CONFIG_DIR`) | `claude --resume <id>` |
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` | `codex resume <id>` |
| pi | `~/.pi/agent/sessions/<path-slug>/<ts>_<uuid>.jsonl` | `pi --session <id>` |
| opencode | sqlite (`~/.local/share/opencode/opencode.db`, honours `XDG_DATA_HOME`) | `opencode <dir> -s <id>` |

cass only reads these. It never writes to them.

## Requirements

- Node 18+.
- The `sqlite3` CLI for opencode. Without it, opencode sessions are left out of
  every listing.

Transcript formats are internal to each agent and change between versions.
Parsing is defensive (bad lines are skipped), but it can degrade.

## Alternatives

`claude --cloud` / `claude teleport` (official, relays via claude.ai);
[agent-sessions](https://github.com/vineethkrishnan/agent-sessions) and
similar local TUI browsers.
