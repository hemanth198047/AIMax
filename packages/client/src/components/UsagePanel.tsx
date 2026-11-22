import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api/client';
import UsageReport from './UsageReport';

interface Row { provider: string; hour: number; day: number; limit: { per_hour?: number; per_day?: number } | null; paused: { until: string; reason: string } | null }
interface Usage { providers: Row[]; note: string }
type Lim = { per_hour?: number; per_day?: number; per_day_tokens?: number; per_month_tokens?: number };
interface Settings { limits: Record<string, Lim>; ollama_model: string }

const SHOWN = ['claude', 'ollama'];

/** Local usage ledger + soft limits. Counts only what AImax sent; it cannot see the real plan quota. */
export default function UsagePanel({ ollamaModels, ollamaSelected, onModelChange }: { ollamaModels: string[]; ollamaSelected: string; onModelChange: () => void }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [err, setErr] = useState('');
  const [showReport, setShowReport] = useState(false);

  const load = useCallback(() => {
    Promise.all([apiFetch<Usage>('/api/usage'), apiFetch<Settings>('/api/settings/providers')])
      .then(([u, s]) => { setUsage(u); setSettings(s); }).catch(() => undefined);
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  const save = async (body: object) => {
    setErr('');
    try { setSettings(await apiFetch<Settings>('/api/settings/providers', { method: 'PUT', body: JSON.stringify(body) })); load(); onModelChange(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const setLimit = (prov: string, key: keyof Lim, raw: string) => {
    const limits = { ...(settings?.limits ?? {}) }; const cur = { ...(limits[prov] ?? {}) };
    if (raw.trim() === '') delete cur[key]; else cur[key] = Number(raw);
    limits[prov] = cur; void save({ limits });
  };

  return (
    <div className="p-3 border-b border-slate-800" data-testid="usage-panel">
      <div className="text-[10px] text-slate-600 font-medium uppercase tracking-wider mb-2">Usage &amp; limits</div>
      {SHOWN.map(p => {
        const row = usage?.providers.find(r => r.provider === p);
        return (
          <div key={p} className="mb-2">
            <div className="flex justify-between text-[11px] text-slate-400"><span className="capitalize">{p}</span><span className="text-slate-600">{row ? `${row.hour}/h · ${row.day}/day` : '…'}</span></div>
            <div className="flex gap-1 mt-0.5">
              {(['per_hour', 'per_day'] as const).map(k => (
                <input type="number" min={0} aria-label={`${p} ${k === 'per_hour' ? 'hourly' : 'daily'} limit`} placeholder={k === 'per_hour' ? 'max / hour' : 'max / day'}
                  defaultValue={settings?.limits[p]?.[k] ?? ''} key={`${p}${k}${settings?.limits[p]?.[k] ?? ""}`}
                  onBlur={e => { const cur = String(settings?.limits[p]?.[k] ?? ''); if (e.target.value !== cur) setLimit(p, k, e.target.value); }}
                  className="w-1/2 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-300 placeholder-slate-600 focus:outline-none" />
              ))}
            </div>
            <div className="flex gap-1 mt-0.5">
              {([['per_day_tokens', 'tokens / 24 h'], ['per_month_tokens', 'tokens / 30 days']] as const).map(([k, ph]) => (
                <input type="number" min={0} aria-label={`${p} ${k === 'per_day_tokens' ? 'daily' : 'monthly'} token budget`} placeholder={ph}
                  defaultValue={settings?.limits[p]?.[k] ?? ''} key={`${p}${k}${settings?.limits[p]?.[k] ?? ""}`}
                  onBlur={e => { const cur = String(settings?.limits[p]?.[k] ?? ''); if (e.target.value !== cur) setLimit(p, k, e.target.value); }}
                  className="w-1/2 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-300 placeholder-slate-600 focus:outline-none" />
              ))}
            </div>
            {row?.paused && (
              <div className="text-[10px] text-yellow-500 mt-0.5">
                Paused until {new Date(row.paused.until).toLocaleTimeString()} — {row.paused.reason.slice(0, 60)}{' '}
                <button className="underline" onClick={() => apiFetch(`/api/usage/${p}/resume`, { method: 'POST' }).then(load)}>resume</button>
              </div>
            )}
          </div>
        );
      })}
      {ollamaModels.length > 0 && (
        <label className="block text-[10px] text-slate-600">Ollama model
          <select value={ollamaSelected} onChange={e => save({ ollama_model: e.target.value })} aria-label="Ollama model"
            className="w-full mt-0.5 bg-slate-800 border border-slate-700 rounded px-1 py-1 text-[11px] text-slate-300 focus:outline-none">
            {ollamaModels.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      )}
      <button onClick={() => setShowReport(true)} data-testid="open-usage-report" className="mt-1 text-[11px] text-indigo-400 hover:underline">Full token report…</button>
      {showReport && <UsageReport onClose={() => setShowReport(false)} />}
      {err && <div className="text-[10px] text-red-400 mt-1">{err}</div>}
      <div className="text-[9px] text-slate-700 mt-1">{usage?.note ?? 'Counts only requests sent through AImax. When a limit is reached AImax stops calling that provider (auto falls back).'}</div>
    </div>
  );
}
