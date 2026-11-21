import React, { useState, useEffect } from 'react';
import { Link, Search, Sparkles, Github, X, ExternalLink } from 'lucide-react';
import { apiFetch } from '../api/client';
import clsx from 'clsx';

interface LinkItem {
  id: number; url: string; platform: string; title: string;
  summary: string; note: string; category: string; tags: string;
  status: string; ai_classification?: string;
}
interface LVStatus { available: boolean; total_links?: number; path: string; }

export default function LinkVaultPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<LVStatus | null>(null);
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [aiLinks, setAiLinks] = useState<LinkItem[]>([]);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'all' | 'ai'>('ai');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiFetch<LVStatus>('/api/linkvault/status').then(setStatus).catch(() => {});
    loadAi();
  }, []);

  const loadAi = async () => {
    setLoading(true);
    const data = await apiFetch<{ items: LinkItem[] }>('/api/linkvault/ai-content?limit=50').catch(() => ({ items: [] }));
    setAiLinks(data.items);
    setLoading(false);
  };

  const search = async () => {
    setLoading(true);
    const data = await apiFetch<{ total: number; items: LinkItem[] }>(`/api/linkvault/links?q=${encodeURIComponent(q)}&limit=50`).catch(() => ({ total: 0, items: [] }));
    setLinks(data.items);
    setTab('all');
    setLoading(false);
  };

  const displayed = tab === 'ai' ? aiLinks : links;

  const classColor = (c?: string) => {
    if (!c) return 'text-slate-500';
    if (c === 'github-repository') return 'text-indigo-400';
    if (c === 'mcp-server') return 'text-purple-400';
    if (c === 'ai-agent') return 'text-blue-400';
    if (c === 'local-model') return 'text-green-400';
    return 'text-slate-400';
  };

  return (
    <div className="fixed inset-y-0 right-0 w-96 bg-slate-900 border-l border-slate-700 flex flex-col z-40 shadow-2xl">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <Link size={14} className="text-indigo-400" />
          <span className="font-semibold text-sm text-slate-100">Link Vault</span>
          {status?.total_links != null && (
            <span className="text-[10px] text-slate-600">{status.total_links} links</span>
          )}
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X size={14} /></button>
      </div>

      {!status?.available && (
        <div className="p-4 text-xs text-yellow-400/80 bg-yellow-900/10 border-b border-yellow-900/20">
          Link Vault database not found at: <code className="text-[10px]">{status?.path}</code>
        </div>
      )}

      <div className="px-4 py-2 border-b border-slate-700">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={11} className="absolute left-2.5 top-2.5 text-slate-600" />
            <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-7 pr-3 py-2 text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-indigo-500"
              placeholder="Search saved links…" />
          </div>
          <button onClick={search} className="px-3 py-2 bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-700 rounded-lg text-xs">Search</button>
        </div>
      </div>

      <div className="flex border-b border-slate-700">
        <button onClick={() => setTab('ai')}
          className={clsx('flex-1 py-2 text-xs flex items-center justify-center gap-1.5', tab === 'ai' ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-slate-500')}>
          <Sparkles size={11} /> AI Content
        </button>
        <button onClick={() => setTab('all')}
          className={clsx('flex-1 py-2 text-xs flex items-center justify-center gap-1.5', tab === 'all' ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-slate-500')}>
          <Link size={11} /> All Links
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2">
        {loading && <div className="text-center py-8 text-slate-600 text-xs">Loading…</div>}
        {!loading && displayed.length === 0 && (
          <div className="text-center py-8 text-slate-700 text-xs">
            {tab === 'ai' ? 'No AI-related links found in Link Vault.' : 'Search to find links.'}
          </div>
        )}
        {!loading && displayed.map((item) => (
          <div key={item.id} className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-3 group">
            <div className="flex items-start justify-between gap-2 mb-1">
              <div className="flex items-center gap-1.5 min-w-0">
                {item.url.includes('github.com') && <Github size={10} className="text-slate-500 flex-shrink-0" />}
                <span className="text-xs font-medium text-slate-200 truncate">{item.title || item.url}</span>
              </div>
              <a href={item.url} target="_blank" rel="noopener noreferrer"
                className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-indigo-400 flex-shrink-0">
                <ExternalLink size={10} />
              </a>
            </div>
            {item.summary && <p className="text-xs text-slate-500 leading-relaxed line-clamp-2 mb-1.5">{item.summary}</p>}
            {item.note && <p className="text-xs text-slate-600 italic line-clamp-1">"{item.note}"</p>}
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-[9px] text-slate-700">{item.platform}</span>
              {item.ai_classification && (
                <span className={clsx('text-[9px]', classColor(item.ai_classification))}>
                  {item.ai_classification.replace(/-/g, ' ')}
                </span>
              )}
              <span className="text-[9px] text-slate-700 ml-auto">{item.category}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
