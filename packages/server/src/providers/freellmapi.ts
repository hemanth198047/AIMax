/**
 * FreeLLMAPI (self-hosted gateway, github.com/tashfeenahmed/freellmapi): an OpenAI-compatible proxy at http://localhost:3001/v1.
 * Documented by the project: POST /v1/chat/completions (SSE when stream:true), GET /v1/models, `Authorization: Bearer freellmapi-…`
 * (the "unified key" from ITS dashboard), model "auto" lets its router choose. NOT yet run against a real server.
 * The unified key is stored only in AImax's local settings (or AIMAX_FREELLMAPI_KEY) and is never sent to the browser.
 * Privacy: free tiers behind it may log or train on prompts, so it is used only when you pick it explicitly.
 */
import { getSetting, setSetting } from './usage.js';
import type { ChatMessage, ReportedUsage } from './claude.js';

export interface FreeCfg { url: string; key: string; model: string }
export function freeConfig(): FreeCfg {
  const s = getSetting<Partial<FreeCfg>>('freellmapi', {});
  return { url: (process.env.AIMAX_FREELLMAPI_URL || s.url || 'http://localhost:3001/v1').replace(/\/+$/, ''), key: process.env.AIMAX_FREELLMAPI_KEY || s.key || '', model: s.model || 'auto' };
}
export function saveFreeConfig(b: { url?: unknown; key?: unknown; model?: unknown }): void {
  const cur = getSetting<Partial<FreeCfg>>('freellmapi', {});
  const next: Partial<FreeCfg> = { ...cur };
  if (b.url !== undefined) {
    if (typeof b.url !== 'string' || !/^https?:\/\/[^\s]{1,200}$/.test(b.url)) throw new Error('URL must start with http:// or https://');
    next.url = b.url.replace(/\/+$/, '');
  }
  if (b.key !== undefined) { if (typeof b.key !== 'string' || b.key.length > 300) throw new Error('Invalid key'); if (b.key) next.key = b.key; else delete next.key; }
  if (b.model !== undefined) { if (typeof b.model !== 'string' || !/^[\w.:/@-]{1,100}$/.test(b.model)) throw new Error('Invalid model name'); next.model = b.model; }
  setSetting('freellmapi', next);
}

const headers = (c: FreeCfg) => ({ 'Content-Type': 'application/json', ...(c.key ? { Authorization: `Bearer ${c.key}` } : {}) });

export async function freeProbe(): Promise<{ reachable: boolean; models: string[]; error: string }> {
  const c = freeConfig();
  try {
    const r = await fetch(`${c.url}/models`, { headers: headers(c), signal: AbortSignal.timeout(3000) });
    if (r.status === 401 || r.status === 403) return { reachable: true, models: [], error: 'The server rejected the key (check the unified key in its dashboard).' };
    if (!r.ok) return { reachable: false, models: [], error: `HTTP ${r.status}` };
    const j = await r.json() as { data?: { id?: string }[] };
    return { reachable: true, models: (j.data ?? []).map((m) => String(m.id)).filter(Boolean).slice(0, 50), error: '' };
  } catch (e) { return { reachable: false, models: [], error: e instanceof Error ? e.message : String(e) }; }
}
let availCache: { at: number; key: string; ok: boolean } | null = null;
/** Cached for 10 s because the UI polls provider status every few seconds. */
export const freeAvailable = async () => {
  const c = freeConfig(); const k = `${c.url}|${c.key}`;
  if (availCache && availCache.key === k && Date.now() - availCache.at < 10_000) return availCache.ok;
  const p = await freeProbe(); availCache = { at: Date.now(), key: k, ok: p.reachable && !p.error && !!c.key }; return availCache.ok;
};

export function parseSseLine(line: string): { delta?: string; done?: boolean; usage?: ReportedUsage; error?: string } {
  if (!line.startsWith('data:')) return {};
  const d = line.slice(5).trim(); if (d === '[DONE]') return { done: true };
  let j: any; try { j = JSON.parse(d); } catch { return {}; }
  if (j?.error) return { error: String(j.error.message ?? j.error) };
  const u = j?.usage; const usage = u && typeof u.prompt_tokens === 'number' ? { inputTokens: u.prompt_tokens, outputTokens: Number(u.completion_tokens ?? 0) } : undefined;
  const delta = j?.choices?.[0]?.delta?.content;
  return { ...(typeof delta === 'string' && delta ? { delta } : {}), ...(usage ? { usage } : {}) };
}

export async function freeChat(messages: ChatMessage[], system: string, onChunk: (t: string) => void, opts: { signal?: AbortSignal } = {}): Promise<{ text: string; model: string; usage?: ReportedUsage }> {
  const c = freeConfig();
  const body = { model: c.model, stream: true, messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages.map((m) => ({ role: m.role, content: m.content }))] };
  let r: Response;
  try { r = await fetch(`${c.url}/chat/completions`, { method: 'POST', headers: headers(c), body: JSON.stringify(body), signal: opts.signal }); }
  catch (e) { if (opts.signal?.aborted) return { text: '', model: c.model }; throw new Error(`Cannot reach FreeLLMAPI at ${c.url}. Is it running? (${e instanceof Error ? e.message : String(e)})`); }
  if (r.status === 401 || r.status === 403) throw new Error('FreeLLMAPI rejected the key. Update the unified key in Settings → Local connections.');
  if (!r.ok || !r.body) throw new Error(`FreeLLMAPI returned HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = ''; let text = ''; let usage: ReportedUsage | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const p = parseSseLine(buf.slice(0, i).trim()); buf = buf.slice(i + 1);
        if (p.error) throw new Error(`FreeLLMAPI: ${p.error}`);
        if (p.delta) { text += p.delta; onChunk(p.delta); } if (p.usage) usage = p.usage;
      }
    }
  } catch (e) { if (opts.signal?.aborted) return { text, model: c.model, usage }; throw e; }
  if (!text) throw new Error('FreeLLMAPI returned no text.');
  return { text, model: c.model, usage };
}
