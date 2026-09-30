# DSH history-migration scripts

Reusable, parameterised tooling for migrating chat history (VS Code Copilot Chat,
MiMo Studio) into DeepSeek Harness (DSH) sessions, plus inspection and validation
helpers for DSH session logs.

Every path is passed on the command line; no personal path, user name, session id or
session content is embedded in any script.

## Requirements

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24.x (tested on 24.19.0) | needs built-in `node:zlib` Zstandard (`zstdCompressSync`/`zstdDecompressSync`) and, for `export-mimo.mjs`, `node:sqlite` |
| Python | 3.14 (optional) | not required by these scripts; only needed if you prefer the original Python extractors |
| DSH | the desktop install that ships the `dsh` launcher | only for the optional live validation step |

Optional environment variables:

* `DSH_CLI` — path to the DSH launcher, used by `selftest.mjs` when `--dsh` is not given.
* `DSH_HOME` — the DSH home directory to inspect/write. Pass it as `--home` to the scripts; they set it on the child process for the live check.

Placeholders used below: `<DSH_HOME>` (usually `~/.dsh`), `<workspace>` (the
workspace folder a session belongs to), `<session-id>` (for example
`session-<uuid>`), `<DSH_INSTALL>` (the desktop install directory).

## DSH session log format (hard requirements)

A DSH session lives at
`<DSH_HOME>/sessions/<encoded-workspace>/<session-id>/session.v4.jsonl.zstd` and is a
concatenation of independent Zstandard frames:

1. the **first frame holds exactly one line**: the JSON session header
   (`type: 'session'`, `version: 4`, `id`, `createdAt`, `cwd`, `agentPreset`, …);
2. **every following frame holds exactly one event line**;
3. the header has no `seq`; every event has one, running `0,1,2,…` **without gaps**;
4. `assistant/message` events need the full model stream, so imports keep only
   `user/message` events — that is the simplest shape the loader accepts;
5. the sidebar list also needs a projection cache entry at
   `<DSH_HOME>/storages/session_projcache/sessions/<session-id>.json` (version 7,
   `record.identity` + `record.rows`);
