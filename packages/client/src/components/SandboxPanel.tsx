import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Terminal, Play, Square, Plus, Trash2, FolderOpen, File as FileIcon, ChevronDown, ChevronUp, GitBranch, Save, RotateCcw, Shield } from 'lucide-react';
import { apiFetch } from '../api/client';
import { streamRun, cancelRun } from '../api/sandboxRun';
import AgentPanel from './AgentPanel';
import type { Sandbox, SandboxMode, SandboxCapabilities, SandboxFileEntry, SandboxGit, SandboxCheckpoint } from '../api/client';
import { useAppStore } from '../stores/appStore';
import clsx from 'clsx';

interface OutputLine { text: string; type: 'stdout' | 'stderr' | 'info' | 'error'; }
type Tab = 'terminal' | 'changes' | 'files' | 'agent';

const MODE_LABEL: Record<SandboxMode, string> = {
  temporary: 'Temporary copy', readonly: 'Read-only', container: 'Container (Docker)', direct: 'Direct (real project)',
};

export default function SandboxPanel() {
  const { activeProjectId, projects, activeSandboxId: activeId, setActiveSandbox: setActiveId } = useAppStore();
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<Tab>('terminal');
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([]);
  const [caps, setCaps] = useState<SandboxCapabilities | null>(null);
  const [newMode, setNewMode] = useState<SandboxMode>('temporary');
  const [command, setCommand] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<OutputLine[]>([]);
  const [files, setFiles] = useState<SandboxFileEntry[]>([]);
  const [viewing, setViewing] = useState<{ path: string; content?: string; note?: string } | null>(null);
  const [git, setGit] = useState<SandboxGit | null>(null);
  const [checkpoints, setCheckpoints] = useState<SandboxCheckpoint[]>([]);
  const outputRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const active = sandboxes.find(s => s.id === activeId) ?? null;
  const say = (text: string, type: OutputLine['type']) => setOutput(o => [...o.slice(-1000), { text, type }]);
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const loadSandboxes = useCallback(async () => {
    const all = await apiFetch<Sandbox[]>('/api/sandbox').catch(() => []);
    setSandboxes(all);
    const cur = useAppStore.getState().activeSandboxId;
    // keep a persisted selection only if it still exists
    setActiveId(cur && all.some(x => x.id === cur) ? cur : all[0]?.id ?? null);
  }, [setActiveId]);

  useEffect(() => {
    if (!expanded) return;
    loadSandboxes();
    apiFetch<SandboxCapabilities>('/api/sandbox/capabilities').then(setCaps).catch(() => setCaps(null));
  }, [expanded, loadSandboxes]);

  useEffect(() => { outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight }); }, [output]);

  const refreshInspector = useCallback(async (id: string) => {
    apiFetch<SandboxFileEntry[]>(`/api/sandbox/${id}/files`).then(setFiles).catch(() => setFiles([]));
    apiFetch<SandboxGit>(`/api/sandbox/${id}/git`).then(setGit).catch(() => setGit(null));
    apiFetch<SandboxCheckpoint[]>(`/api/sandbox/${id}/checkpoints`).then(setCheckpoints).catch(() => setCheckpoints([]));
  }, []);
  useEffect(() => { setViewing(null); if (activeId && expanded) refreshInspector(activeId); }, [activeId, expanded, refreshInspector]);

  const createSandbox = async () => {
    const project = projects.find(p => p.id === activeProjectId);
    const body: Record<string, unknown> = { name: `${project?.name ?? 'Sandbox'} · ${MODE_LABEL[newMode]}`, project_id: activeProjectId, mode: newMode };
    if (newMode === 'direct') {
      const ok = window.confirm(`Direct mode runs commands in your REAL project:\n${project?.repo_path || '(set a repo path on the project)'}\n\nFiles can be changed or deleted. Continue?`);
      if (!ok) return;
      body.approve_direct = true;
    }
    try {
      const sb = await apiFetch<Sandbox>('/api/sandbox', { method: 'POST', body: JSON.stringify(body) });
      setSandboxes(s => [sb, ...s]); setActiveId(sb.id);
      say(`Created ${MODE_LABEL[sb.mode]} sandbox (${sb.workspace_kind})`, 'info');
    } catch (e) { say(`Could not create sandbox: ${errMsg(e)}`, 'error'); setExpanded(true); }
  };

  const deleteSandbox = async () => {
    if (!active) return;
    const extra = active.workspace_kind === 'source' ? '\n(Your real project files are NOT deleted.)' : '\nThe temporary workspace and all its changes will be deleted.';
    if (!window.confirm(`Delete sandbox "${active.name}"?${extra}`)) return;
    await apiFetch(`/api/sandbox/${active.id}`, { method: 'DELETE' }).catch(e => say(errMsg(e), 'error'));
    setSandboxes(s => s.filter(x => x.id !== active.id)); setActiveId(null); setFiles([]); setGit(null); setCheckpoints([]);
  };

  const execute = async (confirm = false, cmdOverride?: string) => {
    const cmd = (cmdOverride ?? command).trim();
    if (!active || !cmd || running) return;
    if (!cmdOverride) setCommand('');
    setRunning(true); setRunId(null);
    say(`$ ${cmd}`, 'info');
    const ctrl = new AbortController(); abortRef.current = ctrl;
    const r = await streamRun(active.id, cmd, {
      onStart: setRunId,
      onChunk: (t, stream) => t.split('\n').filter(l => l.length).forEach(l => say(l, stream === 'stderr' ? 'stderr' : 'stdout')),
      onDone: d => {
        const note = d.status === 'timeout' ? 'timed out' : d.status === 'cancelled' ? 'cancelled' : d.truncated ? 'output truncated' : '';
        say(`exit ${d.exitCode} · ${d.durationMs}ms${note ? ' · ' + note : ''}`, d.exitCode === 0 ? 'info' : 'error');
      },
    }, { confirm, signal: ctrl.signal });
    setRunning(false); setRunId(null); abortRef.current = null;
    if (!r.ok) {
      if (r.needsConfirmation && window.confirm(`${r.message}\n\nRun anyway?\n\n${cmd}`)) return execute(true, cmd);
      say(`Error: ${r.message}`, 'error');
    }
    refreshInspector(active.id);
  };

  const stop = async () => {
    if (runId) await cancelRun(runId); else abortRef.current?.abort();
  };

  const openFile = async (path: string) => {
    if (!active) return;
    try {
      const f = await apiFetch<{ content?: string; binary?: boolean; tooLarge?: boolean }>(`/api/sandbox/${active.id}/file?path=${encodeURIComponent(path)}`);
      setViewing({ path, content: f.content, note: f.binary ? 'Binary file' : f.tooLarge ? 'File too large to preview' : undefined });
    } catch (e) { setViewing({ path, note: errMsg(e) }); }
  };

  const checkpoint = async () => {
    if (!active) return;
    const label = window.prompt('Checkpoint label', 'manual');
    if (label === null) return;
    await apiFetch(`/api/sandbox/${active.id}/checkpoints`, { method: 'POST', body: JSON.stringify({ label }) }).catch(e => say(errMsg(e), 'error'));
    refreshInspector(active.id);
  };
  const restore = async (cp: SandboxCheckpoint) => {
    if (!active || !window.confirm(`Restore "${cp.label}"? Uncommitted changes in this sandbox will be discarded.`)) return;
    await apiFetch(`/api/sandbox/${active.id}/restore`, { method: 'POST', body: JSON.stringify({ sha: cp.sha, confirm: true }) }).catch(e => say(errMsg(e), 'error'));
    say(`Restored checkpoint "${cp.label}"`, 'info'); refreshInspector(active.id);
  };

  const readonly = active?.mode === 'readonly';
  const canCheckpoint = !!active && active.workspace_kind !== 'source';
  const modeCap = caps?.modes[newMode];

  const renderTree = (nodes: SandboxFileEntry[], depth = 0): React.ReactNode =>
    nodes.map(n => (
      <div key={n.path}>
        <button onClick={() => n.type === 'file' && openFile(n.path)} style={{ paddingLeft: 6 + depth * 10 }}
          className={clsx('w-full flex items-center gap-1 text-[10px] py-0.5 text-left hover:bg-slate-800', viewing?.path === n.path ? 'text-indigo-300' : 'text-slate-500')}>
          {n.type === 'directory' ? <FolderOpen size={9} className="text-indigo-500/60" /> : <FileIcon size={9} className="text-slate-700" />}
          <span className="truncate">{n.name}</span>
        </button>
        {n.children && renderTree(n.children, depth + 1)}
      </div>
    ));

  return (
    <div className={clsx('border-t border-slate-700/50 bg-slate-900 flex flex-col transition-all duration-200', expanded ? 'h-80' : 'h-9')}>
      <div className="flex items-center gap-2 px-4 h-9 flex-shrink-0 cursor-pointer hover:bg-slate-800/40 select-none" onClick={() => setExpanded(e => !e)}>
        <Terminal size={12} className="text-slate-500" />
        <span className="text-xs text-slate-500 font-medium">Sandbox</span>
        {active && <span className="text-[10px] text-slate-600 ml-1">{active.name}</span>}
        <div className="ml-auto flex items-center gap-2">
          {running && <span className="text-[10px] text-yellow-500 animate-pulse">running…</span>}
          {expanded ? <ChevronDown size={12} className="text-slate-600" /> : <ChevronUp size={12} className="text-slate-600" />}
        </div>
      </div>

      {expanded && (
        <div className="flex flex-1 min-h-0">
          {/* Sandbox list + creation */}
          <div className="w-48 border-r border-slate-700/50 flex flex-col">
            <div className="p-2 border-b border-slate-700/50 space-y-1">
              <select value={newMode} onChange={e => setNewMode(e.target.value as SandboxMode)}
                className="w-full bg-slate-800 text-[10px] text-slate-300 rounded px-1 py-1 focus:outline-none">
                {(Object.keys(MODE_LABEL) as SandboxMode[]).map(m => (
                  <option key={m} value={m} disabled={caps ? !caps.modes[m]?.available : false}>{MODE_LABEL[m]}{caps && !caps.modes[m]?.available ? ' (unavailable)' : ''}</option>
                ))}
              </select>
              <button onClick={createSandbox} className="w-full flex items-center justify-center gap-1 text-[10px] text-indigo-400 hover:bg-slate-800 rounded py-1">
                <Plus size={10} /> New sandbox
              </button>
              {modeCap && <div className="flex gap-1 text-[9px] text-slate-600 leading-tight"><Shield size={9} className="flex-shrink-0 mt-0.5" /><span>{modeCap.enforcement}</span></div>}
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-thin">
              {sandboxes.map(sb => (
                <button key={sb.id} onClick={() => setActiveId(sb.id)}
                  className={clsx('w-full text-left px-2 py-1.5 text-[10px] transition-colors', activeId === sb.id ? 'bg-indigo-600/15 text-indigo-300' : 'text-slate-500 hover:bg-slate-800')}>
                  <div className="truncate">{sb.name}</div>
                  <div className="text-slate-700">{sb.mode} · {sb.workspace_kind}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Main area */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="flex items-center gap-1 px-2 border-b border-slate-700/30 h-7 flex-shrink-0">
              {(['terminal', 'changes', 'files', 'agent'] as Tab[]).map(t => (
                <button key={t} onClick={() => setTab(t)}
                  className={clsx('text-[10px] px-2 py-1 rounded capitalize', tab === t ? 'bg-slate-800 text-slate-200' : 'text-slate-600 hover:text-slate-400')}>
                  {t}{t === 'changes' && git?.status.files.length ? ` (${git.status.files.length})` : ''}
                </button>
              ))}
              {active && <button onClick={deleteSandbox} className="ml-auto p-1 text-slate-700 hover:text-red-400" title="Delete sandbox"><Trash2 size={10} /></button>}
            </div>

            {tab === 'terminal' && (<>
              <div ref={outputRef} className="flex-1 overflow-y-auto scrollbar-thin p-2 font-mono text-[11px] leading-relaxed">
                {output.length === 0 && <div className="text-slate-700 mt-2">{active ? (readonly ? 'Read-only sandbox: browse files and changes; commands are disabled.' : 'Ready. Type a command below.') : 'Create or select a sandbox to begin.'}</div>}
                {output.map((l, i) => (
                  <div key={i} className={clsx(l.type === 'info' ? 'text-slate-500' : l.type === 'stderr' ? 'text-yellow-500/80' : l.type === 'error' ? 'text-red-400' : 'text-slate-300')}>{l.text}</div>
                ))}
              </div>
              <div className="border-t border-slate-700/30 flex items-center gap-2 px-2 py-1.5">
                <span className="text-slate-600 font-mono text-[11px]">$</span>
                <input value={command} onChange={e => setCommand(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') execute(); }}
                  disabled={!active || running || readonly}
                  className="flex-1 bg-transparent text-[11px] font-mono text-slate-300 placeholder-slate-700 focus:outline-none"
                  placeholder={!active ? 'Create a sandbox first' : readonly ? 'Commands disabled (read-only)' : 'Enter a command…'} />
                {running
                  ? <button onClick={stop} className="p-1 text-red-400 hover:text-red-300" title="Stop"><Square size={11} /></button>
                  : <button onClick={() => execute()} disabled={!command.trim() || !active || readonly} className="p-1 text-slate-600 hover:text-indigo-400 disabled:opacity-30" title="Run"><Play size={11} /></button>}
                <button onClick={() => setOutput([])} className="p-1 text-slate-700 hover:text-slate-500" title="Clear"><Trash2 size={10} /></button>
              </div>
            </>)}

            {tab === 'changes' && (
              <div className="flex-1 flex min-h-0">
                <div className="flex-1 overflow-auto scrollbar-thin p-2 font-mono text-[10px] leading-snug">
                  {!git?.status.isRepo && <div className="text-slate-700">Not a git workspace — no diff available.</div>}
                  {git?.status.isRepo && git.status.files.length === 0 && <div className="text-slate-600">No changes.</div>}
                  {git?.status.files.map(f => <div key={f.path} className="text-slate-400"><span className="text-indigo-400 mr-2">{f.status}</span>{f.path}</div>)}
                  {git?.diff && <pre className="mt-2 whitespace-pre-wrap">{git.diff.split('\n').map((l, i) =>
                    <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'text-green-400' : l.startsWith('-') && !l.startsWith('---') ? 'text-red-400' : l.startsWith('@@') ? 'text-cyan-400' : 'text-slate-500'}>{l}</div>)}</pre>}
                  {git?.truncated && <div className="text-yellow-600 mt-1">Diff truncated.</div>}
                </div>
                <div className="w-44 border-l border-slate-700/50 p-2 overflow-y-auto scrollbar-thin">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-slate-600 flex items-center gap-1"><GitBranch size={9} />Checkpoints</span>
                    <button onClick={checkpoint} disabled={!canCheckpoint} title={canCheckpoint ? 'Create checkpoint' : 'Unavailable in read-only/direct mode'} className="text-slate-600 hover:text-indigo-400 disabled:opacity-30"><Save size={10} /></button>
                  </div>
                  {checkpoints.map(cp => (
                    <div key={cp.sha} className="flex items-center gap-1 text-[10px] text-slate-500 py-0.5">
                      <span className="truncate flex-1" title={cp.created_at}>{cp.label}</span>
                      <button onClick={() => restore(cp)} className="text-slate-700 hover:text-yellow-400" title="Restore"><RotateCcw size={9} /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === 'agent' && active && (
              <AgentPanel sandboxId={active.id} editable={active.mode === 'temporary' || active.mode === 'container'} onChanged={() => refreshInspector(active.id)} />
            )}
            {tab === 'agent' && !active && <div className="p-3 text-[11px] text-slate-700">Create or select a sandbox first.</div>}

            {tab === 'files' && (
              <div className="flex-1 flex min-h-0">
                <div className="w-48 border-r border-slate-700/50 overflow-y-auto scrollbar-thin py-1">{files.length ? renderTree(files) : <div className="text-[10px] text-slate-700 p-2">No files.</div>}</div>
                <pre className="flex-1 overflow-auto scrollbar-thin p-2 text-[10px] font-mono text-slate-300 whitespace-pre-wrap">
                  {viewing ? (viewing.content ?? viewing.note) : <span className="text-slate-700">Select a file to preview.</span>}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
