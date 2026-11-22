import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Square, Play, Upload, Undo2 } from 'lucide-react';
import { apiFetch } from '../api/client';
import { DiffLines } from './EditProposal';

interface Changes { promotable: boolean; reason: string; files: string[]; patch: string; truncated?: boolean; promotions?: { id: string; applied_at: string; files: string; undone_at: string | null }[] }
interface Line { kind: 'tool' | 'text' | 'info' | 'error'; text: string }

/** CLI coding agent that edits the sandbox COPY, plus the review/apply-to-project step. */
export default function AgentPanel({ sandboxId, editable, onChanged }: { sandboxId: string; editable: boolean; onChanged: () => void }) {
  const [task, setTask] = useState('');
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [changes, setChanges] = useState<Changes | null>(null);
  const [adapters, setAdapters] = useState<{ id: string; label: string; available: boolean }[]>([]);
  const [msg, setMsg] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const loadChanges = useCallback(() => { apiFetch<Changes>(`/api/sandbox/${sandboxId}/changes`).then(setChanges).catch(() => setChanges(null)); }, [sandboxId]);
  useEffect(() => { setLines([]); setMsg(''); loadChanges(); }, [sandboxId, loadChanges]);
  useEffect(() => { apiFetch<typeof adapters>('/api/agent/adapters').then(setAdapters).catch(() => undefined); }, []);

  const add = (l: Line) => setLines(x => [...x, l]);
  const run = async () => {
    if (!task.trim() || running) return;
    setRunning(true); setLines([]); setMsg('');
    const ctrl = new AbortController(); abortRef.current = ctrl;
    try {
      const res = await fetch('/api/agent/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal, body: JSON.stringify({ sandboxId, task, provider: 'claude' }) });
      if (!res.ok || !res.body) { const j = await res.json().catch(() => ({} as { error?: string })); add({ kind: 'error', text: j.error ?? `HTTP ${res.status}` }); return; }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1]; const data = /^data: (.+)$/m.exec(block)?.[1]; if (!ev || !data) continue;
          const d = JSON.parse(data);
          if (ev === 'start') add({ kind: 'info', text: `Checkpoint saved before the run (${String(d.checkpoint).slice(0, 7)}) — restore it from Changes to undo everything the agent did.` });
          else if (ev === 'tool') add({ kind: 'tool', text: `${d.name} ${d.target}` });
          else if (ev === 'chunk') setLines(x => { const last = x[x.length - 1]; return last?.kind === 'text' ? [...x.slice(0, -1), { kind: 'text', text: last.text + d.text }] : [...x, { kind: 'text', text: String(d.text) }]; });
          else if (ev === 'activity') add({ kind: 'info', text: d.detail });
          else if (ev === 'error') add({ kind: 'error', text: d.message });
          else if (ev === 'done') add({ kind: 'info', text: `${d.stopped ? 'Stopped' : d.error ? 'Failed' : 'Finished'} · ${d.tools} tool calls · ${d.files.length} changed file(s) · ${(d.durationMs / 1000).toFixed(1)}s` });
        }
      }
    } catch (e) { if ((e as Error).name !== 'AbortError') add({ kind: 'error', text: (e as Error).message }); }
    finally { setRunning(false); abortRef.current = null; loadChanges(); onChanged(); }
  };

  const promote = async () => {
    if (!changes?.files.length) return;
    if (!window.confirm(`Apply ${changes.files.length} changed file(s) to your REAL project?\n\n${changes.files.slice(0, 15).join('\n')}\n\nYou can undo this afterwards.`)) return;
    try { const r = await apiFetch<{ files: string[] }>(`/api/sandbox/${sandboxId}/promote`, { method: 'POST', body: JSON.stringify({ confirm: true }) }); setMsg(`Applied ${r.files.length} file(s) to your project.`); }
    catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    loadChanges();
  };
  const undo = async (id: string) => {
    try { await apiFetch(`/api/sandbox/${sandboxId}/promotions/${id}/undo`, { method: 'POST' }); setMsg('Undone: your project is back to how it was.'); }
    catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    loadChanges();
  };

  const claude = adapters.find(a => a.id === 'claude');
  return (
    <div className="flex-1 flex min-h-0" data-testid="agent-panel">
      <div className="w-1/2 border-r border-slate-700/50 flex flex-col min-h-0 p-2 gap-1.5">
        <div className="text-[10px] text-slate-600 flex items-center gap-1"><Bot size={10} /> Agent (edits this sandbox copy, never your project)</div>
        {!editable ? <div className="text-[11px] text-yellow-600">Agents work only in temporary or container sandboxes.</div> : claude && !claude.available ? <div className="text-[11px] text-yellow-600">Claude Code CLI not found.</div> : null}
        <textarea value={task} onChange={e => setTask(e.target.value)} aria-label="Agent task" rows={3} disabled={!editable || running}
          placeholder="Describe the change, e.g. “Add input validation to src/api.ts”" className="bg-slate-800 border border-slate-700 rounded p-1.5 text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none resize-none" />
        <div className="flex gap-2 items-center">
          {running
            ? <button onClick={() => abortRef.current?.abort()} className="flex items-center gap-1 px-2 py-1 rounded bg-red-600/80 text-[11px] text-white"><Square size={10} /> Stop</button>
            : <button onClick={run} disabled={!editable || !task.trim() || claude?.available === false} className="flex items-center gap-1 px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-[11px] text-white"><Play size={10} /> Run Claude agent</button>}
          <span className="text-[9px] text-slate-700">Cursor / Codex agents: not available yet</span>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin text-[11px] font-mono space-y-0.5" data-testid="agent-log">
          {lines.map((l, i) => <div key={i} className={l.kind === 'tool' ? 'text-cyan-400' : l.kind === 'error' ? 'text-red-400' : l.kind === 'info' ? 'text-slate-500' : 'text-slate-300 whitespace-pre-wrap'}>{l.kind === 'tool' ? '🔧 ' : ''}{l.text}</div>)}
        </div>
      </div>
      <div className="w-1/2 flex flex-col min-h-0 p-2 gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-600">Review &amp; apply to your project{changes ? ` (${changes.files.length} file${changes.files.length === 1 ? '' : 's'})` : ''}</span>
          <button onClick={promote} disabled={!changes?.promotable || !changes.files.length} data-testid="promote" className="ml-auto flex items-center gap-1 px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-[11px] text-white"><Upload size={10} /> Apply to my project</button>
        </div>
        {msg && <div className="text-[11px] text-slate-300" data-testid="promote-msg">{msg}</div>}
        {changes && !changes.promotable && <div className="text-[11px] text-yellow-600">{changes.reason}</div>}
        <div className="flex-1 overflow-auto scrollbar-thin bg-slate-950/50 rounded">
          {changes?.files.length ? <DiffLines diff={changes.patch} /> : <div className="text-[11px] text-slate-700 p-2">No changes in this sandbox.</div>}
        </div>
        {changes?.promotions?.filter(p => !p.undone_at).slice(0, 3).map(p => (
          <div key={p.id} className="flex items-center gap-2 text-[10px] text-slate-500">Applied {new Date(p.applied_at).toLocaleTimeString()} · {(JSON.parse(p.files) as string[]).length} file(s)
            <button onClick={() => undo(p.id)} className="flex items-center gap-1 text-slate-400 hover:text-slate-200 underline"><Undo2 size={9} /> undo</button></div>))}
      </div>
    </div>
  );
}
