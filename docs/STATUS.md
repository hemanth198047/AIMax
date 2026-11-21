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
| 3 | Interactive UI | ✅ core · 🟡 rest | **Browser-verified** (Playwright + real Chrome): 3-pane layout, streaming chat, context selector, persisted selections, sandbox panel. Missing: resizable/collapsible panels, bottom console tabs (logs/problems/tests), artifact viewer, search, rename/pin/archive/branch UI. |
| 4 | Project intelligence | 🟡 | CRUD + switching. Missing: dashboard, templates, per-project memory settings. |
| 5 | Person intelligence | 🟡 | CRUD. Missing: dashboard, aliases, merge, retention, task ownership UI. |
| 6 | Project–person | ✅ link UI · 🟡 rest | Link/unlink a person to a project with a role (UI, tested). Combined `project_person` scope enforced end-to-end (tested). No relationship queries / graph yet. |
| 7 | Attachments | 🟡 | Upload via button/drag-drop/paste, chips, size limit, stored; **plain-text/code/CSV/JSON extraction only** (100 KB cap), fenced as untrusted when sent to a provider; binary/PDF/DOCX/XLSX/images are stored but **not read** and the UI says so. No previews, no archive handling, no OCR/image understanding. |
| 8 | Real sandbox | ✅ process-level · 🟡 container | Modes `readonly`/`temporary`/`container`/`direct` are enforced and tested (scrubbed env, timeout + process-tree kill, output cap, path-escape/symlink guard, approval for direct, confirm for destructive). **Temporary mode is NOT a security boundary** (runs as your OS user). **Container mode is implemented but NOT VERIFIED** — no Docker daemon was available to test; its test runs when `AIMAX_TEST_DOCKER_IMAGE` is set. Memory/CPU *reporting* and pause/resume/snapshot not built. |
| 9 | Terminal / file explorer / git / checkpoints | ✅ API · 🟡 UI | Streaming terminal with Stop, file tree + viewer, git status/diff, checkpoints + restore (tested over HTTP). UI compiles and builds but **was not visually verified in a browser**. No app preview / port detection yet. |
| 10 | Playwright | ❌ | |
| 11 | Gateway / prompt enhancement | 🟡 browser-verified | Deterministic (no LLM): task classifier, prompt enhancement (off/minimal/balanced/maximum; your text is never rewritten, guidance is appended in a labeled block), keyword context retrieval with a char budget (current message + last 2 user turns). Activity strip + "Retrieved memory" panel in the UI. Heuristic classifier only; no token counting, no caching, no routing by task. |
| 12 | MemoryVault | ✅ (this stage) | FTS5 + triggers, strict scope enforcement, tests. Missing: provenance workflow, staleness, auditor. |
| 13 | Engineering knowledge | 🟡 | Decisions/solutions/failures CRUD; fingerprint uses `LIKE`. |
| 14–16 | Caching, graphs, continuity | ❌ | |
| 17 | MCP server | 🟡 | 11 tools over plain HTTP (`/mcp/call`). **Not real MCP protocol (no JSON-RPC/stdio)**, so Claude Code cannot attach it as-is. Generated config snippet is not valid. |
| 18 | Claude adapter | 🟡 **real CLI UNVERIFIED** | `claude -p --output-format stream-json` streaming, session resume (new turn only, falls back to full history), cancel (Stop kills the process and saves the partial answer), sessions bound to the exact project/person scope, all CLI tools disabled, empty cwd. Tested only against a **fake CLI** that emulates the assumed event format; flags came from `--help`, never run against a real Claude. The AI cannot touch the sandbox itself: it can only *propose* a command in an `aimax-run` block, which runs only after you click Run (verified in browser). Windows `.cmd` shim handling untested. |
| 19–20 | Cursor / Codex | ❌ | Reported "unavailable". |
| 21 | Subscription compliance | ❌ | Nothing tracks states/limits/zero-overage. |
| 22 | Ollama | 🟡 | Chat + model list. Always picks `models[0]`. No embeddings. |
| 23 | FreeLLMAPI | ❌ | Reported unavailable, hard-coded. |
| 24 | Hybrid routing | ❌ | `auto` = Claude else Ollama. No tiers / quality gate. |
| 25 | DesignIQ | 🟡 | Design-token CRUD. `audit` only runs `pixelslop status` — **not a real audit**. Path hard-coded to `D:\ProjectsPortfolio\pixelslop`. |
| 27 | Link Vault | 🟡 | Read-only SQLite reader, keyword classifier. Path hard-coded; no incremental sync. |
| 28–36 | SkillScout … hardening | ❌ | |

## Defects found (and status)
1. **FIXED** — Deleting a memory entry corrupted the FTS index → every later search 500'd (`SQLITE_CORRUPT_VTAB`). Now trigger-maintained; index rebuilt on startup (repairs existing DBs).
2. **FIXED** — Privacy leak: retrieval used `project_id IS NULL OR …`, so any entry with a NULL id matched every context, and MCP `search_memory` had no scoping. Now one scope module (`memory/scope.ts`) used by chat, REST and MCP; 9 tests cover the matrix.
3. **FIXED** — `PATCH` routes interpolated request-body keys into SQL. Now one allow-listed `updateRow()` (hostile keys ignored; tested).
4. **PARTLY FIXED** — Sandbox now has guards (see Phase 8), but untrusted code must use `container` mode, which is unverified. Do not run untrusted code in `temporary` mode.
5. **PARTLY FIXED** — decisions/solutions/failures/discoveries, fingerprint and MCP tools are now project-scoped (no project ⇒ global rows only; tested). **Still open:** person scope on decisions, conversations/messages/attachments/tasks listings are unfiltered (they are only used for the owner's own UI, but must be scoped before any provider handoff/export).
6. **OPEN** — Hard-coded `D:\…` paths (pixelslop, LinkVault) and fake provider versions; should come from config/discovery.
7. **OPEN** — Windows-only paths (`AppData\Roaming`); now overridable with `AIMAX_DATA_DIR`.

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
4. Real MCP server (JSON-RPC) so Claude Code can attach to the memory/project tools.
5. Remaining scope gaps: conversations/messages/tasks listings and person scope on decisions.
