import React, { useEffect, useState } from 'react';
import { FilePen, Check, X } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { apiFetch } from '../api/client';

interface Prev { path: string; kind: 'create' | 'modify'; ok: boolean; error?: string; diff: string }
interface Preview { ok: boolean; edits: Prev[]; error?: string }

export const DiffLines = ({ diff }: { diff: string }) => (
  <pre className="text-[11px] leading-snug font-mono overflow-x-auto px-3 py-2">{diff.split('\n').map((l, i) =>
    <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'text-green-400' : l.startsWith('-') && !l.startsWith('---') ? 'text-red-400' : l.startsWith('@@') ? 'text-cyan-400' : 'text-slate-500'}>{l || ' '}</div>)}</pre>
);

/** File edits the AI *proposed*. The diff is computed from the real sandbox files; nothing is written until you approve. */
export default function EditProposal({ edits }: { edits: string }) {
  const sandboxId = useAppStore(s => s.activeSandboxId);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [phase, setPhase] = useState<'idle' | 'applying' | 'applied' | 'dismissed'>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    setPreview(null); setError('');
    if (!sandboxId) return;
    apiFetch<Preview>(`/api/sandbox/${sandboxId}/edits/preview`, { method: 'POST', body: JSON.stringify({ edits }) })
      .then(setPreview).catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [sandboxId, edits]);

  if (phase === 'dismissed') return <div className="text-[11px] text-slate-600 italic my-2">Edit proposal dismissed (nothing changed).</div>;

  const apply = async () => {
    if (!sandboxId) return;
    setPhase('applying'); setError('');
    try { await apiFetch(`/api/sandbox/${sandboxId}/edits/apply`, { method: 'POST', body: JSON.stringify({ edits }) }); setPhase('applied'); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setPhase('idle'); }
  };

  return (
    <div className="my-2 border border-emerald-500/30 bg-slate-900 rounded-lg overflow-hidden" data-testid="edit-proposal">
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600/10 text-[11px] text-emerald-300">
        <FilePen size={11} /> Proposed file changes — written to your sandbox copy only after you approve
      </div>
      {!sandboxId && <div className="px-3 py-2 text-[11px] text-yellow-600">Select or create a sandbox to review this change.</div>}
      {error && <div className="px-3 py-2 text-[11px] text-red-400">{error}</div>}
      {preview?.error && <div className="px-3 py-2 text-[11px] text-red-400">{preview.error}</div>}
      {preview?.edits.map((e, i) => (
        <div key={i} className="border-t border-slate-800">
          <div className="px-3 pt-1.5 text-[11px] text-slate-300 flex items-center gap-2">
            <span className="font-mono">{e.path}</span><span className="text-slate-600">{e.kind === 'create' ? 'new file' : 'modify'}</span>
            {!e.ok && <span className="text-red-400" data-testid="edit-error">✕ {e.error}</span>}
          </div>
          {e.diff && <DiffLines diff={e.diff} />}
        </div>
      ))}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-slate-800">
        {phase === 'applied'
          ? <span className="flex items-center gap-1 text-[11px] text-emerald-400" data-testid="edit-applied"><Check size={11} /> Applied to the sandbox (a checkpoint was saved first). Review under Agent → Review & apply.</span>
          : <button onClick={apply} disabled={!sandboxId || !preview?.ok || phase === 'applying'}
              className="flex items-center gap-1 px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-[11px] text-white">
              <Check size={10} /> Apply to sandbox
            </button>}
        {phase === 'idle' && <button onClick={() => setPhase('dismissed')} className="flex items-center gap-1 px-2 py-1 text-[11px] text-slate-500 hover:text-slate-300"><X size={10} /> Dismiss</button>}
      </div>
    </div>
  );
}
