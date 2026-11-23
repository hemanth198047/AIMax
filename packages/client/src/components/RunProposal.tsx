import React, { useRef, useState } from 'react';
import { Play, Square, X, TerminalSquare } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { streamRun, cancelRun } from '../api/sandboxRun';

type Phase = 'idle' | 'running' | 'done' | 'dismissed';

/** A command the AI *proposed*. Nothing runs until the user approves it here, and it runs only in the selected sandbox. */
export default function RunProposal({ command }: { command: string }) {
  const activeSandboxId = useAppStore(s => s.activeSandboxId);
  const [phase, setPhase] = useState<Phase>('idle');
  const [lines, setLines] = useState<{ t: string; err: boolean }[]>([]);
  const [result, setResult] = useState<string>('');
  const [error, setError] = useState('');
  const runRef = useRef<string | null>(null);

  if (phase === 'dismissed') return <div className="text-[11px] text-slate-600 italic my-2">Command dismissed (not run).</div>;

  const run = async (confirm = false) => {
    if (!activeSandboxId) return;
    setPhase('running'); setError(''); if (!confirm) { setLines([]); setResult(''); }
    const r = await streamRun(activeSandboxId, command, {
      onInfo: i => setLines(l => [...l, { t: `running in ${i.cwd} with ${i.shell}`, err: false }]),
      onStart: id => { runRef.current = id; },
      onChunk: (t, s) => setLines(l => [...l, ...t.split('\n').filter(x => x.length).map(x => ({ t: x, err: s === 'stderr' }))]),
      onDone: d => setResult(`exit ${d.exitCode} · ${d.durationMs}ms${d.status !== 'done' ? ' · ' + d.status : ''}${d.truncated ? ' · output truncated' : ''}`),
    }, { confirm });
    runRef.current = null;
    if (!r.ok) {
      if (r.needsConfirmation && window.confirm(`${r.message}\n\nRun anyway?\n\n${command}`)) return run(true);
      setError(r.message); setPhase('idle'); return;
    }
    setPhase('done');
  };

  return (
    <div className="my-2 border border-indigo-500/30 bg-slate-900 rounded-lg overflow-hidden" data-testid="run-proposal">
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600/10 text-[11px] text-indigo-300">
        <TerminalSquare size={11} /> Proposed command — runs in your sandbox only after you approve
      </div>
      <pre className="px-3 py-2 text-xs font-mono text-slate-200 whitespace-pre-wrap">{command}</pre>
      <div className="flex items-center gap-2 px-3 pb-2">
        {phase === 'running'
          ? <button onClick={() => runRef.current && cancelRun(runRef.current)} className="flex items-center gap-1 px-2 py-1 rounded bg-red-600/80 text-[11px] text-white"><Square size={10} /> Stop</button>
          : <button onClick={() => run()} disabled={!activeSandboxId}
              title={activeSandboxId ? 'Run in the selected sandbox' : 'Select or create a sandbox first'}
              className="flex items-center gap-1 px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-[11px] text-white">
              <Play size={10} /> {phase === 'done' ? 'Run again' : 'Run in sandbox'}
            </button>}
        {phase === 'idle' && <button onClick={() => setPhase('dismissed')} className="flex items-center gap-1 px-2 py-1 text-[11px] text-slate-500 hover:text-slate-300"><X size={10} /> Dismiss</button>}
        {!activeSandboxId && <span className="text-[11px] text-yellow-600">No sandbox selected</span>}
        {error && <span className="text-[11px] text-red-400">{error}</span>}
      </div>
      {(lines.length > 0 || result) && (
        <pre data-testid="run-proposal-output" className="px-3 py-2 border-t border-slate-800 text-[11px] font-mono max-h-48 overflow-auto">
          {lines.map((l, i) => <div key={i} className={l.err ? 'text-yellow-500/80' : 'text-slate-300'}>{l.t}</div>)}
          {result && <div className="text-slate-500 mt-1">{result}</div>}
        </pre>
      )}
    </div>
  );
}
