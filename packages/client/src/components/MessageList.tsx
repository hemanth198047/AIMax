import React, { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, User } from 'lucide-react';
import type { Message } from '../api/client';
import RunProposal from './RunProposal';
import EditProposal from './EditProposal';
import clsx from 'clsx';
import CopyButton from './CopyButton';

interface Props {
  messages: Message[];
  streaming: boolean;
  streamingText: string;
}

export default function MessageList({ messages, streaming, streamingText }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll ONLY this list. (scrollIntoView also scrolls every ancestor, even overflow:hidden ones, which pushed the whole app up and left blank space at the bottom.)
  useEffect(() => {
    const el = listRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages.length, streamingText]);

  return (
    <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-4 py-4 space-y-5">
      {messages.map((msg, i) => <MessageBubble key={msg.id} message={msg} isLast={i === messages.length - 1 && !streaming} />)}
      {streaming && (
        <div className="flex gap-3">
          <div className="w-7 h-7 bg-indigo-600 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
            <Bot size={13} />
          </div>
          <div className="flex-1 bg-slate-800/60 rounded-2xl rounded-tl-none px-4 py-3 text-sm text-slate-200 max-w-[85%]">
            {streamingText
              ? <MarkdownContent content={streamingText} />
              : (
                <div className="flex gap-1 items-center h-5 py-1">
                  {[0, 150, 300].map(d => (
                    <span key={d} className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce"
                      style={{ animationDelay: `${d}ms` }} />
                  ))}
                </div>
              )
            }
          </div>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message, isLast }: { message: Message; isLast: boolean }) {
  const isUser = message.role === 'user';
  return (
    <div className={clsx('flex gap-3', isUser && 'flex-row-reverse')} data-testid={`msg-${message.role}`}>
      <div className={clsx(
        'w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 text-white',
        isUser ? 'bg-slate-600' : 'bg-indigo-600'
      )}>
        {isUser ? <User size={13} /> : <Bot size={13} />}
      </div>
      <div className={clsx('group flex flex-col max-w-[85%] min-w-0', isUser ? 'items-end' : 'items-start')}>
        <div className={clsx(
          'rounded-2xl px-4 py-3 text-sm max-w-full',
          isUser
            ? 'bg-indigo-600 text-white rounded-tr-none'
            : 'bg-slate-800/60 text-slate-200 rounded-tl-none border border-slate-700/50'
        )}>
          {isUser && <AttachmentChips raw={message.attachments} />}
          {isUser
            ? <p className="whitespace-pre-wrap leading-relaxed">{message.content}</p>
            : <MarkdownContent content={message.content} />
          }
          {message.provider && message.provider !== 'error' && (
            <div className="text-[10px] opacity-40 mt-1.5">{message.provider}{message.model ? ` · ${message.model}` : ''}</div>
          )}
        </div>
        {/* Copies the message's own text (Markdown source for answers), like the Claude app. Shown on hover/focus, always on the newest message. */}
        <div className={clsx('mt-1 px-1 transition-opacity focus-within:opacity-100', isLast ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>
          <CopyButton getText={() => message.content} label="Copy message" testId="copy-message" className="p-1 hover:bg-slate-800" />
        </div>
      </div>
    </div>
  );
}

function AttachmentChips({ raw }: { raw: string }) {
  let items: { id: string; filename: string; extracted?: boolean }[] = [];
  try { items = JSON.parse(raw || '[]'); } catch { /* ignore */ }
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1 mb-2" data-testid="message-attachments">
      {items.map(a => <span key={a.id} className="px-2 py-0.5 bg-indigo-800/60 rounded-full text-[11px]">📎 {a.filename}{a.extracted === false ? ' (not read)' : ''}</span>)}
    </div>
  );
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: ({ children }) => <>{children}</>,
        code({ children, className }) {
          if (className === 'language-aimax-edit') return <EditProposal edits={String(children).replace(/\n$/, '')} />;
          if (className === 'language-aimax-run') return <RunProposal command={String(children).replace(/\n$/, '')} />;
          if (!className) {
            return <code className="bg-slate-700/60 px-1.5 py-0.5 rounded text-xs font-mono text-indigo-300">{children}</code>;
          }
          const code = String(children).replace(/\n$/, '');
          const lang = (className ?? '').replace(/^language-/, '');
          return (
            <div className="my-2 rounded-lg border border-slate-700 bg-slate-900 overflow-hidden" data-testid="code-block">
              <div className="flex items-center justify-between px-3 py-1 bg-slate-800/70 border-b border-slate-700">
                <span className="text-[11px] text-slate-400 font-mono">{lang}</span>
                <CopyButton getText={() => code} label="Copy" variant="text" testId="copy-code" className="px-1.5 py-0.5 hover:bg-slate-700" />
              </div>
              <pre className="p-3 overflow-x-auto"><code className="text-xs font-mono text-slate-300 leading-relaxed">{children}</code></pre>
            </div>
          );
        },
        p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
        ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-0.5 text-slate-300">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-0.5 text-slate-300">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        h1: ({ children }) => <h1 className="text-lg font-bold mb-2 text-slate-100">{children}</h1>,
        h2: ({ children }) => <h2 className="text-base font-semibold mb-2 text-slate-100">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-semibold mb-1 text-slate-200">{children}</h3>,
        blockquote: ({ children }) => <blockquote className="border-l-2 border-indigo-500 pl-3 text-slate-400 italic mb-2">{children}</blockquote>,
        table: ({ children }) => <div className="overflow-x-auto mb-2"><table className="w-full text-xs border-collapse">{children}</table></div>,
        th: ({ children }) => <th className="border border-slate-700 px-2 py-1 bg-slate-800 text-left font-medium">{children}</th>,
        td: ({ children }) => <td className="border border-slate-700 px-2 py-1">{children}</td>,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">{children}</a>,
        hr: () => <hr className="border-slate-700 my-3" />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
