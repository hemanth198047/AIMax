import { useState } from 'react';
import { ctxQs } from '../api/conversations';
import React, { useEffect } from 'react';
import { Sparkles, FolderOpen, User } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { useChatStore } from '../stores/chatStore';
import MessageList from './MessageList';
import MessageInput from './MessageInput';
import { apiFetch } from '../api/client';
import type { Message } from '../api/client';

export default function ChatView() {
  const { activeConversationId, scope, activeProjectId, activePersonId, projects, people } = useAppStore();
  const { messages, setMessages, streaming, streamingText, streamingConvId, activity } = useChatStore();

  const [handoff, setHandoff] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { setHandoff(null); setCopied(false); }, [activeConversationId]);
  const openHandoff = async () => {
    if (!activeConversationId) return;
    try { setHandoff((await apiFetch<{ markdown: string }>(`/api/conversations/${activeConversationId}/handoff${ctxQs()}`)).markdown); }
    catch (e) { setHandoff(`Could not build handoff: ${e instanceof Error ? e.message : e}`); }
  };

  useEffect(() => {
    if (!activeConversationId) return;
    apiFetch<Message[]>(`/api/conversations/${activeConversationId}/messages${ctxQs()}`)
      .then(msgs => setMessages(activeConversationId, msgs))
      .catch(console.error);
  }, [activeConversationId]);

  const currentMessages = activeConversationId ? (messages[activeConversationId] || []) : [];
  const isStreaming = streaming && streamingConvId === activeConversationId;
  const activeProject = projects.find(p => p.id === activeProjectId);
  const activePerson = people.find(p => p.id === activePersonId);

  if (!activeConversationId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-8 p-8 text-center">
        <div className="space-y-3">
          <div className="w-16 h-16 bg-indigo-600/20 rounded-2xl flex items-center justify-center mx-auto">
            <Sparkles size={28} className="text-indigo-400" />
          </div>
          <h1 className="text-3xl font-bold text-slate-100">AImax</h1>
          <p className="text-slate-400">Maximum Intelligence. Minimum Waste.</p>
          <p className="text-slate-600 text-sm">One Memory. Multiple AI Assistants. Continuous Improvement.</p>
        </div>

        <div className="grid grid-cols-2 gap-3 max-w-sm w-full text-left">
          {[
            { icon: '💬', title: 'Start a conversation', desc: 'Click "New Conversation" to begin' },
            { icon: '📁', title: 'Create a project', desc: 'Organize work with project contexts' },
            { icon: '👤', title: 'Add a person', desc: 'Track contacts and collaborators' },
            { icon: '🧠', title: 'Build memory', desc: 'AImax learns from your conversations' },
          ].map(item => (
            <div key={item.title} className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-3">
              <div className="text-lg mb-1">{item.icon}</div>
              <div className="text-xs font-medium text-slate-300 mb-0.5">{item.title}</div>
              <div className="text-[11px] text-slate-600">{item.desc}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full min-h-0">
      {/* Context bar */}
      {(activeProject || activePerson) && (
        <div className="flex items-center gap-2 px-4 py-2 bg-slate-800/30 border-b border-slate-700/40 text-xs flex-shrink-0">
          <span className="text-slate-600">Context:</span>
          {activeProject && (
            <span className="flex items-center gap-1 px-2 py-0.5 bg-indigo-600/15 text-indigo-300 rounded-full border border-indigo-600/20">
              <FolderOpen size={9} /> {activeProject.name}
            </span>
          )}
          {activePerson && (
            <span className="flex items-center gap-1 px-2 py-0.5 bg-purple-600/15 text-purple-300 rounded-full border border-purple-600/20">
              <User size={9} /> {activePerson.display_name}
            </span>
          )}
          <span className="ml-auto text-slate-700 capitalize text-[10px]">{scope.replace('_', ' + ')}</span>
        </div>
      )}

      <div className="flex items-center justify-end px-4 py-1 border-b border-slate-800/60 flex-shrink-0">
        <button onClick={() => handoff === null ? openHandoff() : setHandoff(null)} className="text-[10px] text-slate-600 hover:text-slate-300" aria-label="Toggle handoff summary">
          {handoff === null ? 'Handoff summary' : 'Hide handoff'}
        </button>
      </div>
      {handoff !== null && (
        <div className="px-4 py-2 border-b border-slate-800 bg-slate-900/60 flex-shrink-0" data-testid="handoff">
          <textarea readOnly value={handoff} rows={8} aria-label="Handoff summary text" className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-[11px] font-mono text-slate-300" />
          <button onClick={() => { void navigator.clipboard?.writeText(handoff).then(() => setCopied(true)); }} className="mt-1 px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-[11px] text-white">{copied ? 'Copied' : 'Copy'}</button>
        </div>
      )}
      <MessageList
        messages={currentMessages}
        streaming={isStreaming}
        streamingText={isStreaming ? streamingText : ''}
      />
      {activity.length > 0 && (
        <div className="px-4 py-1.5 border-t border-slate-800 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-600" data-testid="activity">
          {activity.map((a, i) => (
            <span key={i} className={a.step === 'error' ? 'text-red-400' : ''}><span className="text-slate-500">{a.step}</span> · {a.detail}</span>
          ))}
        </div>
      )}
      <MessageInput conversationId={activeConversationId} />
    </div>
  );
}
