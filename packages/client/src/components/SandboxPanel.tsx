import React, { useState, useRef, useEffect } from 'react';
import { Terminal, Play, Square, Plus, Trash2, FolderOpen, ChevronDown, ChevronUp } from 'lucide-react';
import { apiFetch } from '../api/client';
import type { Sandbox } from '../api/client';
import { useAppStore } from '../stores/appStore';
import clsx from 'clsx';

interface OutputLine { text: string; type: 'stdout' | 'stderr' | 'info' | 'error'; ts: string; }

export default function SandboxPanel() {
  const [expanded, setExpanded] = useState(false);
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([]);
  const [activeSandboxId, setActiveSandboxId] = useState<string | null>(null);
  const [command, setCommand] = useState('');
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<OutputLine[]>([]);
  const [files, setFiles] = useState<unknown[]>([]);
  const outputRef = useRef<HTMLDivElement>(null);
  const { activeProjectId } = useAppStore();

  useEffect(() => {
    if (expanded) loadSandboxes();
  }, [expanded]);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: 'smooth' });
  }, [output]);

  const loadSandboxes = async () => {
    const all = await apiFetch<Sandbox[]>('/api/sandbox');
    setSandboxes(all);
    if (all.length > 0 && !activeSandboxId) setActiveSandboxId(all[0].id);
  };

  const createSandbox = async () => {
    const sb = await apiFetch<Sandbox>('/api/sandbox', {
      method: 'POST',
      body: JSON.stringify({ name: `Sandbox ${Date.now()}`, project_id: activeProjectId, mode: 'temporary' })
    });
    setSandboxes(s => [sb, ...s]);
    setActiveSandboxId(sb.id);
    addOutput(`Created sandbox: ${sb.name}`, 'info');
  };

  const addOutput = (text: string, type: OutputLine['type']) => {
    setOutput(o => [...o.slice(-500), { text, type, ts: new Date().toLocaleTimeString() }]);
  };

  const execute = async () => {
    if (!activeSandboxId || !command.trim() || running) return;
    const cmd = command.trim();
    setCommand('');
    setRunning(true);
    addOutput(`> ${cmd}`, 'info');

    try {
      const result = await apiFetch<{
        stdout: string; stderr: string; exitCode: number; timedOut: boolean; durationMs: number;
      }>(`/api/sandbox/${activeSandboxId}/execute`, {
        method: 'POST',
        body: JSON.stringify({ command: cmd, timeout: 30000 })
      });

      if (result.stdout) result.stdout.split('\n').filter(Boolean).forEach(l => addOutput(l, 'stdout'));
      if (result.stderr) result.stderr.split('\n').filter(Boolean).forEach(l => addOutput(l, 'stderr'));
      if (result.timedOut) addOutput('Command timed out (30s)', 'error');
      else addOutput(`Exit code: ${result.exitCode} (${result.durationMs}ms)`, result.exitCode === 0 ? 'info' : 'error');

      // Refresh files
      const f = await apiFetch<unknown[]>(`/api/sandbox/${activeSandboxId}/files`);
      setFiles(f);
    } catch (err) {
      addOutput(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setRunning(false);
    }
  };

  const activeSandbox = sandboxes.find(s => s.id === activeSandboxId);

  return (
    <div className={clsx(
      'border-t border-slate-700/50 bg-slate-900 flex flex-col transition-all duration-200',
      expanded ? 'h-72' : 'h-9'
    )}>
      {/* Header */}
      <div
        className="flex items-center gap-2 px-4 h-9 flex-shrink-0 cursor-pointer hover:bg-slate-800/40 select-none"
        onClick={() => setExpanded(e => !e)}
      >
        <Terminal size={12} className="text-slate-500" />
        <span className="text-xs text-slate-500 font-medium">Sandbox Terminal</span>
        {activeSandbox && (
          <span className="text-[10px] text-slate-700 ml-1">{activeSandbox.name}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {running && <span className="text-[10px] text-yellow-500 animate-pulse">running…</span>}
          {expanded ? <ChevronDown size={12} className="text-slate-600" /> : <ChevronUp size={12} className="text-slate-600" />}
        </div>
      </div>

      {expanded && (
        <div className="flex flex-1 min-h-0">
          {/* Sandbox list */}
          <div className="w-40 border-r border-slate-700/50 flex flex-col">
            <div className="flex items-center justify-between px-2 py-1.5 border-b border-slate-700/50">
              <span className="text-[10px] text-slate-600">Sandboxes</span>
              <button onClick={createSandbox} className="text-slate-600 hover:text-indigo-400 transition-colors" title="New sandbox">
                <Plus size={10} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-thin">
              {sandboxes.length === 0 && (
                <button onClick={createSandbox}
                  className="w-full px-2 py-2 text-[10px] text-indigo-400 hover:bg-slate-800 text-left">
                  + New sandbox
                </button>
              )}
              {sandboxes.map(sb => (
                <button key={sb.id}
                  onClick={() => setActiveSandboxId(sb.id)}
                  className={clsx(
                    'w-full text-left px-2 py-1.5 text-[10px] transition-colors',
                    activeSandboxId === sb.id ? 'bg-indigo-600/15 text-indigo-300' : 'text-slate-500 hover:bg-slate-800'
                  )}>
                  <div className="truncate">{sb.name}</div>
                  <div className="text-slate-700">{sb.mode}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Terminal area */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Output */}
            <div ref={outputRef} className="flex-1 overflow-y-auto scrollbar-thin p-2 font-mono text-[11px] leading-relaxed">
              {output.length === 0 && (
                <div className="text-slate-700 mt-2">
                  {activeSandboxId ? 'Ready. Type a command below.' : 'Create or select a sandbox to begin.'}
                </div>
              )}
              {output.map((line, i) => (
                <div key={i} className={clsx(
                  line.type === 'info' ? 'text-slate-500' :
                  line.type === 'stderr' ? 'text-yellow-500/80' :
                  line.type === 'error' ? 'text-red-400' :
                  'text-slate-300'
                )}>
                  {line.text}
                </div>
              ))}
            </div>

            {/* Input */}
            <div className="border-t border-slate-700/30 flex items-center gap-2 px-2 py-1.5">
              <span className="text-slate-600 font-mono text-[11px] flex-shrink-0">PS&gt;</span>
              <input
                value={command}
                onChange={e => setCommand(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') execute(); }}
                disabled={!activeSandboxId || running}
                className="flex-1 bg-transparent text-[11px] font-mono text-slate-300 placeholder-slate-700 focus:outline-none"
                placeholder={activeSandboxId ? 'Enter PowerShell command…' : 'Create a sandbox first'}
              />
              <button onClick={execute} disabled={!command.trim() || !activeSandboxId || running}
                className="flex-shrink-0 p-1 text-slate-600 hover:text-indigo-400 disabled:opacity-30 transition-colors">
                {running ? <Square size={11} /> : <Play size={11} />}
              </button>
              <button onClick={() => setOutput([])} className="flex-shrink-0 p-1 text-slate-700 hover:text-slate-500 transition-colors" title="Clear">
                <Trash2 size={10} />
              </button>
            </div>
          </div>

          {/* File tree */}
          {files.length > 0 && (
            <div className="w-36 border-l border-slate-700/50 overflow-y-auto scrollbar-thin p-2">
              <div className="text-[10px] text-slate-600 mb-1">Files</div>
              {(files as Array<{ name: string; type: string; size: number }>).map((f, i) => (
                <div key={i} className="flex items-center gap-1 text-[10px] text-slate-500 py-0.5">
                  <FolderOpen size={9} className={f.type === 'directory' ? 'text-indigo-500/60' : 'text-slate-700'} />
                  <span className="truncate">{f.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
