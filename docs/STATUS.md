# AImax — Build Status vs. Master Prompt

_Last updated: 2026-11-21 (stage 3: browser-verified first milestone). Method: read all source, type-checked, started the server and exercised the API.
Nothing below is marked ✅ unless it was run._

## Verdict
A working **skeleton** (~3.5k lines): chat UI, projects/people CRUD, SQLite memory, a basic MCP HTTP server, a
Link Vault reader and a sandbox *stub*. It type-checks and starts. Before this stage it had **no tests** and
**two defects that break core promises** (memory search corruption, private-scope leakage). Most of the 70
subsystems in the prompt are not started.

## Phase matrix
Legend: ✅ verified working · 🟡 partial/unverified · ❌ not started

| # | Phase | State | Evidence / gap |
|---|-------|-------|----------------|
| 1 | Environment discovery | 🟡 | `aimax doctor` checks tool versions. Provider versions in `providers.ts` are **hard-coded**, not discovered. No capability matrix. |
| 2 | Foundation | 🟡 | Fastify + SQLite (WAL), **versioned migrations** (`PRAGMA user_version`), allow-listed updates, 31 server tests. Still missing: logging config, client tests, CI. |
| 3 | Interactive UI | ✅ core · 🟡 rest | **Browser-verified** (Playwright + real Chrome): 3-pane layout, streaming chat, context selector, persisted selections, sandbox panel. Chat **search, rename, pin, archive/restore, delete** are browser-verified. Missing: resizable/collapsible panels, bottom console tabs, artifact viewer, branching. |
| 4 | Project intelligence | 🟡 | CRUD + switching + **overview** (sidebar → Overview: chats, memory, decisions, open tasks, people, 30-day tokens; project-scoped, tested). Missing: templates, per-project memory settings. |
| 5 | Person intelligence | 🟡 | CRUD. Missing: dashboard, aliases, merge, retention, task ownership UI. |
| 6 | Project–person | ✅ link UI · 🟡 rest | Link/unlink a person to a project with a role (UI, tested). Combined `project_person` scope enforced end-to-end (tested). No relationship queries / graph yet. |
| 7 | Attachments | 🟡 | Upload via button/drag-drop/paste, chips, 50 MB limit. **Read locally**: plain text/code/CSV/JSON, **PDF** (text layer, ≤100 pages), **DOCX**, **XLSX** (≤200 rows/sheet), **PPTX**; output capped at 100 KB and fenced as untrusted data. Zip is **listed only** (never extracted; unsafe paths flagged); declared-size/entry-count zip-bomb guards. **Not read**: scanned PDFs and images (no OCR/vision — the UI says so), legacy .doc/.xls/.ppt, other binaries. Extractors are hand-written XML readers: formulas show cached values, merged cells/formatting are ignored. Attachments are context-gated (see Stage 7). No rendered previews yet (text preview endpoint only). |
| 8 | Real sandbox | ✅ process-level · 🟡 container | Modes `readonly`/`temporary`/`container`/`direct` are enforced and tested (scrubbed env, timeout + process-tree kill, output cap, path-escape/symlink guard, approval for direct, confirm for destructive). **Temporary mode is NOT a security boundary** (runs as your OS user). **Container mode is implemented but NOT VERIFIED** — no Docker daemon was available to test; its test runs when `AIMAX_TEST_DOCKER_IMAGE` is set. Memory/CPU *reporting* and pause/resume/snapshot not built. |
| 9 | Terminal / file explorer / git / checkpoints | ✅ API · 🟡 UI | Streaming terminal with Stop, file tree + viewer, git status/diff, checkpoints + restore (tested over HTTP). UI compiles and builds but **was not visually verified in a browser**. No app preview / port detection yet. |
| 9b | **Agent mode** (edit code) | 🟡 fake-CLI + browser verified · **real CLI unverified** | (1) **AI edit proposals** for any provider: `aimax-edit` SEARCH/REPLACE blocks → diff computed from the real sandbox files → applied only on click (all-or-nothing, exact single match, CRLF-safe, path/symlink/.git guard, checkpoint first). (2) **Promote**: review the sandbox diff, then "Apply to my project" (confirm) using `git apply --check` — refused if your real project changed since the sandbox started; undoable (patch stored). (3) **CLI agent** (Claude Code only so far): runs *inside the sandbox copy* with Read/Edit/Write/Glob/Grep, `--permission-mode acceptEdits`, no Bash/web/sub-agents/MCP; checkpoint before every run (restore = undo); one agent per sandbox; counted in the usage ledger and blocked by limits. Refused in read-only/direct modes. **Not verified**: how real Claude Code behaves with these flags (tool_use event shape, whether it can read outside the folder in `-p` mode), Windows. Agents cannot run tests; use the terminal/proposals afterwards. Cursor/Codex agents: not built (need real CLI output). |
| 9c | **Import earlier chats** | 🟡 generic files tested · **Claude Code & Cursor readers UNVERIFIED against real data** | Sidebar → *Import chats*. Reads **local files only** (nothing is sent anywhere). Sources: Claude Code sessions (`~/.claude/projects/**/*.jsonl`, `CLAUDE_CONFIG_DIR` honoured), Cursor chats (`state.vscdb` opened read-only), and exported files (OpenAI-style JSON/JSONL, ChatGPT `conversations.json`, Claude.ai export, `User:/Assistant:` markdown/text) — the file route is the one to use for FreeLLMAPI exports. Imports are scoped to the chosen project/person (or global), de-duplicated (re-importing is skipped), size-capped, stored as plain history with provider `imported:<source>`, and credential-masked by default (best effort, **not a guarantee**; you can turn it off). Only dialogue is kept (tool output, thinking, sidechains and system reminders are dropped; Claude Code tool use is noted as one line). **Continuing** an imported chat uses a new history budget for all conversations: the newest 30 messages / 60k chars are sent, and older user asks are carried as a short, labeled *untrusted-data* digest. **Not verified**: the Claude Code JSONL layout is written from memory and the Cursor SQLite layout is a best-effort guess (tested only on synthetic fixtures I built); the FreeLLMAPI export format is unknown. If a scan finds nothing, its diagnostics line says what was looked for. |
| 10 | Playwright | ❌ | |
| 11 | Gateway / prompt enhancement | 🟡 browser-verified | Deterministic (no LLM): task classifier, prompt enhancement (off/minimal/balanced/maximum; your text is never rewritten, guidance is appended in a labeled block), keyword context retrieval with a char budget (current message + last 2 user turns). Activity strip + "Retrieved memory" panel in the UI. Heuristic classifier only; no token counting, no caching, no routing by task. |
| 12 | MemoryVault | ✅ (this stage) | FTS5 + triggers, strict scope enforcement, tests. Missing: provenance workflow, staleness, auditor. |
| 13 | Engineering knowledge | 🟡 | Decisions/solutions/failures CRUD; fingerprint uses `LIKE`. |
| 14–16 | Caching, graphs, continuity | 🟡 | **Continuity**: deterministic conversation handoff summary (stored messages only, no model; honest footer) with Copy in the UI. **Response caching deliberately not built** (stale/cross-scope answers are a correctness risk). No knowledge graph, no token counting. |
| 17 | MCP server | 🟡 protocol tested · real client handshake only | Real MCP (JSON-RPC 2.0) over **stdio** (`packages/server/src/mcp/stdio.ts`) and `POST /mcp`: initialize, ping, tools/list, tools/call (tool errors as `isError`). The stdio server is **pinned** to one project/person via env; tool arguments cannot widen it, lists are restricted to that scope, and writes land at exactly that scope with provenance `inferred`. Tested by spawning the real process (5 tests). `claude mcp list` reported it **Connected** (handshake only — no model call, so tool use from a real Claude session is unverified). `GET /mcp/config?project_id=&person_id=` generates the config; it needs `npx tsx` and the repo checked out. Legacy `/mcp/call` is unpinned and unauthenticated (localhost only). |
| 18 | Claude adapter | 🟡 **real CLI UNVERIFIED** | `claude -p --output-format stream-json` streaming, session resume (new turn only, falls back to full history), cancel (Stop kills the process and saves the partial answer), sessions bound to the exact project/person scope, all CLI tools disabled, empty cwd. Tested only against a **fake CLI** that emulates the assumed event format; flags came from `--help`, never run against a real Claude. The AI cannot touch the sandbox itself: it can only *propose* a command in an `aimax-run` block, which runs only after you click Run (verified in browser). Windows `.cmd` shim handling untested. |
| 19–20 | Cursor / Codex adapters | 🟡 fake-CLI tested · **real CLIs UNVERIFIED** | `agent -p --output-format stream-json` and `codex exec - --json --ephemeral -o` (from public docs). Prompt on stdin, scratch cwd, read-only, API-key env vars removed, only used when picked (never by `auto`). Live-text event shapes and flags such as `--skip-git-repo-check` are unconfirmed. |
| 20b | **Settings + subscription sign-in** | 🟡 fake-CLI + browser verified · **real CLIs UNVERIFIED** | Sidebar → Settings (previously a dead button). Accounts for Claude, Cursor, OpenAI/ChatGPT: shows whether each official CLI is installed, its version, and whether it reports you as signed in (from the CLI's own `status` command — **heuristic**, based on exit code and wording; shown raw next to the badge). **Sign in / Sign out** open a terminal on your computer running the CLI's own login (browser sign-in with your subscription account). AImax never sees or stores a password/token and never reads credential files. No API keys. Subcommand names (`claude auth login|status|logout`, `cursor-agent login|status|logout`, `codex login|login status|logout`) are **from memory and probed at runtime** with `--help`; if absent AImax says so (older Claude Code: run `claude` and type `/login`). **Only Claude can actually be used for chat**; Cursor and Codex sign-in works but their adapters are not built. The sign-in endpoint is fixed-command only and requires an `X-AImax-UI` header (blocks other web pages). **API-key guard**: `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` in the environment are removed from Claude child processes (Claude Code would otherwise bill the API instead of your Pro subscription); override with `AIMAX_ALLOW_API_KEY=1`; Settings shows a warning when one is set. Windows terminal launch (`cmd /k`) untested. **Cursor**: the desktop app cannot be driven by other programs; the official route is the Cursor CLI (`agent`, older name `cursor-agent`; install: `irm 'https://cursor.com/install?win32=true' | iex` — from Cursor's docs, not run here). Settings detects the desktop app, explains this, and can open a visible terminal that runs the installer (fixed command, header-guarded). After installing, AImax must be restarted to see the new tool. |
| 21 | Subscription compliance | 🟡 local only | Local ledger of requests/characters AImax sent per provider (no message content), **user-set** per-hour/per-day limits enforced *before* a provider is called (tested), auto-routing falls back, provider-reported rate/usage limits pause that provider for 60 min (resume button). **Cannot see your real plan quota, usage outside AImax, or reset times** — limits are only what you configure. No plan-state tracking. |
| 21b | **Token usage report** | 🟡 browser + server verified · **real CLI token fields UNVERIFIED** | Usage & limits → *Full token report…*: per provider tokens used (in/out), **remaining against budgets YOU set** (rolling 24 h and 30 days), daily trend, models, biggest conversations (titles only for the current project/person; others are counted, not named), and deterministic suggestions that quote their numbers (context-heavy input, long threads → handoff, failures, no budget set, small Claude requests that could go to Ollama when reachable, agent share). Token budgets are **enforced before each call** like the request limits. Tokens = what the Claude CLI reported in its `result` event when present (field names from memory — **never seen from a real CLI**; the fake CLI emits them in tests), otherwise **estimated at ~4 chars/token (±30%)** — the report says what share is estimated. Agent runs are under-counted (task + summary text only). **Cannot see** your real plan quota, usage outside AImax, or reset times; cached-context tokens are shown separately, not counted. Cursor/Codex/FreeLLMAPI: nothing to report until their adapters exist. |
| 22 | Ollama | 🟡 | Chat + model list + **model selection** (falls back to the first installed model; tested against a fake Ollama server, **not a real one**). No embeddings. |
| 23 | FreeLLMAPI | 🟡 fake-server tested · **real server UNVERIFIED** | OpenAI-compatible SSE client for the self-hosted gateway (default `http://localhost:3001/v1`, model `auto`). Unified key stored locally, never returned to the browser. Settings → Local connections. Only used when picked. |
| 24 | Hybrid routing | 🟡 | `auto` = Claude if available and within budget, else Ollama (selected model); routing notes appear in the activity strip. No task-tier routing / quality gate. |
| 25 | DesignIQ | 🟡 | Design-token CRUD. `audit` only runs `pixelslop status` — **not a real audit**. Path hard-coded to `D:\ProjectsPortfolio\pixelslop`. |
| 27 | Link Vault | 🟡 | Read-only SQLite reader + keyword classifier. Path via `AIMAX_LINKVAULT_DB` (Windows default `D:\ProjectsPortfolio\LinkVault\linkvault.db`). **Opt-in** chat search (Settings → Link Vault): up to 4 matching links (title/url/summary, never transcripts) added to the message as untrusted reference data. Tested on a temp DB, not the real one. No incremental sync. |
| 28–36 | SkillScout … hardening | ❌ | |

## Defects found (and status)
1. **FIXED** — Deleting a memory entry corrupted the FTS index → every later search 500'd (`SQLITE_CORRUPT_VTAB`). Now trigger-maintained; index rebuilt on startup (repairs existing DBs).
2. **FIXED** — Privacy leak: retrieval used `project_id IS NULL OR …`, so any entry with a NULL id matched every context, and MCP `search_memory` had no scoping. Now one scope module (`memory/scope.ts`) used by chat, REST and MCP; 9 tests cover the matrix.
3. **FIXED** — `PATCH` routes interpolated request-body keys into SQL. Now one allow-listed `updateRow()` (hostile keys ignored; tested).
4. **PARTLY FIXED** — Sandbox now has guards (see Phase 8), but untrusted code must use `container` mode, which is unverified. Do not run untrusted code in `temporary` mode.
5. **PARTLY FIXED** — decisions/solutions/failures/discoveries, fingerprint and MCP tools are now project-scoped (no project ⇒ global rows only; tested). **Still open:** person scope on decisions, conversations/messages/attachments/tasks listings are unfiltered (they are only used for the owner's own UI, but must be scoped before any provider handoff/export).
6. **OPEN** — Hard-coded `D:\…` paths (pixelslop, LinkVault) and fake provider versions; should come from config/discovery.
7. **OPEN** — Windows-only paths (`AppData\Roaming`); now overridable with `AIMAX_DATA_DIR`.

## Stage 12 — import chats
See table row 9c. Tests: server 91 pass / 1 skipped (Docker), e2e 7 pass (run twice), both `tsc` clean, vite build OK.

## Stage 11 — agent mode
- New: edit proposals, promote/undo, Claude CLI agent in the sandbox copy (Phase 9b row). Migration v4 (`base_sha`, `sandbox_promotions`, `agent_runs`).
- Fixed: `GET /api/sandbox/:id/file` returned 500 for a missing file (now 404).
- Tests: 84 server pass (1 Docker skip) — 9 new for edits/promote/agent incl. escape attempts, stale-project refusal, undo, locked-down CLI args; 6 e2e pass (new: proposal → diff → apply → promote → undo, and an agent run against the fake CLI).
- AImax still cannot edit files by itself without an explicit click: edits land in a sandbox copy; only "Apply to my project" touches your repo.

## Stages 6–10 (one run)
- **6 Attachments**: PDF/DOCX/XLSX/PPTX extraction, zip listing, zip-bomb guards (Phase 7 row). 9 fixture-based tests incl. bombs and wrong-extension files.
- **7 Context checks**: conversation messages, attachments, continue/rename/delete and handoff now require the conversation to be visible in the caller's project/person context (404 otherwise); an attachment bound to one conversation can't be pulled into another. Tests drive the real routes.
- **8 Chat management** + a real bug: `apiFetch` sent a JSON content-type on body-less DELETE, which Fastify rejects, so deleting a conversation, unlinking a person and deleting a sandbox from the UI silently failed. Fixed and covered by e2e.
- **9 Providers**: removed hard-coded provider versions (real `claude --version`), usage ledger + limits (Phase 21 row), Ollama model choice, UI panel.
- **10 Continuity**: handoff summary. Response cache intentionally skipped (see Phase 14–16).
- Tests: 75 server pass (1 Docker skip), 5 Playwright e2e pass, both type-checks and the client build clean.
- Still **unverified**: real Claude CLI runs, real Ollama, Windows, container mode, real MCP tool use from a Claude session.
- Known gaps: no OCR/vision; Cursor/Codex/FreeLLMAPI adapters; knowledge graph; task-tier routing; discoveries/solutions person scope; legacy `/mcp/call` unauthenticated.

## Stage 5 — real MCP server + remaining scope gaps
- MCP: see Phase 17 row. Old fake `/mcp/config` (an invalid stdin proxy) replaced.
- **Privacy fixes**: `GET /api/conversations` and `/api/tasks` previously listed everything regardless of context; they now follow the memory scope rules (global / project / person / project+person), as do decisions (person scope added). New chats are created in the active context. Fixed a startup race where the persisted active conversation was cleared before the list loaded.
- Tests: 56 server pass (1 Docker skip), 3 e2e pass (3 runs), type-check + build clean.
- Still open: messages are fetchable by conversation id without a context check (ids are unguessable UUIDs, single local user); discoveries/solutions have no person scope; attachments are not context-gated.

## Stage 4 — gateway, Claude adapter, approval-gated sandbox use
- 51 server tests (50 pass, 1 skipped = Docker), 3 Playwright tests pass (3 consecutive runs), client + server typecheck, vite build OK.
- New e2e: AI proposes a command → no run exists until approval → click Run → output + exit 0 in the sandbox; enhancement `off` removes guidance; activity strip and retrieved-memory panel populate; Stop keeps the partial answer marked `(stopped)`.
- Fixed along the way: Stop could lose the partial answer in the UI (client reloaded before the server saved it); Ollama NDJSON lines split across chunks.
- Not verified: real `claude` CLI, real Ollama, Windows, container mode. Fenced code blocks without a language tag render inline-style (pre-existing quirk, made visible by the proposal override).

## Stage 3 — first working milestone (§151), browser-verified
`npm run test:e2e` drives the real UI in real Chrome against the real server and SQLite DB. Only the AI provider is replaced by a
deterministic **test-only** provider (`AIMAX_TEST_PROVIDER=1`; never selected by `auto`). Verified steps:
open app → create project (with repo) → create person → select both → combined scope → link person to project (role) → save
project+person memory → new conversation → attach 2 files (1 readable, 1 binary flagged "not read") → ask → scoped memory + attachments
reached the provider → create sandbox (git worktree of the project repo) → run command → terminal output + exit code → changed
files + diff (incl. new files) → checkpoint → file viewer → real project untouched → **restart server and browser** → same context,
conversation and sandbox restored → conversation continues with history. A second test proves privacy in the UI (project+person → project →
global → person-only) and that a note saved in person-only context stays `person`-scoped. Mutation-checked: re-introducing the old
scope bug makes it fail. Screenshots are written to `e2e/screenshots/` (gitignored).

**Bugs found by the walkthrough and fixed:** person-only memories were saved as `global` (privacy leak); no UI to link person↔project;
attach button was a dead input; selections were lost on reload; attachments reached the model in arbitrary order; diff omitted new files;
icon-only buttons had no accessible names.

**Honest limits of this milestone**
- Steps 8–14 of §151 ("route through a provider → provider executes a safe task in the sandbox") are verified only as *user-driven*
  sandbox runs. **The AI cannot call the sandbox yet** (no tool-use loop); that needs the gateway + a real Claude adapter.
- The real providers (Claude CLI, Ollama) were **not** exercised end-to-end; the test provider stands in.
- Retrieval is keyword-only on the *current message* (FTS5 OR-terms): a follow-up with no shared keywords gets no memory. Needs the
  gateway's context builder (recent-turn terms, embeddings benchmark).
- Test machine was Linux; Windows-specific paths (PowerShell runner, `taskkill`, `NUL`) are written but **not exercised** here.

## Stage 2 — what changed
- `db/update.ts` allow-listed updates; `memory/projectScope.ts`; migrations v1 (sandbox columns + `sandbox_runs`)
- `sandbox/guard.ts` (path guard, env scrub, destructive-command detector), `runner.ts` (spawn, timeout, tree kill, cancel, cap, optional docker), `workspace.ts` (worktree/copy, git status/diff, checkpoints, restore, cleanup)
- `routes/sandbox.ts`: capabilities, create (4 modes), execute, **SSE run + cancel**, run history, files, file read, git, checkpoints, restore, delete
- Bug found by tests and fixed: streaming runs were cancelled instantly (`req` close fires after body read)
- `SandboxPanel.tsx` rebuilt: mode picker with approval, streaming terminal + Stop, Changes (diff/checkpoints), Files (viewer)
- Removed `executor.ts` (old unrestricted runner)
- Environment note: the committed `package-lock.json` was generated on Windows; on Linux `npm i` needs `@rollup/rollup-linux-x64-gnu` for the client build (not added to the lockfile).

## Done in stage 1
- FTS triggers + rebuild-on-start, `AIMAX_DATA_DIR`
- `memory/scope.ts`, `memory/search.ts` (strict scope, safe FTS query builder)
- Chat, `/api/memory`, MCP `search_memory` routed through them
- `npm test` (9 passing), `npm run typecheck`

## Recommended next stage
1. **Run on your Windows machine**: `npm install`, `npx playwright install chromium`, then `npm test` and `npm run test:e2e`
   (and with Docker Desktop: `set AIMAX_TEST_DOCKER_IMAGE=node:22-slim`). Windows paths and container isolation are still unproven.
2. **Verify the real Claude CLI** on your machine (send one short message with provider Claude and report what happens); the adapter has only seen a fake.
3. **Phase 7 (rest)**: PDF/DOCX/XLSX extraction, previews, zip-slip/decompression guards, image handling.
4. Try the MCP server from a real Claude Code session (`claude mcp add`, then ask it to search memory).
5. Remaining scope gaps listed under Stage 5.


## Stage 13 — connections and adapters
- Settings → Local connections shows live Ollama / Link Vault / FreeLLMAPI state. Cursor status no longer depends on `--help` probes; CLI detection re-reads the Windows PATH on each check.
- Tests: server 116 pass, e2e 10 pass, both `tsc` clean. **Nothing in this stage has run on Windows or against the real Cursor, Codex or FreeLLMAPI.**
- Needs real data from the owner: the first real error/output from each adapter, an Import-chats scan, one real Claude agent run.

## Stage 14 — pasted links
- Links in a message (max 3, http/https) are downloaded by AImax and added to that turn as **untrusted reference text** (HTML → readable text, plain text/JSON, PDF). Shown in the activity strip and context list; failures are reported to the model so it does not guess. On by default; Settings → Local connections turns it off.
- Safety: public hosts only. Every resolved address is checked at connect time and on each redirect (loopback, private, link-local, cloud metadata, CGNAT, IPv6 ULA/mapped refused); no cookies, credentials or logins; 10 s / 2 MB (PDF 10 MB) caps; PDF text via a temp file that is deleted at once. Test-only hook: `AIMAX_LINKS_ALLOW_HOST`.
- Not handled: pages that need JavaScript or a sign-in (reported as unreadable), YouTube transcripts, images. Tested against local fixture servers only — **not yet against real sites**.

## Stage 15 — Claude-style projects + workaround for private chat links
- Project page (sidebar → project → **Overview**): editable **instructions** (added to every chat's system prompt), **project knowledge** (files, notes, web pages; text only; capacity meter, 600k characters), **New chat in this project**, recent chats. Knowledge is per project (other projects get 404 / empty), small knowledge is included whole, large knowledge only the best-matching chunks (keyword scoring, 6k chars). Migration v7 (`project_knowledge`).
- Private chat links (claude.ai/chat, chatgpt.com/c, …) are not fetched at all; the app explains the workarounds (paste, handoff summary, export + Import chats). A 401/403 gets the paste/attach/add-to-knowledge workaround.
- Not done: ranking by meaning (no embeddings), per-project file originals, sharing projects, folders. Tested with fixture servers/files only.

## Stage 16 — links that need a login (no browser automation)
- A pasted link that needs a login (403/401, private chat hosts, empty JS pages) shows a **banner** in the chat: *Open the page in my browser* (a normal tab in the user's own browser, where they are already signed in) → Ctrl+A, Ctrl+C there → *Paste copied page* (reads the clipboard; textarea fallback) → *Re-send my message*. Pasted pages are stored locally for 24 h (`web_captures`, migration v8) and used by later reads of that link, including *Add link* in project knowledge. Settings can delete them.
- An earlier attempt drove a Chrome window with Playwright/CDP; sites' "verify you are human" checks detect automation and looped forever, so it was **removed** (AImax does not try to hide automation from sites). AImax never controls a browser or sees a login.
- Layout bug fixed: `scrollIntoView` in the message list scrolled the whole page and left blank space at the bottom; it now scrolls only the list (and the app root uses `overflow-clip`). Regression test in e2e.

## Stage 17 — Sandbox terminal that cannot go silent
- Windows commands run through `powershell -EncodedCommand` (no quoting problems), with progress bars off and UTF-8 output; PowerShell error XML (CLIXML) is turned back into readable text.
- The scrubbed environment now keeps harmless Windows system variables (ProgramFiles, PSModulePath, SystemDrive, …); APPDATA/LOCALAPPDATA point at a scratch folder. Secrets are still removed.
- A failure to start the shell is now printed in the terminal; a shell that exits while a background child holds the pipes no longer hangs the run.
- The run stream announces shell + folder, sends keepalives, and always ends with a `done` event; the client reports a stream that ends without one.
- Terminal shows "running in <folder> with <shell>", a "still running…" heartbeat, and a **Test terminal** button (`POST /api/sandbox/diagnose`).
- Tests: server 138 pass, e2e 16 pass. Unverified on a real Windows machine.
