import { useCallback, useEffect, useRef, useState } from 'react';
import { X, FileText, Link2, StickyNote, Trash2, Plus } from 'lucide-react';
import { apiFetch } from '../api/client';
import { useAppStore } from '../stores/appStore';
import { loadConversations } from '../api/conversations';
import type { Conversation } from '../api/client';

interface KItem { id: string; kind: 'file' | 'note' | 'link'; title: string; source: string; chars: number }
interface Knowledge { items: KItem[]; usedChars: number; capChars: number }

interface Overview {
  project: { id: string; name: string; description?: string; status?: string; category?: string; instructions?: string };
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
  const [k, setK] = useState<Knowledge | null>(null); const [instr, setInstr] = useState(''); const [instrSaved, setInstrSaved] = useState(true);
  const [note, setNote] = useState(''); const [noteTitle, setNoteTitle] = useState(''); const [url, setUrl] = useState(''); const [busy, setBusy] = useState(''); const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null); const [signedIn, setSignedIn] = useState(false);
  const { setActiveProject, setActivePerson, setActiveConversation, setConversations, conversations } = useAppStore();
  const loadK = useCallback(() => apiFetch<Knowledge>(`/api/projects/${projectId}/knowledge`).then(setK).catch(() => undefined), [projectId]);
  useEffect(() => { apiFetch<Overview>(`/api/projects/${projectId}/overview`).then((x) => { setO(x); setInstr(x.project.instructions ?? ''); }).catch((e) => setErr(e instanceof Error ? e.message : String(e))); void loadK(); }, [projectId, loadK]);
  const run = async (what: string, fn: () => Promise<unknown>) => { setBusy(what); setMsg(''); try { await fn(); await loadK(); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); } };
  const saveInstr = () => run('instr', async () => { await apiFetch(`/api/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ instructions: instr }) }); setInstrSaved(true); setMsg('Instructions saved.'); });
  const upload = (files: FileList | null) => { if (!files) return; void run('file', async () => { for (const f of Array.from(files)) { const fd = new FormData(); fd.append('file', f, f.name); const r = await fetch(`/api/projects/${projectId}/knowledge/file`, { method: 'POST', body: fd }); const j = await r.json(); if (!r.ok) throw new Error(`${f.name}: ${j.error ?? r.statusText}`); if (j.note) setMsg(`${f.name}: ${j.note}`); } if (fileRef.current) fileRef.current.value = ''; }); };
  const newChat = async () => {
    setActivePerson(null); setActiveProject(projectId);
    const conv = await apiFetch<Conversation>('/api/conversations', { method: 'POST', body: JSON.stringify({ title: 'New Conversation', scope: 'project', project_id: projectId, person_id: null }) });
    setConversations([conv, ...conversations]); setActiveConversation(conv.id); await loadConversations().catch(() => undefined); onClose();
  };
  const openChat = (id: string) => { setActivePerson(null); setActiveProject(projectId); setActiveConversation(id); onClose(); };
  const pct = k ? Math.min(100, Math.round((k.usedChars / k.capChars) * 100)) : 0;
  const Icon = ({ kind }: { kind: KItem['kind'] }) => (kind === 'file' ? <FileText size={12} /> : kind === 'link' ? <Link2 size={12} /> : <StickyNote size={12} />);
  const Box = ({ label, value }: { label: string; value: number }) => <div className="border border-slate-800 rounded-lg p-3 text-center"><div className="text-lg text-slate-100">{value}</div><div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div></div>;
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" role="dialog" aria-label="Project overview" data-testid="project-overview">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800"><h2 className="text-sm font-semibold text-slate-100">{o?.project.name ?? 'Project'} — overview</h2><button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-white"><X size={16} /></button></div>
        <div className="p-4 space-y-4 overflow-y-auto text-xs text-slate-300">
          {err && <div className="text-red-400">{err}</div>}{!o && !err && <div className="text-slate-500">Loading…</div>}
          {o && <>
            {o.project.description && <p className="text-slate-400">{o.project.description}</p>}
            <button onClick={() => void newChat()} data-testid="project-new-chat" className="px-3 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-500 flex items-center gap-1"><Plus size={12} /> New chat in this project</button>
            <section data-testid="project-instructions"><h3 className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Instructions for every chat in this project</h3>
              <textarea value={instr} onChange={(e) => { setInstr(e.target.value); setInstrSaved(false); }} rows={4} aria-label="Project instructions" placeholder="e.g. Answer as a senior Python reviewer. Prefer small, tested changes." className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-slate-200" />
              <div className="flex items-center gap-2 mt-1"><button onClick={() => void saveInstr()} disabled={instrSaved || busy === 'instr'} data-testid="save-instructions" className="px-3 py-1 rounded border border-slate-600 hover:bg-slate-800 disabled:opacity-40">Save instructions</button><span className="text-slate-600">Added to the system prompt of every chat in this project.</span></div></section>
            <section data-testid="project-knowledge"><h3 className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Project knowledge</h3>
              <div className="h-1.5 bg-slate-800 rounded overflow-hidden" aria-label="Knowledge capacity"><div className={pct > 90 ? 'h-full bg-red-500' : 'h-full bg-indigo-500'} style={{ width: `${pct}%` }} /></div>
              <div className="text-slate-500 mt-0.5">{k ? `${pct}% of capacity used (${k.usedChars.toLocaleString()} of ${k.capChars.toLocaleString()} characters)` : '…'} · only text is stored; chats use the parts relevant to each message.</div>
              <div className="mt-2 space-y-1">{k?.items.length === 0 && <div className="text-slate-600">Nothing added yet. Add files, notes or web pages so every chat here can use them.</div>}
                {k?.items.map((i) => <div key={i.id} className="flex items-center gap-2 border border-slate-800 rounded px-2 py-1" data-testid="knowledge-item"><span className="text-slate-500"><Icon kind={i.kind} /></span><span className="truncate flex-1" title={i.source || i.title}>{i.title}</span><span className="text-slate-600">{i.chars.toLocaleString()} chars</span>
                  <button aria-label={`Remove ${i.title}`} onClick={() => void run('del', () => apiFetch(`/api/projects/${projectId}/knowledge/${i.id}`, { method: 'DELETE' }))} className="text-slate-500 hover:text-red-400"><Trash2 size={12} /></button></div>)}</div>
              <div className="mt-2 flex flex-wrap gap-2 items-center">
                <input ref={fileRef} type="file" multiple hidden data-testid="knowledge-file" onChange={(e) => upload(e.target.files)} />
                <button onClick={() => fileRef.current?.click()} disabled={!!busy} className="px-3 py-1 rounded border border-slate-600 hover:bg-slate-800">{busy === 'file' ? 'Adding…' : 'Add files'}</button>
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… web page or PDF" aria-label="Link to add" className="flex-1 min-w-[10rem] bg-slate-950 border border-slate-700 rounded px-2 py-1" />
                <button onClick={() => void run('link', async () => { await apiFetch(`/api/projects/${projectId}/knowledge/link`, { method: 'POST', body: JSON.stringify({ url }) }); setUrl(''); })} disabled={!url.trim() || !!busy} className="px-3 py-1 rounded border border-slate-600 hover:bg-slate-800 disabled:opacity-40">{busy === 'link' ? 'Reading…' : 'Add link'}</button></div>
              <div className="mt-2 space-y-1"><input value={noteTitle} onChange={(e) => setNoteTitle(e.target.value)} placeholder="Note title (optional)" aria-label="Note title" className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1" />
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Paste or write text, such as a chat handoff summary, requirements or notes" aria-label="Note text" className="w-full bg-slate-950 border border-slate-700 rounded p-2" />
                <button onClick={() => void run('note', async () => { await apiFetch(`/api/projects/${projectId}/knowledge/note`, { method: 'POST', body: JSON.stringify({ title: noteTitle, text: note }) }); setNote(''); setNoteTitle(''); })} disabled={!note.trim() || !!busy} data-testid="add-note" className="px-3 py-1 rounded border border-slate-600 hover:bg-slate-800 disabled:opacity-40">Add note</button></div>
              {msg && <div className="mt-1 text-amber-300" data-testid="knowledge-msg">{msg}</div>}
              {/Paste copied page|needs a sign-in|private to your account/.test(msg) && url.trim() && <div className="mt-1 space-y-1"><span className="text-slate-400">Needs a login? </span><button className="text-indigo-300 underline" data-testid="knowledge-signin" onClick={() => { window.open(url, '_blank', 'noopener'); setSignedIn(true); }}>Open the page in my browser</button>{signedIn && <><span className="text-slate-400"> · there press Ctrl+A, Ctrl+C, then </span><button className="text-indigo-300 underline" data-testid="knowledge-capture" onClick={() => void run('cap', async () => { let text = ''; try { text = await navigator.clipboard.readText(); } catch { throw new Error('The browser did not allow reading the clipboard; use the note box below to paste the text instead.'); } await apiFetch('/api/web/capture', { method: 'POST', headers: { 'X-AImax-UI': '1' }, body: JSON.stringify({ url, text }) }); await apiFetch(`/api/projects/${projectId}/knowledge/link`, { method: 'POST', body: JSON.stringify({ url }) }); setUrl(''); setSignedIn(false); setMsg('Page added to project knowledge.'); })}>Paste copied page and add it</button></>}</div>}
              </section>
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
