import React, { useEffect, useState } from 'react';
import { FolderOpen, User, Globe, Zap, Brain, Activity } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import type { EnhanceMode } from '../stores/appStore';
import { useChatStore } from '../stores/chatStore';
import { apiFetch } from '../api/client';
import type { PersonLink } from '../api/client';
import clsx from 'clsx';
import UsagePanel from './UsagePanel';

const PROVIDERS = [
  { id: 'auto', label: 'Auto', desc: 'Best available' },
  { id: 'claude', label: 'Claude', desc: 'Claude Code CLI' },
  { id: 'ollama', label: 'Ollama', desc: 'Local models' },
  { id: 'cursor', label: 'Cursor', desc: 'Cursor CLI (experimental)' },
];

interface ProviderStatus {
  claude: { available: boolean; version?: string };
  ollama: { available: boolean; models: string[]; selected?: string };
  cursor: { available: boolean };
  codex?: { available: boolean };
  freellmapi: { available: boolean };
  test?: { available: boolean };
}

export default function ContextPanel() {
  const { scope, activeProjectId, activePersonId, provider, setProvider, enhance, setEnhance, projects, people } = useAppStore();
  const retrieved = useChatStore(s => s.retrieved);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [linked, setLinked] = useState<PersonLink[]>([]);
  const [linkRole, setLinkRole] = useState('contributor');
  const [linkError, setLinkError] = useState('');

  const loadStatus = () => { apiFetch<ProviderStatus>('/api/providers/status').then(setProviderStatus).catch(() => {}); };
  useEffect(loadStatus, []);

  useEffect(() => {
    if (!activeProjectId) { setLinked([]); return; }
    apiFetch<PersonLink[]>(`/api/projects/${activeProjectId}/people`).then(setLinked).catch(() => setLinked([]));
  }, [activeProjectId]);

  const isLinked = !!activePersonId && linked.some(l => l.id === activePersonId);
  const toggleLink = async () => {
    if (!activeProjectId || !activePersonId) return;
    setLinkError('');
    try {
      if (isLinked) await apiFetch(`/api/projects/${activeProjectId}/people/${activePersonId}`, { method: 'DELETE' });
      else await apiFetch(`/api/projects/${activeProjectId}/people`, { method: 'POST', body: JSON.stringify({ person_id: activePersonId, role: linkRole }) });
      setLinked(await apiFetch<PersonLink[]>(`/api/projects/${activeProjectId}/people`));
    } catch (e) { setLinkError(e instanceof Error ? e.message : 'Failed'); }
  };

  const activeProject = projects.find(p => p.id === activeProjectId);
  const activePerson = people.find(p => p.id === activePersonId);

  return (
    <div className="w-52 flex flex-col bg-slate-950 border-l border-slate-800 text-xs overflow-y-auto scrollbar-thin flex-shrink-0">

      {/* Active Context */}
      <div className="p-3 border-b border-slate-800">
        <div className="text-[10px] text-slate-600 font-medium uppercase tracking-wider mb-2">Context</div>
        <div className="space-y-1">
          <div className={clsx(
            'flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px]',
            !activeProject && !activePerson ? 'bg-slate-800 text-slate-300' : 'text-slate-600'
          )}>
            <Globe size={10} /> Global
          </div>
          {activeProject && (
            <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-indigo-600/10 text-indigo-300 text-[11px] border border-indigo-600/15">
              <FolderOpen size={10} />
              <span className="truncate">{activeProject.name}</span>
            </div>
          )}
          {activePerson && (
            <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-purple-600/10 text-purple-300 text-[11px] border border-purple-600/15">
              <User size={10} />
              <span className="truncate">{activePerson.display_name}</span>
            </div>
          )}
        </div>
        <div className="mt-2 px-2 py-1 bg-slate-800/50 rounded-lg text-[10px] text-slate-500 capitalize text-center">
          {scope.replace('_', ' + ')} scope
        </div>
      </div>

      {/* Project ↔ person relationship */}
      {activeProjectId && (
        <div className="p-3 border-b border-slate-800" data-testid="relationships">
          <div className="text-[10px] text-slate-600 font-medium uppercase tracking-wider mb-2">People on project</div>
          {linked.length === 0 && <div className="text-[10px] text-slate-700">None linked yet</div>}
          {linked.map(l => (
            <div key={l.id} className="text-[11px] text-slate-400 flex justify-between"><span className="truncate">{l.display_name}</span><span className="text-slate-600">{l.project_role}</span></div>
          ))}
          {activePersonId && (
            <div className="mt-2 space-y-1">
              {!isLinked && (
                <select value={linkRole} onChange={e => setLinkRole(e.target.value)} aria-label="Role on project"
                  className="w-full bg-slate-800 border border-slate-700 rounded px-1 py-1 text-[10px] text-slate-300 focus:outline-none">
                  {['owner', 'client', 'sponsor', 'architect', 'developer', 'tester', 'reviewer', 'stakeholder', 'manager', 'contributor', 'advisor', 'contact', 'student', 'mentor'].map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              )}
              <button onClick={toggleLink}
                className="w-full px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-[10px] text-indigo-300">
                {isLinked ? `Unlink ${activePerson?.display_name}` : `Link ${activePerson?.display_name} to ${activeProject?.name}`}
              </button>
              {linkError && <div className="text-[10px] text-red-400">{linkError}</div>}
            </div>
          )}
        </div>
      )}

      {/* Provider Selection */}
      <div className="p-3 border-b border-slate-800">
        <div className="text-[10px] text-slate-600 font-medium uppercase tracking-wider mb-2">Provider</div>
        <div className="space-y-0.5">
          {(providerStatus?.test ? [...PROVIDERS, { id: 'test', label: 'Test', desc: 'Deterministic (tests only)' }] : PROVIDERS).map(p => {
            const statusOk = p.id === 'claude' ? providerStatus?.claude.available
              : p.id === 'ollama' ? providerStatus?.ollama.available
              : p.id === 'cursor' ? providerStatus?.cursor.available
              : null;
            return (
              <button
                key={p.id}
                onClick={() => setProvider(p.id)}
                className={clsx(
                  'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors',
                  provider === p.id
                    ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-600/20'
                    : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'
                )}
              >
                <Zap size={9} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-[11px]">{p.label}</div>
                  <div className="text-[9px] opacity-60">{p.desc}</div>
                </div>
                {statusOk !== null && (
                  <div className={clsx('w-1.5 h-1.5 rounded-full flex-shrink-0', statusOk ? 'bg-green-500' : 'bg-slate-600')} />
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-2 text-[9px] text-slate-700">
          {providerStatus?.claude.available ? `Claude CLI ${providerStatus.claude.version ?? ''}` : 'Claude CLI not found'} · Cursor: experimental · Codex, FreeLLMAPI: no adapter yet
        </div>
      </div>

      <UsagePanel ollamaModels={providerStatus?.ollama.models ?? []} ollamaSelected={providerStatus?.ollama.selected ?? ''} onModelChange={loadStatus} />

      {/* Prompt enhancement */}
      <div className="p-3 border-b border-slate-800">
        <div className="text-[10px] text-slate-600 font-medium uppercase tracking-wider mb-2">Prompt enhancement</div>
        <select value={enhance} onChange={e => setEnhance(e.target.value as EnhanceMode)} aria-label="Prompt enhancement"
          className="w-full bg-slate-800 border border-slate-700 rounded px-1 py-1 text-[11px] text-slate-300 focus:outline-none">
          {(['off', 'minimal', 'balanced', 'maximum'] as EnhanceMode[]).map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <div className="text-[9px] text-slate-700 mt-1">Deterministic · no extra model call · your words are never rewritten</div>
      </div>

      {/* Retrieved memory (last turn) */}
      <div className="p-3 border-b border-slate-800" data-testid="retrieved-memory">
        <div className="text-[10px] text-slate-600 font-medium uppercase tracking-wider mb-2">Retrieved memory</div>
        {retrieved.length === 0 && <div className="text-[10px] text-slate-700">Nothing used in the last turn</div>}
        {retrieved.map(r => (
          <div key={r.id} className="text-[11px] text-slate-400 flex justify-between gap-2" title={`${r.scope} · ${r.provenance}`}>
            <span className="truncate">{r.title}</span><span className="text-slate-600 flex-shrink-0">{r.provenance.replace('_', ' ')}</span>
          </div>
        ))}
      </div>

      {/* Memory */}
      <div className="p-3">
        <div className="text-[10px] text-slate-600 font-medium uppercase tracking-wider mb-2">MemoryVault</div>
        <div className="flex items-center gap-1.5 text-slate-600 text-[10px]">
          <Brain size={9} className="text-indigo-500/60" />
          <span>SQLite · FTS5 · WAL</span>
        </div>
        <div className="flex items-center gap-1.5 text-slate-700 text-[10px] mt-1">
          <Activity size={9} />
          <span>Scope-aware retrieval</span>
        </div>
      </div>
    </div>
  );
}