6. the workspace folder name under `sessions/` is the `cwd` with `:` removed, `\`/`/` turned into
   `-`, non-ASCII code units turned into `~XXXX~`, wrapped in `--…--`.

The live validator is the one-shot loader:

    "<DSH_INSTALL>/resources/runtime/cli/bin/dsh.cmd" headless --session-id <session-id> "x"

It fails fast on a corrupt log. A log that is well formed but whose agent preset the
one-shot runner does not compose answers with
`runs under agent preset "standard", which the one-shot runner does not compose` —
that is a **format-accepted** outcome.

## Scripts

All scripts print a short summary and exit non-zero on failure. Run any of them with
`--help` for the exact synopsis.

### export-vscode-chat.mjs

    node export-vscode-chat.mjs --src <workspaceStorage>/<hash>/chatSessions --out <outDir> [--max-user 3000] [--max-assistant 1500]

Reads the `kind: 0` record of every `*.jsonl` chat session and extracts per-request
user text and assistant markdown. Writes `vscode-sessions.json` (machine-readable) and
`vscode-index.txt` (one line per session) into `--out`.

### export-mimo.mjs

    node export-mimo.mjs --store <git-version-store> --db-dir <dir with rolechat.db + artifacts.db> --out <outDir> [--skip-git] [--skip-db]

Writes `版本库提交记录.md` (git log), `开发事务.md` (`role_chat_record`) and
`产物清单.md` (`artifact`). Uses Node's built-in `node:sqlite` in read-only mode; both
databases are optional via `--skip-*`.

### build-dsh-session.mjs

    node build-dsh-session.mjs --out <session.v4.jsonl.zstd> --cwd <workspace> (--text <msg> | --input <file>) [--title <title>] [--id <session-id>] [--agent-preset standard] [--time <ISO|epoch-ms>] [--max-assistant-chars 4000] [--home <DSH_HOME>] [--dry]

Builds a minimal, validator-friendly session: header, seed events, then per turn
`turn/start → step/start → user/message → [assistant/message] → step/end → turn/end`,
then `session/title`.

`--input` accepts `.txt`/`.md`/`.jsonl` (one message per non-empty line) or `.json`:

- array of strings / `{text|user|content}` / `{"messages":[…]}` — 只有用户消息；
- **array of `{user, assistant}`** — 同时导入 AI 回复。`assistant` 会作为 `assistant/message` 写入，
  并自动补上合规的 `stream`（`block-start → text-delta → block-end → finish`，已实测过 DSH 校验器，见 SKILL.md R10）。
  超长回复按 `--max-assistant-chars`（默认 4000）截断并标注原文字数；`assistant` 为空则只发用户消息。

`--home` writes straight to the standard DSH location; `--out` overrides it; `--dry` prints
the JSONL. `--cwd` 在 Windows 上会自动规范成反斜杠（R1）。

### decode-dsh-session.mjs

    node decode-dsh-session.mjs --in <session.v4.jsonl.zstd> [--out <decoded.jsonl>] [--json]

Prints frame/event counts, header fields and an event-type histogram; `--out` writes the
decoded JSONL (header line first). Exit 1 when the file does not decode cleanly.

### list-dsh-sessions.mjs

    node list-dsh-sessions.mjs --home <DSH_HOME> [--cwd <workspace>] [--json]

Enumerates `<DSH_HOME>/sessions/*/*/session.v4.jsonl.zstd` and, for each, shows id, cwd,
title, creation date, turn/user counts, frame count and size. `--cwd` filters by the
header `cwd`.

### generate-dsh-cache.mjs

    node generate-dsh-cache.mjs --home <DSH_HOME> (--session <session-id> | --all) [--template <projcache.json>] [--out <dir>] [--force] [--json]

Writes the version-7 projection cache entry the sidebar reads. Row defaults mirror a
real DSH home; pass `--template` to seed from an existing cache of your DSH version.
Existing entries are skipped unless `--force`.

### verify-dsh-session.mjs

    node verify-dsh-session.mjs --in <session.v4.jsonl.zstd> [--home <DSH_HOME>] [--session-id <id>] [--require-cache] [--dsh <launcher>] [--run-dsh] [--timeout-ms 30000] [--json]

Offline checks: header frame is exactly one line; one event per frame; continuous `seq`
from 0; `session/title` with valid `messageSeqs`; no `assistant/message` without a model
stream; optional projcache presence. With `--run-dsh --dsh <launcher> --home <DSH_HOME>` it
also runs the live loader and reports `accepted` / `rejected (format error)`.

### selftest.mjs

    node selftest.mjs [--dsh <launcher>] [--keep] [--timeout-ms 30000]

Creates a throw-away DSH home under the OS temp directory and runs the whole chain:

    privacy scan → build → decode → list → verify (offline) → negative control (seq gap rejected)
    → generate cache → verify (live, optional) → export smoke tests (synthetic fixtures)

`--dsh` (or `DSH_CLI`) enables the live loader check; without it that step is skipped.
The temp directory is removed unless `--keep` is given. The privacy scan fails if any
file in this folder contains a hard-coded personal path.

### lib/dsh-session.mjs

Shared helpers imported by the scripts above: Zstandard frame splitting/decoding,
session read/write (one event per frame), workspace folder encoding, session discovery,
event-type histogram and a tiny CLI parser. No personal paths or content.

## Privacy

* Input data (chat exports, MiMo databases) stays wherever you point `--src`/`--db-dir`;
  these scripts only write to the `--out`/`--home` locations you choose.
* The scripts themselves contain no personal path, key or session content; `selftest.mjs`
  enforces this with a scan over the whole `scripts/` folder.
* Prefer `--home` pointing at a DSH instance you own and a backup of
  `<DSH_HOME>/storages/workspace.json` before writing real sessions.

## Typical end-to-end migration

    # 1. extract sources
    node export-vscode-chat.mjs --src "<workspaceStorage>/<hash>/chatSessions" --out ./out
    node export-mimo.mjs --store "<git-version-store>" --db-dir "<MiMo db dir>" --out ./out

    # 2. build one DSH session per imported conversation
    node build-dsh-session.mjs --home "<DSH_HOME>" --cwd "<workspace>" --input ./out/messages.txt --title "Imported chat"

    # 3. project + validate
    node generate-dsh-cache.mjs --home "<DSH_HOME>" --session <session-id>
    node verify-dsh-session.mjs --in "<DSH_HOME>/sessions/<encoded-workspace>/<session-id>/session.v4.jsonl.zstd"          --home "<DSH_HOME>" --session-id <session-id> --dsh "<DSH_INSTALL>/resources/runtime/cli/bin/dsh.cmd" --run-dsh

    # 4. make DSH (and its sidebar) reload the session store
