import React, { useEffect, useState } from 'react';
import { X, BarChart3 } from 'lucide-react';
import { apiFetch } from '../api/client';
import { ctxQs } from '../api/conversations';

interface Prov { provider: string; requests: number; failed: number; tokens: number; inputTokens: number; outputTokens: number; reportedRequests: number; cacheReadTokens: number; costUsd: number | null;
  avgInputTokens: number; last24h: number; last30d: number; paused: { until: string; reason: string } | null;
  budget: { per_day_tokens?: number; per_month_tokens?: number; remaining_24h?: number; remaining_30d?: number; used_pct_24h?: number; used_pct_30d?: number } }
interface Report { generatedAt: string; days: number; note: string; totalTokens: number; estimatedShare: number; providers: Prov[]; daily: { day: string; tokens: number; requests: number }[];
  byModel: { provider: string; model: string; requests: number; tokens: number }[]; topConversations: { id: string; title: string; requests: number; tokens: number; avgInputTokens: number }[];
  hiddenContexts: { conversations: number; tokens: number }; tips: { id: string; level: 'info' | 'warn'; title: string; detail: string }[] }

const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

function Bar({ pct, label, testid }: { pct: number; label: string; testid?: string }) {
  const c = pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-500' : 'bg-emerald-500';
  return (
    <div data-testid={testid}>
      <div className="h-2 bg-slate-800 rounded overflow-hidden"><div className={`h-full ${c}`} style={{ width: `${Math.min(100, pct)}%` }} /></div>
      <div className="text-[10px] text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}

/** Token usage report: used / remaining against budgets the user set, trend, biggest consumers, and suggestions. */
export default function UsageReport({ onClose }: { onClose: () => void }) {
  const [days, setDays] = useState(30);
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setErr('');
    const q = ctxQs(); apiFetch<Report>(`/api/usage/report${q}${q ? '&' : '?'}days=${days}`).then(setR).catch(e => setErr(e instanceof Error ? e.message : String(e)));
  }, [days]);
  const max = Math.max(1, ...(r?.daily.map(d => d.tokens) ?? [1]));

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" data-testid="usage-report">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-3xl max-h-[88vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <h2 className="text-sm font-semibold flex items-center gap-2"><BarChart3 size={14} /> Token usage report</h2>
          <div className="flex items-center gap-2">
            <select value={days} onChange={e => setDays(Number(e.target.value))} aria-label="Report period" className="bg-slate-800 border border-slate-700 rounded text-xs px-1 py-0.5">
              {[7, 30, 90].map(d => <option key={d} value={d}>Last {d} days</option>)}
            </select>
            <button onClick={onClose} aria-label="Close report" className="text-slate-500 hover:text-slate-200"><X size={16} /></button>
          </div>
        </div>
        <div className="px-4 py-3 space-y-4 overflow-y-auto text-xs">
          {err && <div className="text-red-400">{err}</div>}
          {!r && !err && <div className="text-slate-500">Loading…</div>}
          {r && (<>
            <div className="text-slate-500" data-testid="report-note">{r.note}{r.estimatedShare > 0 ? ` About ${r.estimatedShare}% of the numbers below are estimates.` : ''}</div>
            <div className="text-slate-300">Total: <b data-testid="report-total">~{fmt(r.totalTokens)}</b> tokens in {r.days} days</div>

            <div className="grid gap-3 sm:grid-cols-2">
              {r.providers.map(p => (
                <div key={p.provider} className="border border-slate-800 rounded-lg p-3 space-y-2" data-testid={`report-provider-${p.provider}`}>
                  <div className="flex justify-between"><b className="capitalize text-slate-200">{p.provider}</b><span className="text-slate-500">{p.requests} requests{p.failed ? ` · ${p.failed} failed` : ''}</span></div>
                  <div className="text-slate-400">Used ~{fmt(p.tokens)} (in {fmt(p.inputTokens)} · out {fmt(p.outputTokens)}){p.costUsd !== null ? ` · reported cost $${p.costUsd}` : ''}</div>
                  {p.cacheReadTokens > 0 && <div className="text-slate-600">Plus {fmt(p.cacheReadTokens)} cached-context tokens (not counted above)</div>}
                  <div className="text-slate-600">{p.reportedRequests} of {p.requests} requests had provider-reported counts; the rest are estimated.</div>
                  {p.budget.per_day_tokens !== undefined
                    ? <Bar testid={`bar24-${p.provider}`} pct={p.budget.used_pct_24h ?? 0} label={`24 h: ~${fmt(p.last24h)} used of ${fmt(p.budget.per_day_tokens)} · ${fmt(p.budget.remaining_24h ?? 0)} remaining`} />
                    : <div className="text-slate-600">24 h: ~{fmt(p.last24h)} used · no budget set</div>}
                  {p.budget.per_month_tokens !== undefined
                    ? <Bar testid={`bar30-${p.provider}`} pct={p.budget.used_pct_30d ?? 0} label={`30 days: ~${fmt(p.last30d)} used of ${fmt(p.budget.per_month_tokens)} · ${fmt(p.budget.remaining_30d ?? 0)} remaining`} />
                    : <div className="text-slate-600">30 days: ~{fmt(p.last30d)} used · no budget set</div>}
                  {p.paused && <div className="text-yellow-500">Paused until {new Date(p.paused.until).toLocaleTimeString()}</div>}
                </div>
              ))}
              {r.providers.length === 0 && <div className="text-slate-600">No usage recorded yet.</div>}
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wider text-slate-600 mb-1">Tokens per day</div>
              <div className="flex items-end gap-px h-16" data-testid="report-daily">
                {r.daily.map(d => <div key={d.day} title={`${d.day}: ~${fmt(d.tokens)} tokens, ${d.requests} requests`} className="flex-1 bg-indigo-500/70 min-h-[1px]" style={{ height: `${Math.max(2, d.tokens * 100 / max)}%` }} />)}
              </div>
            </div>

            {r.topConversations.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-600 mb-1">Biggest conversations (this project/person context)</div>
                <table className="w-full text-left"><tbody>
                  {r.topConversations.map(c => (
                    <tr key={c.id} className="border-t border-slate-800"><td className="py-1 pr-2 truncate max-w-[18rem] text-slate-300">{c.title}</td>
                      <td className="text-slate-500 whitespace-nowrap">{c.requests} req</td><td className="text-slate-500 whitespace-nowrap px-2">~{fmt(c.avgInputTokens)} in/req</td><td className="text-slate-300 text-right whitespace-nowrap">~{fmt(c.tokens)}</td></tr>
                  ))}
                </tbody></table>
                {r.hiddenContexts.conversations > 0 && <div className="text-slate-600 mt-1">{r.hiddenContexts.conversations} more conversation(s) in other projects/people (~{fmt(r.hiddenContexts.tokens)} tokens) are not named here.</div>}
              </div>
            )}

            <div data-testid="report-tips">
              <div className="text-[10px] uppercase tracking-wider text-slate-600 mb-1">Ways to improve</div>
              {r.tips.length === 0 && <div className="text-slate-600">Nothing stands out yet. Suggestions appear once there is enough usage to base them on.</div>}
              {r.tips.map(t => (
                <div key={t.id} className={`border-l-2 pl-2 mb-2 ${t.level === 'warn' ? 'border-yellow-500' : 'border-slate-600'}`}>
                  <div className="text-slate-200">{t.title}</div><div className="text-slate-500">{t.detail}</div>
                </div>
              ))}
            </div>
          </>)}
        </div>
      </div>
    </div>
  );
}
