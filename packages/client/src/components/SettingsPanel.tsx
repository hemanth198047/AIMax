import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, Settings as SettingsIcon, RefreshCw, Copy, LogIn, LogOut } from 'lucide-react';
import { apiFetch } from '../api/client';

interface Account {
  id: 'claude' | 'cursor' | 'openai'; label: string; app: string; blurb: string; adapter: 'ready' | 'not-built';
  installed: boolean; path: string | null; version: string; installHint: string; loginSupported: boolean; statusSupported: boolean;
  signedIn: boolean | null; statusText: string; how: string; method: Method; lastRun: { apiKeySource: string; at: string } | null; loginCommand: string; logoutCommand: string; hint: string;
}
interface Method { kind: 'subscription' | 'api' | 'unknown'; label: string; evidence: string; account: string; fields: { key: string; value: string }[] }
interface Accounts { accounts: Account[]; warnings: string[]; info: { dataDir: string; platform: string; node: string; claudeBin: string | null } }
interface OpenResult { opened: boolean; command: string; note: string }

/** Settings: sign-in with your own Claude / Cursor / ChatGPT subscription through the vendors' official CLIs (no API keys). */
const FIX: Record<Account['id'], string> = {
  claude: 'Click Sign out, then Sign in, and in the browser choose "Claude account with subscription" (Pro / Max) — not "Anthropic Console account".',
  openai: 'Click Sign out, then Sign in, and choose "Sign in with ChatGPT" — not "Use an API key".',
  cursor: 'Click Sign out, then Sign in with your Cursor account in the browser — not an API key.',
};

