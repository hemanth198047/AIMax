/**
 * Usage report: what AImax itself sent to each provider, in tokens, against budgets the USER set, plus deterministic
 * suggestions. Tokens are the numbers the provider CLI reported when it reported any; otherwise an ESTIMATE of
 * ~4 characters per token. It cannot see your real plan quota, other apps' usage, or reset times.
 */
import { getDb } from '../db/index.js';
import { getLimits, TOKENS_SQL, activeCooldown, usageCounts, type Limit } from './usage.js';
import { visibleConversation } from '../memory/projectScope.js';
import type { MemoryContext } from '../memory/scope.js';

const IN_SQL = `(CASE WHEN reported_in IS NOT NULL THEN reported_in ELSE (input_chars+3)/4 END)`;
const OUT_SQL = `(CASE WHEN reported_out IS NOT NULL THEN reported_out ELSE (output_chars+3)/4 END)`;
const DAY = 86_400_000;

export interface Tip { id: string; level: 'info' | 'warn'; title: string; detail: string }
export interface ProviderReport {
  provider: string; requests: number; failed: number; tokens: number; inputTokens: number; outputTokens: number;
  reportedRequests: number; cacheReadTokens: number; costUsd: number | null; avgInputTokens: number; avgMs: number;
  last24h: number; last30d: number; paused: { until: string; reason: string } | null;
  budget: { per_day_tokens?: number; per_month_tokens?: number; remaining_24h?: number; remaining_30d?: number; used_pct_24h?: number; used_pct_30d?: number };
  requestLimit: Limit | null; requestsLastHour: number; requestsLast24h: number;
}
export interface Report {
  generatedAt: string; days: number; note: string; totalTokens: number; estimatedShare: number;
  providers: ProviderReport[];
  daily: { day: string; tokens: number; requests: number }[];
  byModel: { provider: string; model: string; requests: number; tokens: number }[];
  topConversations: { id: string; title: string; requests: number; tokens: number; avgInputTokens: number }[];
  hiddenContexts: { conversations: number; tokens: number };
  tips: Tip[];
}

