import { loadConversations, ctxQs } from '../api/conversations';
import React, { useEffect, useState } from 'react';
import { Pin, Pencil, Archive, ArchiveRestore, Search, Plus, MessageSquare, FolderOpen, Users, Brain, CheckSquare, Settings, X, Link, Lightbulb, Download } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { apiFetch } from '../api/client';
import type { Conversation, Project, Person } from '../api/client';
import clsx from 'clsx';
import ProjectCreate from './ProjectCreate';
import PersonCreate from './PersonCreate';

interface SidebarProps {
  onShowKnowledge: () => void;
  onShowLinkVault: () => void;
  onShowImport: () => void;
  onShowProject: (id: string) => void;
  onShowSettings: () => void;
}

export default function Sidebar({ onShowKnowledge, onShowLinkVault, onShowImport, onShowProject, onShowSettings }: SidebarProps) {
  const {
    sidebarSection, setSidebarSection, conversations, projects, people,
    activeConversationId, setActiveConversation, setConversations,
    activeProjectId, setActiveProject, activePersonId, setActivePerson, scope,
    convQuery, setConvQuery, showArchived, setShowArchived
  } = useAppStore();

  const [showProjectCreate, setShowProjectCreate] = useState(false);
  const [showPersonCreate, setShowPersonCreate] = useState(false);

  const createConversation = async () => {
    const conv = await apiFetch<Conversation>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ title: 'New Conversation', scope, project_id: activeProjectId, person_id: activePersonId })
    });
    setConversations([conv, ...conversations]);
    setActiveConversation(conv.id);
  };

  useEffect(() => {
    const t = setTimeout(() => { loadConversations().catch(console.error); }, 200);   // debounce search typing
    return () => clearTimeout(t);
  }, [convQuery, showArchived]);

  const patchConversation = async (e: React.MouseEvent, conv: Conversation, body: Record<string, unknown>) => {
    e.stopPropagation();
    await apiFetch(`/api/conversations/${conv.id}${ctxQs()}`, { method: 'PATCH', body: JSON.stringify(body) });
    await loadConversations();
  };
  const renameConversation = (e: React.MouseEvent, conv: Conversation) => {
    const title = window.prompt('Rename conversation', conv.title)?.trim();
    if (title) void patchConversation(e, conv, { title: title.slice(0, 120) }); else e.stopPropagation();
  };

  const deleteConversation = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await apiFetch(`/api/conversations/${id}${ctxQs()}`, { method: 'DELETE' });
    setConversations(conversations.filter(c => c.id !== id));
    if (activeConversationId === id) setActiveConversation(null);
  };

  const navItems = [
    { id: 'conversations' as const, icon: MessageSquare, label: 'Chats' },
    { id: 'projects' as const, icon: FolderOpen, label: 'Projects' },
    { id: 'people' as const, icon: Users, label: 'People' },
    { id: 'memory' as const, icon: Brain, label: 'Memory' },
    { id: 'tasks' as const, icon: CheckSquare, label: 'Tasks' },
  ];

  return (
    <div className="w-60 flex flex-col bg-slate-950 border-r border-slate-800 h-full flex-shrink-0">
      {/* Header */}
      <div className="p-3 border-b border-slate-800">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center text-xs font-bold text-white">AI</div>
          <div>
            <div className="font-semibold text-sm text-slate-100 leading-none">AImax</div>
            <div className="text-[10px] text-slate-500">Maximum Intelligence</div>
          </div>
        </div>
        <button
          onClick={createConversation}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition-colors"
        >
          <Plus size={12} /> New Conversation
        </button>
      </div>

      {/* Nav tabs */}
      <div className="flex border-b border-slate-800">
        {navItems.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            onClick={() => setSidebarSection(id)}
            title={label}
            className={clsx(
              'flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px] transition-colors',
              sidebarSection === id
                ? 'text-indigo-400 border-b-2 border-indigo-400'
                : 'text-slate-500 hover:text-slate-300'
            )}
          >
            <Icon size={13} />
          </button>
        ))}
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">

        {/* Conversations */}
        {sidebarSection === 'conversations' && (
          <div className="p-2 space-y-0.5">
            <div className="flex items-center gap-1 px-1 pb-1">
              <div className="relative flex-1">
                <Search size={11} className="absolute left-2 top-2 text-slate-600" />
                <input value={convQuery} onChange={e => setConvQuery(e.target.value)} placeholder="Search chats…" aria-label="Search conversations"
                  className="w-full bg-slate-800 border border-slate-700 rounded pl-6 pr-2 py-1 text-[11px] text-slate-300 placeholder-slate-600 focus:outline-none focus:border-indigo-500/60" />
              </div>
              <button onClick={() => setShowArchived(!showArchived)} title={showArchived ? 'Showing archived — click for active' : 'Show archived'} aria-label="Toggle archived"
                className={clsx('p-1 rounded', showArchived ? 'text-indigo-400 bg-indigo-600/20' : 'text-slate-600 hover:text-slate-300')}><Archive size={12} /></button>
            </div>
            {conversations.length === 0 && (
              <p className="text-slate-600 text-xs px-2 py-6 text-center">{convQuery ? 'No matching conversations' : showArchived ? 'No archived conversations' : 'Start a conversation above'}</p>
            )}
            {conversations.map((conv) => (
              <div
                key={conv.id}
                role="button" tabIndex={0} data-testid="conversation-item"
                onClick={() => setActiveConversation(conv.id)}
                onKeyDown={e => { if (e.key === 'Enter') setActiveConversation(conv.id); }}
                className={clsx(
                  'w-full text-left px-3 py-2 rounded-lg text-xs group relative transition-colors cursor-pointer',
                  activeConversationId === conv.id
                    ? 'bg-indigo-600/20 text-indigo-200 border border-indigo-600/20'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                )}
              >
                <div className="truncate pr-16 flex items-center gap-1">{conv.pinned ? <Pin size={9} className="text-indigo-400 flex-shrink-0" /> : null}<span className="truncate">{conv.title}</span></div>
                {conv.scope !== 'global' && (
                  <div className="text-[10px] text-slate-600 capitalize mt-0.5">{conv.scope.replace('_', '+')}</div>
                )}
                <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 text-slate-600 transition-opacity">
                  <button aria-label="Pin conversation" title={conv.pinned ? 'Unpin' : 'Pin'} onClick={e => patchConversation(e, conv, { pinned: conv.pinned ? 0 : 1 })} className="hover:text-indigo-400"><Pin size={10} /></button>
                  <button aria-label="Rename conversation" title="Rename" onClick={e => renameConversation(e, conv)} className="hover:text-slate-200"><Pencil size={10} /></button>
                  <button aria-label={conv.archived ? 'Restore conversation' : 'Archive conversation'} title={conv.archived ? 'Restore' : 'Archive'} onClick={e => patchConversation(e, conv, { archived: conv.archived ? 0 : 1 })} className="hover:text-slate-200">{conv.archived ? <ArchiveRestore size={10} /> : <Archive size={10} />}</button>
                  <button aria-label="Delete conversation" title="Delete" onClick={e => deleteConversation(e, conv.id)} className="hover:text-red-400"><X size={10} /></button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Projects */}
        {sidebarSection === 'projects' && (
          <div className="p-2">
            <button
              onClick={() => setShowProjectCreate(true)}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-indigo-400 hover:bg-slate-800 rounded-lg mb-1 transition-colors"
            >
              <Plus size={11} /> New Project
            </button>
            {projects.length === 0 && (
              <p className="text-slate-600 text-xs px-2 py-4 text-center">No projects yet</p>
            )}
            {projects.map((p) => (
              <button
                key={p.id}
                onClick={() => setActiveProject(activeProjectId === p.id ? null : p.id)}
                className={clsx(
                  'w-full text-left px-3 py-2 rounded-lg text-xs mb-0.5 transition-colors',
                  activeProjectId === p.id
                    ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-600/20'
                    : 'text-slate-400 hover:bg-slate-800'
                )}
              >
                <div className="flex items-center justify-between gap-1"><div className="truncate font-medium">{p.name}</div>
                  <span role="button" tabIndex={0} aria-label={`Overview of ${p.name}`} data-testid={`overview-${p.id}`} title="Project overview" onClick={(e) => { e.stopPropagation(); onShowProject(p.id); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onShowProject(p.id); } }} className="text-[10px] text-slate-500 hover:text-indigo-300 px-1">Overview</span></div>
                <div className="text-[10px] text-slate-600 capitalize mt-0.5">{p.category} · {p.status}</div>
              </button>
            ))}
          </div>
        )}

        {/* People */}
        {sidebarSection === 'people' && (
          <div className="p-2">
            <button
              onClick={() => setShowPersonCreate(true)}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-indigo-400 hover:bg-slate-800 rounded-lg mb-1 transition-colors"
            >
              <Plus size={11} /> New Person
            </button>
            {people.length === 0 && (
              <p className="text-slate-600 text-xs px-2 py-4 text-center">No people yet</p>
            )}
            {people.map((p) => (
              <button
                key={p.id}
                onClick={() => setActivePerson(activePersonId === p.id ? null : p.id)}
                className={clsx(
                  'w-full text-left px-3 py-2 rounded-lg text-xs mb-0.5 transition-colors',
                  activePersonId === p.id
                    ? 'bg-purple-600/20 text-purple-300 border border-purple-600/20'
                    : 'text-slate-400 hover:bg-slate-800'
                )}
              >
                <div className="truncate font-medium">{p.display_name}</div>
                <div className="text-[10px] text-slate-600 capitalize mt-0.5">{p.role || p.relationship}</div>
              </button>
            ))}
          </div>
        )}

        {/* Memory */}
        {sidebarSection === 'memory' && (
          <div className="p-3">
            <div className="text-xs text-slate-400 font-medium mb-2">MemoryVault</div>
            <input
              className="w-full px-2 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-indigo-500"
              placeholder="Search memory..."
            />
            <p className="text-xs text-slate-600 mt-3 leading-relaxed">
              Memories are saved automatically from conversations. Use the chat to query them.
            </p>
          </div>
        )}

        {/* Tasks */}
        {sidebarSection === 'tasks' && (
          <div className="p-3">
            <div className="text-xs text-slate-400 font-medium mb-2">Tasks</div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Tasks are created from conversations and linked to projects or people.
            </p>
          </div>
        )}
      </div>

      {/* Footer tools */}
      <div className="p-2 border-t border-slate-800 space-y-0.5">
        <button onClick={onShowKnowledge}
          className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-slate-600 hover:text-indigo-400 rounded-lg transition-colors">
          <Lightbulb size={11} /> Engineering Knowledge
        </button>
        <button onClick={onShowLinkVault}
          className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-slate-600 hover:text-indigo-400 rounded-lg transition-colors">
          <Link size={11} /> Link Vault
        </button>
        <button onClick={onShowImport} data-testid="open-import"
          className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-slate-600 hover:text-indigo-400 rounded-lg transition-colors">
          <Download size={11} /> Import chats
        </button>
        <button onClick={onShowSettings} data-testid="open-settings" className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-slate-600 hover:text-indigo-400 rounded-lg transition-colors">
          <Settings size={11} /> Settings
        </button>
      </div>

      {showProjectCreate && <ProjectCreate onClose={() => setShowProjectCreate(false)} />}
      {showPersonCreate && <PersonCreate onClose={() => setShowPersonCreate(false)} />}
    </div>
  );
}
