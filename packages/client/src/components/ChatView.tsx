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
  const { messages, setMessages, streaming, streamingText, streamingConvId } = useChatStore();

  useEffect(() => {
    if (!activeConversationId) return;
    apiFetch<Message[]>(`/api/conversations/${activeConversationId}/messages`)
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

      <MessageList
        messages={currentMessages}
        streaming={isStreaming}
        streamingText={isStreaming ? streamingText : ''}
      />
      <MessageInput conversationId={activeConversationId} />
    </div>
  );
}
