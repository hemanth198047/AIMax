import React, { useState, useEffect } from 'react';
import { Brain, Plus, Search, Lightbulb, AlertTriangle, CheckCircle, BookOpen, X } from 'lucide-react';
import { apiFetch } from '../api/client';
import { useAppStore } from '../stores/appStore';
import clsx from 'clsx';

type KnowledgeTab = 'memory' | 'decisions' | 'solutions' | 'failures';

interface Decision { id: string; title: string; rationale: string; status: string; created_at: string; }
interface Solution { id: string; problem: string; fix: string; tags: string; verified_at: string; }
interface Failure { id: string; approach: string; reason: string; created_at: string; }
interface MemoryEntry { id: string; title: string; content: string; type: string; provenance: string; created_at: string; }

export default function KnowledgePanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<KnowledgeTab>('memory');
  const [q, setQ] = useState('');
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [solutions, setSolutions] = useState<Solution[]>([]);
  const [failures, setFailures] = useState<Failure[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [addTitle, setAddTitle] = useState('');
  const [addContent, setAddContent] = useState('');
  const [addType, setAddType] = useState('note');
  const { activeProjectId, activePersonId, scope } = useAppStore();

  useEffect(() => { load(); }, [tab, activeProjectId, activePersonId]);

  const load = async () => {
    const params = new URLSearchParams();
    if (activeProjectId) params.set('project_id', activeProjectId);
    if (activePersonId) params.set('person_id', activePersonId);
    if (q) params.set('q', q);

    if (tab === 'memory') {
      const data = await apiFetch<MemoryEntry[]>(`/api/memory?${params}`).catch(() => []);
      setMemory(data);
    } else if (tab === 'decisions') {
      const data = await apiFetch<Decision[]>(`/api/decisions?${params}`).catch(() => []);
      setDecisions(data);
    } else if (tab === 'solutions') {
      const data = await apiFetch<Solution[]>(`/api/solutions?${params}`).catch(() => []);
      setSolutions(data);
    } else {
      const data = await apiFetch<Failure[]>(`/api/failures?${params}`).catch(() => []);
      setFailures(data);
    }
  };

  const addMemory = async () => {
    if (!addTitle.trim() || !addContent.trim()) return;
    await apiFetch('/api/memory', {
      method: 'POST',
      body: JSON.stringify({
        title: addTitle, content: addContent, type: addType,
        scope, // global | project | person | project_person — never widen a private context to global
        project_id: activeProjectId, person_id: activePersonId
      })
    });
    setAddTitle(''); setAddContent(''); setShowAdd(false);
    load();
  };

  const tabs: { id: KnowledgeTab; icon: React.ReactNode; label: string; count: number }[] = [
    { id: 'memory', icon: <Brain size={12} />, label: 'Memory', count: memory.length },
    { id: 'decisions', icon: <BookOpen size={12} />, label: 'Decisions', count: decisions.length },
    { id: 'solutions', icon: <CheckCircle size={12} />, label: 'Solutions', count: solutions.length },
    { id: 'failures', icon: <AlertTriangle size={12} />, label: 'Failures', count: failures.length },
  ];

  return (
    <div className="fixed inset-y-0 right-0 w-96 bg-slate-900 border-l border-slate-700 flex flex-col z-40 shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <Brain size={14} className="text-indigo-400" />
          <span className="font-semibold text-sm text-slate-100">Engineering Knowledge</span>
        </div>
        <button onClick={onClose} aria-label="Close knowledge panel" className="text-slate-500 hover:text-slate-300"><X size={14} /></button>
      </div>

      {/* Search */}
      <div className="px-4 py-2 border-b border-slate-700">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={11} className="absolute left-2.5 top-2.5 text-slate-600" />
            <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && load()}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-7 pr-3 py-2 text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-indigo-500"
              placeholder="Search knowledge…" />
          </div>
          <button onClick={() => setShowAdd(true)} aria-label="Add knowledge entry" title="Add knowledge entry" className="px-3 py-2 bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30 rounded-lg text-xs border border-indigo-600/20">
            <Plus size={11} />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-700">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={clsx(
              'flex-1 flex items-center justify-center gap-1.5 py-2 text-xs transition-colors',
              tab === t.id ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-slate-500 hover:text-slate-300'
            )}>
            {t.icon} <span>{t.label}</span>
            {t.count > 0 && <span className="text-[9px] opacity-60">{t.count}</span>}
          </button>
        ))}
      </div>

      {/* Add form */}
      {showAdd && tab === 'memory' && (
        <div className="p-3 bg-slate-800/50 border-b border-slate-700 space-y-2">
          <input value={addTitle} onChange={e => setAddTitle(e.target.value)}
            className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            placeholder="Title" />
          <textarea value={addContent} onChange={e => setAddContent(e.target.value)} rows={3}
            className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 resize-none"
            placeholder="Content" />
          <div className="flex gap-2">
            <select value={addType} onChange={e => setAddType(e.target.value)}
              className="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-100 focus:outline-none">
              {['note', 'decision', 'solution', 'discovery', 'requirement', 'task'].map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <button onClick={addMemory} className="px-3 py-1 bg-indigo-600 text-white text-xs rounded hover:bg-indigo-500">Save</button>
            <button onClick={() => setShowAdd(false)} className="px-3 py-1 text-slate-500 text-xs hover:text-slate-300">Cancel</button>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2">
        {tab === 'memory' && memory.map(m => (
          <div key={m.id} className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-3">
            <div className="flex items-start justify-between gap-2 mb-1">
              <span className="text-xs font-medium text-slate-200">{m.title}</span>
              <span className={clsx('text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0', {
                'bg-indigo-600/20 text-indigo-400': m.type === 'decision',
                'bg-green-600/20 text-green-400': m.type === 'solution',
                'bg-slate-700 text-slate-400': m.type === 'note',
                'bg-yellow-600/20 text-yellow-400': m.type === 'task',
              })}>{m.type}</span>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed line-clamp-3">{m.content}</p>
            <div className="text-[9px] text-slate-700 mt-1.5">{m.provenance} · {new Date(m.created_at).toLocaleDateString()}</div>
          </div>
        ))}

        {tab === 'decisions' && decisions.map(d => (
          <div key={d.id} className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-3">
            <div className="flex items-start gap-2 mb-1">
              <span className={clsx('w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0', d.status === 'active' ? 'bg-green-500' : 'bg-slate-600')} />
              <span className="text-xs font-medium text-slate-200">{d.title}</span>
            </div>
            {d.rationale && <p className="text-xs text-slate-500 leading-relaxed line-clamp-2 ml-3.5">{d.rationale}</p>}
            <div className="text-[9px] text-slate-700 mt-1.5 ml-3.5">{d.status} · {new Date(d.created_at).toLocaleDateString()}</div>
          </div>
        ))}

        {tab === 'solutions' && solutions.map(s => (
          <div key={s.id} className="bg-slate-800/50 border border-green-600/10 rounded-xl p-3">
            <div className="text-xs font-medium text-slate-200 mb-1">{s.problem}</div>
            <div className="text-xs text-green-400/80 font-mono leading-relaxed line-clamp-3">{s.fix}</div>
            <div className="text-[9px] text-slate-700 mt-1.5">verified {new Date(s.verified_at).toLocaleDateString()}</div>
          </div>
        ))}

        {tab === 'failures' && failures.map(f => (
          <div key={f.id} className="bg-slate-800/50 border border-red-600/10 rounded-xl p-3">
            <div className="text-xs font-medium text-slate-300 mb-1">{f.approach}</div>
            <div className="text-xs text-red-400/70 leading-relaxed line-clamp-2">{f.reason}</div>
            <div className="text-[9px] text-slate-700 mt-1.5">{new Date(f.created_at).toLocaleDateString()}</div>
          </div>
        ))}

        {(tab === 'memory' && memory.length === 0) ||
         (tab === 'decisions' && decisions.length === 0) ||
         (tab === 'solutions' && solutions.length === 0) ||
         (tab === 'failures' && failures.length === 0) ? (
          <div className="text-center py-8 text-slate-700 text-xs">
            No {tab} yet{activeProjectId ? ' for this project' : ''}.
          </div>
        ) : null}
      </div>
    </div>
  );
}
