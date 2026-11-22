import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { apiFetch } from '../api/client';

interface Overview {
  project: { id: string; name: string; description?: string; status?: string; category?: string };
  counts: { conversations: number; messages: number; memory: number; decisions: number };
  tasks: { status: string; n: number }[];
  openTasks: { id: string; title: string; priority: string; status: string; due_date: string }[];
  people: { id: string; name: string; role: string }[];
  recentConversations: { id: string; title: string; provider: string; updated_at: string }[];
  recentDecisions: { id: string; title: string; status: string }[];
  tokens30d: { provider: string; requests: number; tokensIn: number; tokensOut: number }[];
}
const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/** One-screen summary of a project. Token counts are provider-reported where available, otherwise estimated (~4 chars/token). */
export default function ProjectOverview({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [o, setO] = useState<Overview | null>(null); const [err, setErr] = useState('');
  useEffect(() => { apiFetch<Overview>(`/api/projects/${projectId}/overview`).then(setO).catch((e) => setErr(e instanceof Error ? e.message : String(e))); }, [projectId]);
  const Box = ({ label, value }: { label: string; value: number }) => <div className="border border-slate-800 rounded-lg p-3 text-center"><div className="text-lg text-slate-100">{value}</div><div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div></div>;
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" role="dialog" aria-label="Project overview" data-testid="project-overview">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800"><h2 className="text-sm font-semibold text-slate-100">{o?.project.name ?? 'Project'} — overview</h2><button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-white"><X size={16} /></button></div>
        <div className="p-4 space-y-4 overflow-y-auto text-xs text-slate-300">
          {err && <div className="text-red-400">{err}</div>}{!o && !err && <div className="text-slate-500">Loading…</div>}
          {o && <>
            {o.project.description && <p className="text-slate-400">{o.project.description}</p>}
            <div className="grid grid-cols-4 gap-2"><Box label="Chats" value={o.counts.conversations} /><Box label="Messages" value={o.counts.messages} /><Box label="Memory" value={o.counts.memory} /><Box label="Decisions" value={o.counts.decisions} /></div>
            <section><h3 className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Open tasks ({o.openTasks.length})</h3>
              {o.openTasks.length === 0 ? <div className="text-slate-600">None</div> : o.openTasks.map((t) => <div key={t.id} className="py-0.5"><span className="text-slate-500">[{t.priority}]</span> {t.title}{t.due_date ? <span className="text-slate-500"> · due {t.due_date}</span> : null}</div>)}</section>
            <section><h3 className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">People</h3>{o.people.length === 0 ? <div className="text-slate-600">None linked</div> : o.people.map((p) => <div key={p.id}>{p.name} <span className="text-slate-500">· {p.role}</span></div>)}</section>
            <section><h3 className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Recent chats</h3>{o.recentConversations.length === 0 ? <div className="text-slate-600">None</div> : o.recentConversations.map((c) => <div key={c.id} className="truncate">{c.title} <span className="text-slate-500">· {c.provider} · {new Date(c.updated_at).toLocaleDateString()}</span></div>)}</section>
            <section><h3 className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Recent decisions</h3>{o.recentDecisions.length === 0 ? <div className="text-slate-600">None</div> : o.recentDecisions.map((d) => <div key={d.id} className="truncate">{d.title} <span className="text-slate-500">· {d.status}</span></div>)}</section>
            <section><h3 className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Tokens, last 30 days (this project)</h3>{o.tokens30d.length === 0 ? <div className="text-slate-600">No usage recorded</div> : o.tokens30d.map((t) => <div key={t.provider}>{t.provider}: {t.requests} requests · {fmt(t.tokensIn)} in / {fmt(t.tokensOut)} out</div>)}<div className="text-slate-600 mt-1">Provider-reported where available, otherwise estimated (~4 characters per token).</div></section>
          </>}
        </div>
      </div>
    </div>
  );
}
