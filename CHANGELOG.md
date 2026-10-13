# Changelog

## 0.1.0 - 2026-10-13

Spun off from casm 0.9.2 as **cass**, "cross agent session search". The
history of the code before this point is casm's, kept in git.

### Kept

- `continue`, `list`, `search`, `show` and `resume`, for Claude Code, Codex,
  OpenCode and pi, behaving as in casm 0.9.2 on the local machine.

### Changed

- The command is `cass`, the package `cass-cli`.
- Bare `cass` opens the continue picker. Help is `cass help`.
- `resume` and `continue` take a hidden `--print`, which prints the command
  line and directory instead of starting the agent.

### Removed

- SSH hosts: `--host`, `push`, `pull`, `host`, and the remote parts of
  search, list, show, resume and continue.
- Containers: `new --containerized`, `containerize`, `auth` and the Docker
  image.
- `new`, `active` and bookmarks.
- The config file (`~/.config/casm/config.json`). Nothing is left to
  configure.
