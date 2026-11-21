# AImax — Build Status vs. Master Prompt

_Last analysed: 2026-11-21. Method: read all source, type-checked, started the server and exercised the API.
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
| 2 | Foundation | 🟡 | Fastify + SQLite (WAL). No migrations framework, no logging config, **no tests (until now)**. |
| 3 | Interactive UI | 🟡 | 3-pane layout, chat streaming, sidebar. Not browser-verified. No resizable panels, bottom console, artifact viewer. |
| 4 | Project intelligence | 🟡 | CRUD + switching. Missing: dashboard, templates, per-project memory settings. |
| 5 | Person intelligence | 🟡 | CRUD. Missing: dashboard, aliases, merge, retention, task ownership UI. |
| 6 | Project–person | 🟡 | `project_people` join + combined scope in UI. No relationship queries / graph. |
| 7 | Attachments | 🟡 | Upload saves to disk. **No extraction, preview, archive safety checks.** |
| 8 | Real sandbox | ❌→stub | `executor.ts` runs host PowerShell with full env. **No isolation** (no container, no limits, no non-admin). Modes are labels only. |
| 9–10 | Terminal / Git / Playwright | ❌ | Execute endpoint only. No Git review, checkpoints, preview, browser automation. |
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
3. **OPEN** — `PATCH` routes build `SET col=?` from request-body *keys* (SQL-injection via column names) in projects, conversations, decisions.
4. **OPEN** — Sandbox executes arbitrary commands unrestricted; conflicts with prompt rules 27/28 until real isolation exists.
5. **OPEN** — Conversations/messages/attachments are not scope-filtered; decisions/solutions/failures/tasks queries ignore person scope.
6. **OPEN** — Hard-coded `D:\…` paths (pixelslop, LinkVault) and fake provider versions; should come from config/discovery.
7. **OPEN** — Windows-only paths (`AppData\Roaming`); now overridable with `AIMAX_DATA_DIR`.

## Done this stage
- FTS triggers + rebuild-on-start, `AIMAX_DATA_DIR`
- `memory/scope.ts`, `memory/search.ts` (strict scope, safe FTS query builder)
- Chat, `/api/memory`, MCP `search_memory` routed through them
- `npm test` (9 passing), `npm run typecheck`

## Recommended next stage
**Phase 8 — real sandbox foundation** (the prompt's first-milestone blocker), preceded by closing defects 3 and 5:
1. Allow-listed PATCH helper; scope filters on conversations/messages/decisions/solutions/tasks (+ tests).
2. Sandbox: git-worktree/temp-copy mode with env scrubbing, timeouts + process-tree kill, output caps, path-escape guard, SSE streaming and cancel; Docker mode only if Docker is detected. Isolation claims must be backed by tests.
3. Then Phase 9 (file explorer, git diff, checkpoints) to reach the "first working milestone" in §151.