const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export function buildReport(opts: { days?: number; ctx: MemoryContext; ollamaAvailable?: boolean; now?: Date }): Report {
  const db = getDb(); const now = opts.now ?? new Date();
  const days = Math.min(Math.max(Math.floor(opts.days ?? 30), 1), 365);
  const since = new Date(now.getTime() - days * DAY).toISOString();
  const limits = getLimits();
  const provs = (db.prepare('SELECT DISTINCT provider FROM usage_events WHERE ts>=? ORDER BY provider').all(since) as { provider: string }[]).map(r => r.provider);
  for (const p of Object.keys(limits)) if (!provs.includes(p)) provs.push(p);

  const providers: ProviderReport[] = provs.map(p => {
    const r = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(1-ok),0) failed, COALESCE(SUM(${TOKENS_SQL}),0) tok, COALESCE(SUM(${IN_SQL}),0) tin, COALESCE(SUM(${OUT_SQL}),0) tout,
      COALESCE(SUM(CASE WHEN reported_in IS NOT NULL OR reported_out IS NOT NULL THEN 1 ELSE 0 END),0) rep, COALESCE(SUM(reported_cache_read),0) cache,
      SUM(reported_cost) cost, COALESCE(AVG(duration_ms),0) ms FROM usage_events WHERE provider=? AND ts>=?`).get(p, since) as any;
    const t = (ms: number) => (db.prepare(`SELECT COALESCE(SUM(${TOKENS_SQL}),0) n FROM usage_events WHERE provider=? AND ts>=?`).get(p, new Date(now.getTime() - ms).toISOString()) as { n: number }).n;
    const last24h = t(DAY), last30d = t(30 * DAY); const lim = limits[p] ?? null; const c = usageCounts(p, now);
    const budget: ProviderReport['budget'] = {};
    if (lim?.per_day_tokens !== undefined) { budget.per_day_tokens = lim.per_day_tokens; budget.remaining_24h = Math.max(0, lim.per_day_tokens - last24h); budget.used_pct_24h = lim.per_day_tokens ? Math.round(last24h * 100 / lim.per_day_tokens) : 100; }
    if (lim?.per_month_tokens !== undefined) { budget.per_month_tokens = lim.per_month_tokens; budget.remaining_30d = Math.max(0, lim.per_month_tokens - last30d); budget.used_pct_30d = lim.per_month_tokens ? Math.round(last30d * 100 / lim.per_month_tokens) : 100; }
    return { provider: p, requests: r.n, failed: r.failed, tokens: r.tok, inputTokens: r.tin, outputTokens: r.tout, reportedRequests: r.rep, cacheReadTokens: r.cache,
      costUsd: r.cost === null ? null : Math.round(r.cost * 10000) / 10000, avgInputTokens: r.n ? Math.round(r.tin / r.n) : 0, avgMs: Math.round(r.ms),
      last24h, last30d, paused: activeCooldown(p, now), budget, requestLimit: lim, requestsLastHour: c.hour, requestsLast24h: c.day };
  });

  const totalTokens = providers.reduce((n, p) => n + p.tokens, 0);
  const estTokens = (db.prepare(`SELECT COALESCE(SUM(${TOKENS_SQL}),0) n FROM usage_events WHERE ts>=? AND reported_in IS NULL AND reported_out IS NULL`).get(since) as { n: number }).n;

  // daily series, local calendar days, zero-filled
  const rows = db.prepare(`SELECT date(ts,'localtime') d, COUNT(*) n, COALESCE(SUM(${TOKENS_SQL}),0) tok FROM usage_events WHERE ts>=? GROUP BY d`).all(since) as { d: string; n: number; tok: number }[];
  const map = new Map(rows.map(r => [r.d, r]));
  const daily: Report['daily'] = [];
  for (let i = Math.min(days, 60) - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * DAY); const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    daily.push({ day: key, tokens: map.get(key)?.tok ?? 0, requests: map.get(key)?.n ?? 0 });
  }

  const byModel = (db.prepare(`SELECT provider, model, COUNT(*) requests, COALESCE(SUM(${TOKENS_SQL}),0) tokens FROM usage_events WHERE ts>=? GROUP BY provider, model ORDER BY tokens DESC LIMIT 10`).all(since) as any[]);

  // conversations: titles only for ones visible in the caller's context; everything else is aggregated without names
  const convRows = db.prepare(`SELECT conversation_id id, COUNT(*) requests, COALESCE(SUM(${TOKENS_SQL}),0) tokens, COALESCE(AVG(${IN_SQL}),0) avgin
    FROM usage_events WHERE ts>=? AND conversation_id IS NOT NULL GROUP BY conversation_id ORDER BY tokens DESC`).all(since) as { id: string; requests: number; tokens: number; avgin: number }[];
  const top: Report['topConversations'] = []; const hidden = { conversations: 0, tokens: 0 };
  for (const r of convRows) {
    const c = visibleConversation(r.id, opts.ctx);
    if (c) { if (top.length < 10) top.push({ id: r.id, title: String(c.title), requests: r.requests, tokens: r.tokens, avgInputTokens: Math.round(r.avgin) }); }
    else if (db.prepare('SELECT 1 FROM conversations WHERE id=?').get(r.id)) { hidden.conversations++; hidden.tokens += r.tokens; }
  }

  // ── deterministic suggestions: each states the numbers it is based on ──
  const tips: Tip[] = [];
  for (const p of providers) {
    if (p.provider === 'test') continue;
    const b = p.budget;
    if (b.used_pct_24h !== undefined && b.used_pct_24h >= 80) tips.push({ id: `budget24-${p.provider}`, level: 'warn', title: `${p.provider}: ${b.used_pct_24h}% of your 24-hour token budget used`, detail: `~${fmt(p.last24h)} of ${fmt(b.per_day_tokens!)} in the last 24 h.${b.used_pct_24h >= 100 ? ' AImax is no longer calling it until usage rolls off (zero-overage guard).' : ' AImax will stop calling it at 100%.'}` });
    if (b.used_pct_30d !== undefined && b.used_pct_30d >= 80) tips.push({ id: `budget30-${p.provider}`, level: 'warn', title: `${p.provider}: ${b.used_pct_30d}% of your 30-day token budget used`, detail: `~${fmt(p.last30d)} of ${fmt(b.per_month_tokens!)} in the last 30 days.` });
    if (p.requests >= 5 && !p.requestLimit?.per_day_tokens && !p.requestLimit?.per_month_tokens && p.provider !== 'ollama')
      tips.push({ id: `nobudget-${p.provider}`, level: 'info', title: `Set a token budget for ${p.provider}`, detail: `You have used ~${fmt(p.tokens)} tokens in ${days} days through AImax with no token budget, so "remaining" cannot be shown and nothing stops overuse. Pick a number from your plan and enter it in Usage & limits.` });
    if (p.requests >= 5 && p.outputTokens > 0 && p.inputTokens / p.outputTokens >= 10 && p.avgInputTokens >= 2000)
      tips.push({ id: `ctx-${p.provider}`, level: 'warn', title: `${p.provider}: input is ${Math.round(p.inputTokens / p.outputTokens)}× the output`, detail: `Average ${fmt(p.avgInputTokens)} tokens sent per request. Most spend is context, not answers. Start a fresh conversation from the handoff summary when a thread gets long, lower the enhancement level, and keep memory/knowledge entries short.` });
    if (p.requests >= 5 && p.failed / p.requests > 0.15)
      tips.push({ id: `fail-${p.provider}`, level: 'warn', title: `${p.provider}: ${p.failed} of ${p.requests} requests failed`, detail: 'Failed calls still cost time and may count against limits. Check the recent errors in Usage & limits; if they are rate limits, lower your per-hour limit so AImax stops before the provider does.' });
    if (p.provider === 'claude' && opts.ollamaAvailable) {
      const small = (db.prepare(`SELECT COUNT(*) n FROM usage_events WHERE provider='claude' AND ts>=? AND ok=1 AND model!='agent' AND ${IN_SQL}<600 AND ${OUT_SQL}<250`).get(since) as { n: number }).n;
      if (small >= 10) tips.push({ id: 'small-to-ollama', level: 'info', title: `${small} small Claude requests could run on Ollama`, detail: 'These had short prompts and short answers. Use the "auto" provider (Claude first, Ollama as fallback) or pick Ollama for quick questions to save Claude allowance. Local models are weaker; keep Claude for hard work.' });
    }
  }
  const agentTok = (db.prepare(`SELECT COALESCE(SUM(${TOKENS_SQL}),0) n, COUNT(*) c FROM usage_events WHERE ts>=? AND model='agent'`).get(since) as { n: number; c: number });
  if (agentTok.c >= 2 && totalTokens > 0 && agentTok.n / totalTokens > 0.4)
    tips.push({ id: 'agent-share', level: 'info', title: `Agent runs are ${Math.round(agentTok.n * 100 / totalTokens)}% of your tokens`, detail: `${agentTok.c} runs. Note: agent token counts are estimated from the task and summary text and likely UNDER-count what the CLI really used (it reads many files). Give agents narrower tasks and a small test folder.` });
  const heavy = top.filter(c => c.requests >= 15 && c.avgInputTokens >= 3000);
  if (heavy.length) tips.push({ id: 'long-convs', level: 'warn', title: `${heavy.length} long conversation(s) are expensive per message`, detail: `${heavy.slice(0, 3).map(c => `“${c.title.slice(0, 40)}” (${c.requests} requests, ~${fmt(c.avgInputTokens)} tokens in per request)`).join('; ')}. Use "handoff" and continue in a new conversation.` });
  if (top.length && totalTokens > 0 && top[0].tokens / totalTokens > 0.5 && top[0].requests >= 5)
    tips.push({ id: 'one-conv', level: 'info', title: `One conversation uses ${Math.round(top[0].tokens * 100 / totalTokens)}% of all tokens`, detail: `“${top[0].title.slice(0, 50)}”: ${top[0].requests} requests, ~${fmt(top[0].tokens)} tokens.` });
  if (hidden.tokens > 0) tips.push({ id: 'hidden', level: 'info', title: `${hidden.conversations} conversation(s) in other projects/people used ~${fmt(hidden.tokens)} tokens`, detail: 'Their titles are hidden here because they are outside the current project/person context. Switch context to see them.' });
  if (estTokens > 0 && totalTokens > 0 && estTokens / totalTokens > 0.5)
    tips.push({ id: 'estimated', level: 'info', title: `${Math.round(estTokens * 100 / totalTokens)}% of these numbers are estimates`, detail: 'The provider did not report token counts for those requests, so AImax estimated them (~4 characters per token). Treat them as ±30%; real plan accounting can differ, especially for cached context and tool use.' });

  return { generatedAt: now.toISOString(), days, totalTokens, estimatedShare: totalTokens ? Math.round(estTokens * 100 / totalTokens) : 0, providers, daily, byModel, topConversations: top, hiddenContexts: hidden, tips,
    note: 'Counts only what was sent through AImax. Tokens are reported by the provider CLI when it gives them, otherwise estimated at ~4 characters per token. Budgets are numbers YOU set; AImax cannot see your real plan quota, usage elsewhere, or reset times.' };
}
