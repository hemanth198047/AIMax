# AImax — Build Status vs. Master Prompt

_Last updated: 2026-11-21 (stage 2: hardening + real sandbox). Method: read all source, type-checked, started the server and exercised the API.
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
| 3 | Interactive UI | 🟡 | 3-pane layout, chat streaming, sidebar. Not browser-verified. No resizable panels, bottom console, artifact viewer. |
| 4 | Project intelligence | 🟡 | CRUD + switching. Missing: dashboard, templates, per-project memory settings. |
| 5 | Person intelligence | 🟡 | CRUD. Missing: dashboard, aliases, merge, retention, task ownership UI. |
| 6 | Project–person | 🟡 | `project_people` join + combined scope in UI. No relationship queries / graph. |
| 7 | Attachments | 🟡 | Upload saves to disk. **No extraction, preview, archive safety checks.** |
| 8 | Real sandbox | ✅ process-level · 🟡 container | Modes `readonly`/`temporary`/`container`/`direct` are enforced and tested (scrubbed env, timeout + process-tree kill, output cap, path-escape/symlink guard, approval for direct, confirm for destructive). **Temporary mode is NOT a security boundary** (runs as your OS user). **Container mode is implemented but NOT VERIFIED** — no Docker daemon was available to test; its test runs when `AIMAX_TEST_DOCKER_IMAGE` is set. Memory/CPU *reporting* and pause/resume/snapshot not built. |
| 9 | Terminal / file explorer / git / checkpoints | ✅ API · 🟡 UI | Streaming terminal with Stop, file tree + viewer, git status/diff, checkpoints + restore (tested over HTTP). UI compiles and builds but **was not visually verified in a browser**. No app preview / port detection yet. |
| 10 | Playwright | ❌ | |
| 11 | Gateway / prompt enhancement | ❌ | Chat just forwards last 20 msgs + 5 memory rows. |
| 12 | MemoryVault | ✅ (this stage) | FTS5 + triggers, strict scope enforcement, tests. Missing: provenance workflow, staleness, auditor. |
| 13 | Engineering knowledge | 🟡 | Decisions/solutions/failures CRUD; fingerprint uses `LIKE`. |
| 14–16 | Caching, graphs, continuity | ❌ | |
| 17 | MCP server | 🟡 | 11 tools over plain HTTP (`/mcp/call`). **Not real MCP protocol (no JSON-RPC/stdio)**, so Claude Code cannot attach it as-is. Generated config snippet is not valid. |
| 18 | Claude adapter | 🟡 | `claude -p` text mode, whole history re-sent each call, no sessions/streaming/cancel. |
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
1. **Verify container mode** on your Windows machine (Docker Desktop): `set AIMAX_TEST_DOCKER_IMAGE=node:22-slim && npm test`. Until that passes, treat container isolation as unproven.
2. **Browser-verify the UI** (first-milestone §151 steps 1–18) with Playwright: create project → person → link → conversation → attach → sandbox run → restart → resume.
3. **Phase 7 attachments**: text extraction (PDF/DOCX/CSV/…), previews, zip-slip/decompression-bomb guards, scoped storage.
4. **Phase 11/18**: a real gateway (task classification, deterministic prompt enhancement, context budget) and a Claude adapter with sessions/streaming/cancel instead of re-sending history through `claude -p`.
5. Make `/mcp` a real MCP server (JSON-RPC over stdio/streamable HTTP) so Claude Code can attach it.
