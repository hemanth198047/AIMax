import React, { useState, useRef, useCallback } from 'react';
import { Send, Paperclip, Square } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { useChatStore } from '../stores/chatStore';
import { apiFetch } from '../api/client';
import type { Message, Conversation } from '../api/client';

interface Props { conversationId: string; }

export default function MessageInput({ conversationId }: Props) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { provider, activeProjectId, activePersonId, scope, setConversations, conversations, setActiveConversation } = useAppStore();
  const { addMessage, setStreaming, appendStreamingText, clearStreaming, streaming } = useChatStore();

  const adjustHeight = () => {
    const t = textareaRef.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 180) + 'px';
  };

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    // Optimistic user message
    const tempId = `temp-${Date.now()}`;
    addMessage(conversationId, {
      id: tempId, conversation_id: conversationId, role: 'user',
      content: text, attachments: '[]', provider: '', model: '', tokens_used: 0,
      created_at: new Date().toISOString()
    });

    setStreaming(true, conversationId);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          message: text,
          projectId: activeProjectId,
          personId: activePersonId,
          provider,
          scope
        }),
        signal: ctrl.signal
      });

      if (!res.ok || !res.body) throw new Error('Stream failed');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6)) as {
              text?: string; conversationId?: string; messageId?: string;
              provider?: string; message?: string;
            };
            if (data.text) appendStreamingText(data.text);
          } catch { /* skip */ }
        }
      }

      // Reload messages after streaming completes
      const msgs = await apiFetch<Message[]>(`/api/conversations/${conversationId}/messages`);
      useChatStore.getState().setMessages(conversationId, msgs);

      // Refresh conversation list
      const convs = await apiFetch<Conversation[]>('/api/conversations');
      setConversations(convs);

    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Chat error:', err);
      }
    } finally {
      clearStreaming();
      abortRef.current = null;
    }
  }, [input, conversationId, provider, activeProjectId, activePersonId, scope, streaming]);

  return (
    <div className="border-t border-slate-700/50 bg-slate-900/80 backdrop-blur p-3">
      <div className="flex gap-2 items-end">
        <label className="flex-shrink-0 p-2 text-slate-600 hover:text-slate-400 cursor-pointer transition-colors" title="Attach file">
          <Paperclip size={15} />
          <input type="file" multiple className="hidden" />
        </label>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => { setInput(e.target.value); adjustHeight(); }}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
          }}
          placeholder="Message AImax…  (Shift+Enter for new line)"
          rows={1}
          className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500/60 resize-none leading-relaxed"
          style={{ maxHeight: '180px' }}
        />
        {streaming ? (
          <button
            onClick={() => { abortRef.current?.abort(); clearStreaming(); }}
            className="flex-shrink-0 p-2.5 bg-red-600/80 hover:bg-red-600 rounded-xl transition-colors text-white"
            title="Stop"
          >
            <Square size={15} />
          </button>
        ) : (
          <button
            onClick={sendMessage}
            disabled={!input.trim()}
            className="flex-shrink-0 p-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed rounded-xl transition-colors text-white"
            title="Send"
          >
            <Send size={15} />
          </button>
        )}
      </div>
      <div className="flex justify-between items-center mt-1.5 px-1">
        <span className="text-[10px] text-slate-700">Enter to send · Shift+Enter for newline</span>
        <span className="text-[10px] text-slate-700 capitalize">{provider}</span>
      </div>
    </div>
  );
}
