import React, { useState, useRef, useCallback } from 'react';
import { Send, Paperclip, Square, X } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { useChatStore } from '../stores/chatStore';
import { apiFetch } from '../api/client';
import type { Message, Conversation, UploadedAttachment } from '../api/client';

interface Props { conversationId: string; }

export default function MessageInput({ conversationId }: Props) {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [uploadError, setUploadError] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { provider, activeProjectId, activePersonId, scope, setConversations, conversations, setActiveConversation } = useAppStore();
  const { addMessage, setStreaming, appendStreamingText, clearStreaming, streaming } = useChatStore();

  const uploadFiles = async (files: File[]) => {
    setUploadError('');
    for (const f of files) {
      const fd = new FormData(); fd.append('file', f, f.name || 'pasted-file');
      try {
        const res = await fetch('/api/attachments/upload', { method: 'POST', body: fd });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? res.statusText);
        setAttachments(a => [...a, j as UploadedAttachment]);
      } catch (e) { setUploadError(`${f.name}: ${e instanceof Error ? e.message : 'upload failed'}`); }
    }
  };

  const adjustHeight = () => {
    const t = textareaRef.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 180) + 'px';
  };

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    const sentAttachments = attachments;
    setInput(''); setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    // Optimistic user message
    const tempId = `temp-${Date.now()}`;
    addMessage(conversationId, {
      id: tempId, conversation_id: conversationId, role: 'user',
      content: text, attachments: JSON.stringify(sentAttachments.map(a => ({ id: a.id, filename: a.filename, size: a.size, extracted: a.extracted }))), provider: '', model: '', tokens_used: 0,
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
          scope,
          attachmentIds: sentAttachments.map(a => a.id)
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
  }, [input, attachments, conversationId, provider, activeProjectId, activePersonId, scope, streaming]);

  return (
    <div className="border-t border-slate-700/50 bg-slate-900/80 backdrop-blur p-3"
      onDragOver={e => e.preventDefault()}
      onDrop={e => { e.preventDefault(); const fs = Array.from(e.dataTransfer.files); if (fs.length) uploadFiles(fs); }}>
      {(attachments.length > 0 || uploadError) && (
        <div className="flex flex-wrap gap-1.5 mb-2" data-testid="attachment-chips">
          {attachments.map(a => (
            <span key={a.id} title={a.extracted ? (a.preview || a.filename) : (a.note ?? 'Not readable locally')}
              className="flex items-center gap-1 px-2 py-0.5 bg-slate-800 border border-slate-700 rounded-full text-[11px] text-slate-300">
              {a.filename}
              {!a.extracted && <span className="text-yellow-600">· not readable</span>}
              <button onClick={() => setAttachments(x => x.filter(y => y.id !== a.id))} className="text-slate-500 hover:text-red-400" aria-label={`Remove ${a.filename}`}><X size={10} /></button>
            </span>
          ))}
          {uploadError && <span className="text-[11px] text-red-400">{uploadError}</span>}
        </div>
      )}
      <div className="flex gap-2 items-end">
        <label className="flex-shrink-0 p-2 text-slate-600 hover:text-slate-400 cursor-pointer transition-colors" title="Attach file">
          <Paperclip size={15} />
          <input type="file" multiple className="hidden" data-testid="file-input"
            onChange={e => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; if (fs.length) uploadFiles(fs); }} />
        </label>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => { setInput(e.target.value); adjustHeight(); }}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
          }}
          onPaste={e => { const fs = Array.from(e.clipboardData.files); if (fs.length) { e.preventDefault(); uploadFiles(fs); } }}
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