/** The one thing you need to know about each account: HOW you are signed in, and what that means for billing. */
function MethodBox({ a }: { a: Account }) {
  const m = a.method;
  const out = a.signedIn === false;
  const tone = out ? 'border-slate-600 bg-slate-800/60' : m.kind === 'subscription' ? 'border-emerald-600 bg-emerald-950/40' : m.kind === 'api' ? 'border-red-600 bg-red-950/40' : 'border-yellow-600 bg-yellow-950/30';
  const details = `${a.lastRun ? `Last run apiKeySource: ${a.lastRun.apiKeySource}\n` : ''}${a.label}\nSigned in: ${a.signedIn}\nMethod: ${m.kind} — ${m.label}\nBased on: ${m.evidence}\n--- CLI output ---\n${a.statusText}`;
  return (
    <div className={`border-l-4 rounded p-3 space-y-1 ${tone}`} data-testid={`method-${a.id}`} data-kind={out ? 'signed-out' : m.kind}>
      {out && <div className="text-sm font-semibold text-slate-200">Not signed in</div>}
      {!out && m.kind === 'subscription' && <>
        <div className="text-sm font-semibold text-emerald-300">✓ Signed in with your SUBSCRIPTION</div>
        <div className="text-slate-200">{m.label}{m.account ? ` · ${m.account}` : ''}</div>
        <div className="text-slate-400">Usage counts against your plan. No API credits are used, so "credit balance too low" will not come from this login.</div>
      </>}
      {!out && m.kind === 'api' && <>
        <div className="text-sm font-semibold text-red-300">⚠ Signed in with an API KEY / CONSOLE — not your subscription</div>
        <div className="text-slate-200">{m.label}{m.account ? ` · ${m.account}` : ''}</div>
        <div className="text-slate-300">This bills pay-per-use API credits. A Pro/Max plan has none, which is why you see "credit balance too low".</div>
        <div className="text-red-200"><b>Fix:</b> {FIX[a.id]}</div>
      </>}
      {!out && m.kind === 'unknown' && <>
        <div className="text-sm font-semibold text-yellow-300">? Signed in, but this tool does not say how</div>
        <div className="text-slate-300">{m.label}{m.account ? ` · ${m.account}` : ''}. AImax will not guess. Open "What the tool reported" below; if it names an API key or Console, sign out and in again with your subscription.</div>
      </>}
      {out && <div className="text-slate-400">Click Sign in below.</div>}
      {m.evidence && !out && <div className="text-slate-500">Based on: {m.evidence}</div>}
      {a.lastRun && (
        <div className="text-slate-400" data-testid={`lastrun-${a.id}`}>
          Last chat through AImax ({new Date(a.lastRun.at).toLocaleString()}): Claude itself reported <code className="text-slate-200">apiKeySource = {a.lastRun.apiKeySource}</code>
          {a.lastRun.apiKeySource === 'none' ? ' — no API key was used for that chat.' : ' — an API key was used for that chat, not a subscription login.'}
        </div>
      )}
      <details className="text-slate-500">
        <summary className="cursor-pointer hover:text-slate-300">What the tool reported</summary>
        {m.fields.length > 0 && <table className="mt-1 w-full"><tbody>{m.fields.map(f => <tr key={f.key} className="border-t border-slate-800"><td className="pr-3 py-0.5 text-slate-500 whitespace-nowrap">{f.key}</td><td className="text-slate-300 break-all">{f.value}</td></tr>)}</tbody></table>}
        <pre className="bg-slate-950 rounded p-2 mt-1 text-slate-400 whitespace-pre-wrap max-h-40 overflow-y-auto">{a.statusText || '(no output)'}</pre>
        <button onClick={() => void navigator.clipboard?.writeText(details)} className="mt-1 text-indigo-400 hover:underline">Copy these details</button>
      </details>
    </div>
  );
}

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<Accounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [opened, setOpened] = useState<Record<string, OpenResult>>({});
  const [watching, setWatching] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setBusy(true); setErr('');
    try { setData(await apiFetch<Accounts>('/api/accounts')); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); return () => { if (timer.current) clearInterval(timer.current); }; }, [load]);

  const act = async (id: string, action: 'login' | 'logout') => {
    setErr('');
    try {
      const r = await apiFetch<OpenResult>(`/api/accounts/${id}/terminal`, { method: 'POST', headers: { 'X-AImax-UI': '1' }, body: JSON.stringify({ action }) });
      setOpened(o => ({ ...o, [id]: r }));
      // The sign-in finishes in the other window, so re-check every 6 s for up to 3 minutes.
      if (timer.current) clearInterval(timer.current); setWatching(id); let n = 0;
      timer.current = setInterval(() => { void load(); if (++n >= 30 && timer.current) { clearInterval(timer.current); setWatching(null); } }, 6000);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const badge = (a: Account) => !a.installed ? ['Not installed', 'bg-slate-700 text-slate-300']
    : a.signedIn === false ? ['Not signed in', 'bg-slate-600 text-slate-100']
    : a.method.kind === 'subscription' ? ['Subscription', 'bg-emerald-700 text-emerald-100']
    : a.method.kind === 'api' ? ['API key / Console', 'bg-red-700 text-red-100']
    : a.signedIn === true ? ['Signed in · method unknown', 'bg-yellow-700 text-yellow-100'] : ['Status unknown', 'bg-slate-700 text-slate-300'];
  const copy = (t: string) => void navigator.clipboard?.writeText(t).catch(() => undefined);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" data-testid="settings-panel">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-2xl max-h-[88vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <h2 className="text-sm font-semibold flex items-center gap-2"><SettingsIcon size={14} /> Settings</h2>
          <div className="flex items-center gap-2">
            <button onClick={() => void load()} disabled={busy} aria-label="Refresh status" className="text-slate-500 hover:text-slate-200 disabled:opacity-40"><RefreshCw size={14} className={busy ? 'animate-spin' : ''} /></button>
            <button onClick={onClose} aria-label="Close settings" className="text-slate-500 hover:text-slate-200"><X size={16} /></button>
          </div>
        </div>
        <div className="px-4 py-3 space-y-4 overflow-y-auto text-xs">
          <section className="space-y-2">
            <h3 className="text-[10px] uppercase tracking-wider text-slate-500">Accounts — sign in with your subscription</h3>
            <p className="text-slate-500">Signing in works like the Claude, Cursor and ChatGPT apps: a browser window opens and you log in with your own account. AImax never sees your password or token — the official command-line tool of each service stores the login. No API keys needed.</p>
            {data?.warnings.map((w, i) => <div key={i} className="border-l-2 border-yellow-500 pl-2 text-yellow-300" data-testid="settings-warning">{w}</div>)}
            {err && <div className="text-red-400" data-testid="settings-error">{err}</div>}
            {!data && !err && <div className="text-slate-500">Checking…</div>}
            {data?.accounts.map(a => {
              const [label, cls] = badge(a); const o = opened[a.id];
              return (
                <div key={a.id} className="border border-slate-800 rounded-lg p-3 space-y-2" data-testid={`account-${a.id}`}>
                  <div className="flex items-center justify-between">
                    <div><b className="text-slate-200">{a.label}</b> <span className="text-slate-600">· {a.app}</span></div>
                    <span className={`px-2 py-0.5 rounded text-[10px] ${cls}`} data-testid={`account-${a.id}-state`}>{label}</span>
                  </div>
                  <div className="text-slate-500">{a.blurb}</div>
                  {a.adapter === 'not-built' && <div className="text-yellow-500">Sign-in only: AImax cannot use this account for chat yet.</div>}
                  {a.installed
                    ? <div className="text-slate-600">{a.version || 'installed'} · {a.path}</div>
                    : <div className="text-slate-400">{a.installHint}</div>}
                  {a.installed && <MethodBox a={a} />}
                  {a.hint && a.installed && <div className="text-yellow-500">{a.hint}</div>}
                  {a.installed && (
                    <div className="flex flex-wrap items-center gap-2">
                      <button onClick={() => void act(a.id, 'login')} data-testid={`signin-${a.id}`} className="flex items-center gap-1 px-3 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-500"><LogIn size={12} /> {a.signedIn ? 'Sign in again' : 'Sign in'}</button>
                      {a.loginSupported && <button onClick={() => void act(a.id, 'logout')} className="flex items-center gap-1 px-3 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700"><LogOut size={12} /> Sign out</button>}
                      <span className="text-slate-600">or run <code className="text-slate-400">{a.loginCommand}</code> yourself</span>
                      <button onClick={() => copy(a.loginCommand)} aria-label={`Copy ${a.id} sign-in command`} className="text-slate-500 hover:text-slate-200"><Copy size={11} /></button>
                    </div>
                  )}
                  {o && <div className={o.opened ? 'text-emerald-400' : 'text-yellow-400'} data-testid={`opened-${a.id}`}>{o.note} <code className="text-slate-400">{o.command}</code>{watching === a.id ? ' — checking every few seconds…' : ''}</div>}
                </div>
              );
            })}
          </section>
          {data && (
            <section className="space-y-1">
              <h3 className="text-[10px] uppercase tracking-wider text-slate-500">This computer</h3>
              <div className="text-slate-500">Data folder: <code className="text-slate-400">{data.info.dataDir}</code></div>
              <div className="text-slate-500">{data.info.platform} · Node {data.info.node}{data.info.claudeBin ? <> · Claude CLI: <code className="text-slate-400">{data.info.claudeBin}</code></> : ''}</div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
