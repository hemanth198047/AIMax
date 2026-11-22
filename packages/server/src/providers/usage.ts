/**
 * Local usage ledger + budgets ("zero-overage" guard).
 *
 * What this is: AImax counts the requests IT sent to each provider and the characters exchanged, and lets the user
 * set soft limits (requests per hour / per day). When a limit is reached AImax stops calling that provider
 * (and, in `auto` mode, falls back to another one). When a provider reports a rate/usage limit, AImax pauses it for a while.
 *
 * What this is NOT: it cannot see your real Claude/Cursor/Codex plan quota, usage made outside AImax, or reset times.
 * Limits are whatever the user configures here.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';

/** Requests per hour/day, and TOKEN budgets over rolling 24 h / 30 days (tokens are reported by the CLI when available, otherwise estimated). */
export interface Limit { per_hour?: number; per_day?: number; per_day_tokens?: number; per_month_tokens?: number }
export type Limits = Record<string, Limit>;

export function getSetting<T>(key: string, fallback: T): T {
  const r = getDb().prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
  if (!r) return fallback;
  try { return JSON.parse(r.value) as T; } catch { return fallback; }
}
export function setSetting(key: string, value: unknown): void {
  getDb().prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
}

export const getLimits = (): Limits => getSetting<Limits>('provider_limits', {});
export function sanitizeLimits(input: unknown): Limits {
  const out: Limits = {};
  if (!input || typeof input !== 'object') return out;
  for (const [prov, l] of Object.entries(input as Record<string, unknown>)) {
    if (!/^[a-z0-9_-]{1,30}$/.test(prov) || !l || typeof l !== 'object') continue;
    const o: Limit = {};
    for (const k of ['per_hour', 'per_day', 'per_day_tokens', 'per_month_tokens'] as const) {
      const v = (l as Record<string, unknown>)[k];
      if (v === null || v === undefined || v === '') continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > (k.endsWith('tokens') ? 1_000_000_000 : 1_000_000)) throw new Error(`${prov}.${k} must be a number between 0 and ${k.endsWith('tokens') ? '1000000000' : '1000000'}`);
      o[k] = Math.floor(n);
    }
    if (Object.keys(o).length) out[prov] = o;
  }
  return out;
}

export interface UsageEvent { reported?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; costUsd?: number }; provider: string; model?: string; conversationId?: string | null; projectId?: string | null; inputChars?: number; outputChars?: number; durationMs?: number; ok: boolean; error?: string }
export function recordUsage(e: UsageEvent, now = new Date()): void {
  getDb().prepare('INSERT INTO usage_events(id,ts,provider,model,conversation_id,project_id,input_chars,output_chars,duration_ms,ok,error,reported_in,reported_out,reported_cache_read,reported_cost) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(), now.toISOString(), e.provider, e.model ?? '', e.conversationId ?? null, e.projectId ?? null, e.inputChars ?? 0, e.outputChars ?? 0, e.durationMs ?? 0, e.ok ? 1 : 0, (e.error ?? '').slice(0, 300), e.reported?.inputTokens ?? null, e.reported?.outputTokens ?? null, e.reported?.cacheReadTokens ?? null, e.reported?.costUsd ?? null);
}

export function usageCounts(provider: string, now = new Date()): { hour: number; day: number } {
  const q = (ms: number) => (getDb().prepare('SELECT COUNT(*) n FROM usage_events WHERE provider=? AND ts>=?').get(provider, new Date(now.getTime() - ms).toISOString()) as { n: number }).n;
  return { hour: q(3600_000), day: q(86_400_000) };
}

/** SQL for one event's tokens: what the CLI reported (input+output) if it did, otherwise ~4 characters per token. An ESTIMATE. */
export const TOKENS_SQL = `(CASE WHEN reported_in IS NOT NULL OR reported_out IS NOT NULL THEN COALESCE(reported_in,0)+COALESCE(reported_out,0) ELSE (input_chars+output_chars+3)/4 END)`;
export function tokensSince(provider: string, ms: number, now = new Date()): number {
  return (getDb().prepare(`SELECT COALESCE(SUM(${TOKENS_SQL}),0) n FROM usage_events WHERE provider=? AND ts>=?`).get(provider, new Date(now.getTime() - ms).toISOString()) as { n: number }).n;
}

export function looksRateLimited(msg: string): boolean {
  return /rate.?limit|usage limit|limit reached|too many requests|\b429\b|quota|overloaded|credit balance/i.test(msg);
}
export function setCooldown(provider: string, minutes: number, reason: string, now = new Date()): void {
  setSetting(`cooldown:${provider}`, { until: new Date(now.getTime() + minutes * 60_000).toISOString(), reason: reason.slice(0, 200) });
}
export function activeCooldown(provider: string, now = new Date()): { until: string; reason: string } | null {
  const c = getSetting<{ until: string; reason: string } | null>(`cooldown:${provider}`, null);
  return c && new Date(c.until) > now ? c : null;
}
export const clearCooldown = (provider: string) => getDb().prepare('DELETE FROM settings WHERE key=?').run(`cooldown:${provider}`);

/** May we call this provider right now? Local providers are only subject to limits the user explicitly sets. */
export function budgetCheck(provider: string, now = new Date()): { ok: true } | { ok: false; reason: string } {
  const cd = activeCooldown(provider, now);
  if (cd) return { ok: false, reason: `${provider} is paused until ${cd.until} (${cd.reason})` };
  const lim = getLimits()[provider]; if (!lim) return { ok: true };
  const used = usageCounts(provider, now);
  if (lim.per_hour !== undefined && used.hour >= lim.per_hour) return { ok: false, reason: `${provider} hourly limit reached (${used.hour}/${lim.per_hour}) — set in AImax` };
  if (lim.per_day !== undefined && used.day >= lim.per_day) return { ok: false, reason: `${provider} daily limit reached (${used.day}/${lim.per_day}) — set in AImax` };
  if (lim.per_day_tokens !== undefined) { const t = tokensSince(provider, 86_400_000, now); if (t >= lim.per_day_tokens) return { ok: false, reason: `${provider} 24-hour token budget reached (~${t}/${lim.per_day_tokens}) — set in AImax` }; }
  if (lim.per_month_tokens !== undefined) { const t = tokensSince(provider, 30 * 86_400_000, now); if (t >= lim.per_month_tokens) return { ok: false, reason: `${provider} 30-day token budget reached (~${t}/${lim.per_month_tokens}) — set in AImax` }; }
  return { ok: true };
}
