import React, { useEffect, useState } from 'react';
import { FolderOpen, User, Globe, Zap, Brain, Activity } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { apiFetch } from '../api/client';
import clsx from 'clsx';

const PROVIDERS = [
  { id: 'auto', label: 'Auto', desc: 'Best available' },
  { id: 'claude', label: 'Claude', desc: 'Claude Code CLI' },
  { id: 'ollama', label: 'Ollama', desc: 'Local models' },
];

interface ProviderStatus {
  claude: { available: boolean };
  ollama: { available: boolean; models: string[] };
  cursor: { available: boolean };
  freellmapi: { available: boolean };
}

export default function ContextPanel() {
  const { scope, activeProjectId, activePersonId, provider, setProvider, projects, people } = useAppStore();
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);

  useEffect(() => {
    apiFetch<ProviderStatus>('/api/providers/status')
      .then(setProviderStatus)
      .catch(() => {});
  }, []);

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

      {/* Provider Selection */}
      <div className="p-3 border-b border-slate-800">
        <div className="text-[10px] text-slate-600 font-medium uppercase tracking-wider mb-2">Provider</div>
        <div className="space-y-0.5">
          {PROVIDERS.map(p => {
            const statusOk = p.id === 'claude' ? providerStatus?.claude.available
              : p.id === 'ollama' ? providerStatus?.ollama.available
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
        {providerStatus?.ollama.models.length ? (
          <div className="mt-2 text-[9px] text-slate-700">
            Ollama: {providerStatus.ollama.models.slice(0, 3).join(', ')}
          </div>
        ) : null}
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
