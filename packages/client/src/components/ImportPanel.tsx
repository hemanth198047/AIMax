import React, { useEffect, useRef, useState } from 'react';
import { X, Download } from 'lucide-react';
import { apiFetch } from '../api/client';
import { loadConversations } from '../api/conversations';
import { useAppStore } from '../stores/appStore';

type Source = 'claude-code' | 'cursor' | 'file';
interface SourceInfo { id: Source; label: string; defaultDir: string; exists: boolean }
interface Item { id: string; title: string; messages: number; updatedAt: string; project: string; imported: boolean }
interface ScanResult { dir?: string; items: Item[]; diagnostics: string[]; importId?: string; filename?: string }
interface Preview { title: string; messages: number; truncated: boolean; sample: { role: string; content: string }[]; redactionsInSample: number }
interface RunResult { id: string; title?: string; status: 'imported' | 'skipped' | 'error'; conversationId?: string; reason?: string; redactions?: number; messages?: number }

const TABS: { id: Source; label: string }[] = [{ id: 'claude-code', label: 'Claude Code' }, { id: 'cursor', label: 'Cursor' }, { id: 'file', label: 'Exported file' }];

/** Bring earlier chats (read from local files only) into AImax so the work can be continued here. */
export default function ImportPanel({ onClose }: { onClose: () => void }) {
  const { activeProjectId, activePersonId, projects, people, setActiveConversation } = useAppStore();
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [tab, setTab] = useState<Source>('claude-code');
  const [dir, setDir] = useState('');
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [useCtx, setUseCtx] = useState(true);
  const [redact, setRedact] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [results, setResults] = useState<RunResult[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { apiFetch<SourceInfo[]>('/api/import/sources').then(setSources).catch(() => undefined); }, []);
  const info = sources.find(s => s.id === tab);
  const reset = () => { setScan(null); setPicked(new Set()); setPreview(null); setResults(null); setErr(''); };
  const switchTab = (t: Source) => { setTab(t); setDir(''); reset(); };

  const doScan = async () => {
    reset(); setBusy(true);
    try { setScan(await apiFetch<ScanResult>('/api/import/scan', { method: 'POST', body: JSON.stringify({ source: tab, dir: dir.trim() || undefined }) })); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const doUpload = async (file: File) => {
    reset(); setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const res = await fetch('/api/import/file', { method: 'POST', body: fd });
      const body = await res.json().catch(() => ({ error: res.statusText }));
      if (!res.ok) throw new Error(body.error || res.statusText);
      setScan(body as ScanResult); setPicked(new Set((body as ScanResult).items.filter(i => !i.imported).map(i => i.id)));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const baseBody = () => ({ source: tab, dir: tab === 'file' ? undefined : (scan?.dir || dir.trim() || undefined), importId: scan?.importId });
  const doPreview = async (id: string) => {
    setErr(''); setPreview(null);
    try { setPreview(await apiFetch<Preview>('/api/import/preview', { method: 'POST', body: JSON.stringify({ ...baseBody(), id, redact }) })); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const doRun = async () => {
    setBusy(true); setErr('');
    try {
      const r = await apiFetch<{ results: RunResult[] }>('/api/import/run', { method: 'POST', body: JSON.stringify({
        ...baseBody(), ids: [...picked], redact, project_id: useCtx ? activeProjectId : null, person_id: useCtx ? activePersonId : null }) });
      setResults(r.results); await loadConversations();
      if (scan) setScan({ ...scan, items: scan.items.map(i => r.results.some(x => x.id === i.id && x.status !== 'error') ? { ...i, imported: true } : i) });
      setPicked(new Set());
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const toggle = (id: string) => setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const ctxName = [activeProjectId && projects.find(p => p.id === activeProjectId)?.name, activePersonId && people.find(p => p.id === activePersonId)?.display_name].filter(Boolean).join(' + ');

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" data-testid="import-panel">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-3xl max-h-[88vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <h2 className="text-sm font-semibold flex items-center gap-2"><Download size={14} /> Import earlier chats</h2>
          <button onClick={onClose} aria-label="Close" className="text-slate-500 hover:text-slate-200"><X size={16} /></button>
        </div>
        <div className="flex gap-1 px-4 pt-3">
          {TABS.map(t => (
            <button key={t.id} onClick={() => switchTab(t.id)} data-testid={`import-tab-${t.id}`}
              className={`px-3 py-1 text-xs rounded-md ${tab === t.id ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}>{t.label}</button>
          ))}
        </div>
        <div className="px-4 py-3 space-y-3 overflow-y-auto text-xs">
          <p className="text-slate-500">Reads local files only; nothing is sent anywhere. Imported chats are stored as plain history (not as instructions) and you can continue them here.</p>
          {tab === 'file' ? (
            <div className="flex items-center gap-2">
              <input ref={fileRef} type="file" accept=".json,.jsonl,.md,.markdown,.txt" data-testid="import-file"
                onChange={e => { const f = e.target.files?.[0]; if (f) void doUpload(f); }} className="text-slate-400" />
              <span className="text-slate-600">OpenAI-style JSON/JSONL, ChatGPT or Claude.ai export, or a “User: / Assistant:” transcript.</span>
            </div>
          ) : (
            <div className="space-y-1">
              <div className="flex gap-2">
                <input value={dir} onChange={e => setDir(e.target.value)} data-testid="import-dir" placeholder={info?.defaultDir || 'Folder path'}
                  className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-200" />
                <button onClick={doScan} disabled={busy} data-testid="import-scan" className="px-3 py-1 rounded bg-indigo-600 text-white disabled:opacity-50">Scan</button>
              </div>
              <div className="text-slate-600">{info ? (info.exists ? `Default folder found: ${info.defaultDir}` : `Default folder not found on this machine: ${info.defaultDir} — enter another path if yours differs.`) : ''}</div>
            </div>
          )}
          {err && <div className="text-red-400" data-testid="import-error">{err}</div>}
          {scan?.diagnostics.map((d, i) => <div key={i} className="text-slate-500" data-testid="import-diagnostic">{d}</div>)}
          {scan && scan.items.length > 0 && (
            <div className="border border-slate-800 rounded-lg divide-y divide-slate-800 max-h-56 overflow-y-auto" data-testid="import-list">
              {scan.items.map(i => (
                <label key={i.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-800/50 cursor-pointer">
                  <input type="checkbox" checked={picked.has(i.id)} disabled={i.imported} onChange={() => toggle(i.id)} data-testid="import-item-check" />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-slate-200">{i.title}</span>
                    <span className="block truncate text-slate-600">{i.messages} messages · {i.updatedAt.slice(0, 10)}{i.project ? ` · ${i.project}` : ''}</span>
                  </span>
                  {i.imported && <span className="text-emerald-500">already imported</span>}
                  <button type="button" onClick={e => { e.preventDefault(); void doPreview(i.id); }} className="text-indigo-400 hover:underline">preview</button>
                </label>
              ))}
            </div>
          )}
          {preview && (
            <div className="border border-slate-800 rounded-lg p-2 space-y-1" data-testid="import-preview">
              <div className="text-slate-300">{preview.title} · {preview.messages} messages{preview.truncated ? ' (truncated to the import limit)' : ''}{preview.redactionsInSample ? ` · ${preview.redactionsInSample} secret(s) masked in this sample` : ''}</div>
              {preview.sample.map((m, i) => <div key={i} className="text-slate-500"><b className="text-slate-400">{m.role}:</b> {m.content}</div>)}
            </div>
          )}
          {scan && scan.items.length > 0 && (
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-slate-400">
                <input type="radio" checked={useCtx} onChange={() => setUseCtx(true)} data-testid="import-dest-ctx" />
                Into the current context: {ctxName || 'Global (no project / person)'}
              </label>
              {(activeProjectId || activePersonId) && (
                <label className="flex items-center gap-2 text-slate-400"><input type="radio" checked={!useCtx} onChange={() => setUseCtx(false)} /> As global conversations</label>
              )}
              <label className="flex items-center gap-2 text-slate-400"><input type="checkbox" checked={redact} onChange={e => setRedact(e.target.checked)} data-testid="import-redact" /> Mask API keys, tokens and passwords (best effort, not a guarantee)</label>
              <button onClick={doRun} disabled={busy || !picked.size} data-testid="import-run" className="px-3 py-1.5 rounded bg-emerald-600 text-white disabled:opacity-50">Import {picked.size} selected</button>
            </div>
          )}
          {results && (
            <div className="space-y-1" data-testid="import-results">
              {results.map(r => (
                <div key={r.id} className={r.status === 'error' ? 'text-red-400' : 'text-slate-300'}>
                  {r.status === 'imported' ? '✓' : r.status === 'skipped' ? '↷' : '✗'} {r.title ?? r.id} — {r.status}{r.reason ? `: ${r.reason}` : ''}{r.redactions ? ` · ${r.redactions} secret(s) masked` : ''}
                  {r.conversationId && <button className="ml-2 text-indigo-400 hover:underline" data-testid="import-open"
                    onClick={() => { setActiveConversation(r.conversationId!); onClose(); }}>open</button>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
