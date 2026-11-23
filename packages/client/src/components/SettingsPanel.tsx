import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, Settings as SettingsIcon, RefreshCw, Copy, LogIn, LogOut } from 'lucide-react';
import { apiFetch } from '../api/client';

interface Account {
  id: 'claude' | 'cursor' | 'openai'; label: string; app: string; blurb: string; adapter: 'ready' | 'not-built';
  installed: boolean; path: string | null; version: string; installHint: string; loginSupported: boolean; statusSupported: boolean;
  signedIn: boolean | null; statusText: string; how: string; method: Method; lastRun: { apiKeySource: string; at: string } | null; installCommand: string | null; installDoc: string | null; desktopApp: string | null; searched?: { names: string[]; dirs: string[] }; loginCommand: string; logoutCommand: string; hint: string;
}
interface Method { kind: 'subscription' | 'api' | 'unknown'; label: string; evidence: string; account: string; override?: string; fields: { key: string; value: string }[] }
interface Accounts { accounts: Account[]; warnings: string[]; apiKeyFix: string; info: { dataDir: string; platform: string; node: string; claudeBin: string | null } }
interface OpenResult { opened: boolean; command: string; note: string }

/** Settings: sign-in with your own Claude / Cursor / ChatGPT subscription through the vendors' official CLIs (no API keys). */
const FIX: Record<Account['id'], string> = {
  claude: 'Click Sign out, then Sign in, and in the browser choose "Claude account with subscription" (Pro / Max) — not "Anthropic Console account".',
  openai: 'Click Sign out, then Sign in, and choose "Sign in with ChatGPT" — not "Use an API key".',
  cursor: 'Click Sign out, then Sign in with your Cursor account in the browser — not an API key.',
};

/** Shown when a service's command-line tool is missing: why it is needed, the official installer, and what to do afterwards. */
function NotInstalled({ a, onInstall, copy, recheck }: { a: Account; onInstall: () => void; copy: (t: string) => void; recheck: () => void }) {
  return (
    <div className="border border-slate-700 rounded p-3 space-y-2 bg-slate-950/40" data-testid={`install-${a.id}`}>
      {a.id === 'cursor' && (
        <div className="text-slate-300 space-y-1">
          <div>{a.desktopApp ? <>✓ The <b>Cursor desktop app</b> is on this computer (<span className="text-slate-500">{a.desktopApp}</span>).</> : 'The Cursor desktop app was not found here.'}</div>
          <div className="text-yellow-300">But the desktop app cannot be controlled by other programs — it has no way to receive a message from AImax and send back an answer. Cursor's official way in for tools like AImax is its separate <b>Cursor CLI</b>. It signs in with the same Cursor account through your browser — no API key.</div>
        </div>
      )}
      {a.id !== 'cursor' && <div className="text-slate-300">{a.installHint}</div>}
      {a.installCommand && (
        <>
          <div className="text-slate-400">Official installer{a.id === 'cursor' ? ' (PowerShell on Windows)' : ''}:</div>
          <div className="flex items-start gap-2"><code className="flex-1 bg-slate-950 rounded p-2 text-slate-200 break-all">{a.installCommand}</code>
            <button onClick={() => copy(a.installCommand!)} aria-label={`Copy ${a.id} install command`} className="text-slate-500 hover:text-slate-200 mt-2"><Copy size={12} /></button></div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={onInstall} data-testid={`install-btn-${a.id}`} className="px-3 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-500">Open a terminal and install</button>
            {a.installDoc && <a href={a.installDoc} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">Official instructions</a>}
          </div>
          <div className="text-slate-500">After it finishes, click <b>Re-check</b> below — AImax re-reads your computer's PATH, so no restart is needed.</div>
        </>
      )}
      <div className="flex items-center gap-2"><button onClick={recheck} data-testid={`recheck-${a.id}`} className="px-3 py-1 rounded border border-slate-600 text-slate-200 hover:bg-slate-800">Re-check</button></div>
      {a.searched && (
        <details className="text-slate-500" data-testid={`searched-${a.id}`}>
          <summary className="cursor-pointer">Where AImax looked (for names: {a.searched.names.join(', ')})</summary>
          <ul className="mt-1 max-h-40 overflow-auto font-mono break-all">{a.searched.dirs.map((d) => <li key={d}>{d}</li>)}</ul>
          <div className="mt-1">Still failing? In PowerShell run <code>where.exe agent</code>, <code>where.exe cursor-agent</code> and <code>dir $env:LOCALAPPDATA\cursor-agent</code>.</div>
        </details>
      )}
    </div>
  );
}

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
        {m.override
          ? <div className="text-red-300">⚠ But {m.override}, so this environment bills API credits instead of your plan.</div>
          : <div className="text-slate-400">Usage counts against your plan. No API credits are used, so "credit balance too low" will not come from this login.</div>}
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

interface Conn { links: { enabled: boolean }; freellmapi: { url: string; model: string; keySet: boolean; reachable: boolean; models: string[]; error: string; note: string }; ollama: { running: boolean; url: string; models: string[]; selected: string; successfulChats: number; lastUsed: string | null; note: string }; linkvault: { found: boolean; path: string; links: number | null; error: string; usedByChat: boolean; note: string } }
function FreeCard({ f, reload, setErr }: { f: Conn['freellmapi']; reload: () => Promise<void>; setErr: (s: string) => void }) {
  const [url, setUrl] = useState(f.url); const [key, setKey] = useState(''); const [model, setModel] = useState(f.model);
  const save = async () => {
    setErr('');
    try { await apiFetch('/api/connections/freellmapi', { method: 'PUT', headers: { 'X-AImax-UI': '1' }, body: JSON.stringify({ url, model, ...(key ? { key } : {}) }) }); setKey(''); await reload(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const inp = 'w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200';
  return (
    <div className="border border-slate-800 rounded-lg p-3 space-y-2" data-testid="conn-freellmapi">
      <div><Dot ok={f.reachable && !f.error && f.keySet} /><b className="text-slate-200">FreeLLMAPI</b> <span className="text-slate-600">· self-hosted free-tier gateway</span></div>
      <div className="text-slate-400">{f.note}</div>
      <div className="grid grid-cols-[5rem_1fr] gap-2 items-center">
        <label htmlFor="fl-url">Base URL</label><input id="fl-url" className={inp} value={url} onChange={(e) => setUrl(e.target.value)} />
        <label htmlFor="fl-key">Unified key</label><input id="fl-key" type="password" autoComplete="off" className={inp} value={key} placeholder={f.keySet ? 'saved (type to replace)' : 'freellmapi-…'} onChange={(e) => setKey(e.target.value)} />
        <label htmlFor="fl-model">Model</label><input id="fl-model" className={inp} value={model} list="fl-models" onChange={(e) => setModel(e.target.value)} /><datalist id="fl-models">{['auto', ...f.models].map((m) => <option key={m} value={m} />)}</datalist>
      </div>
      <div className="flex items-center gap-2"><button onClick={() => void save()} data-testid="fl-save" className="px-3 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-500">Save</button>
        <span className="text-slate-500">The key is stored on this computer only and never shown again. It is FreeLLMAPI's own key from its dashboard, not a vendor API key. Free tiers behind it may log prompts, so it is used only when you pick it.</span></div>
    </div>
  );
}
function Dot({ ok }: { ok: boolean }) { return <span className={`inline-block w-2 h-2 rounded-full mr-1 ${ok ? 'bg-emerald-400' : 'bg-red-400'}`} />; }

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [conn, setConn] = useState<Conn | null>(null);
  const [forgot, setForgot] = useState('');
  const [data, setData] = useState<Accounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [opened, setOpened] = useState<Record<string, OpenResult>>({});
  const [watching, setWatching] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setBusy(true); setErr('');
    try { setData(await apiFetch<Accounts>('/api/accounts')); apiFetch<Conn>('/api/connections').then(setConn).catch(() => undefined); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); return () => { if (timer.current) clearInterval(timer.current); }; }, [load]);

  const act = async (id: string, action: 'login' | 'logout' | 'install') => {
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
          <section className="space-y-2" data-testid="connections">
            <h3 className="text-[10px] uppercase tracking-wider text-slate-500">Local connections</h3>
            {!conn ? <div className="text-slate-500">Checking…</div> : <>
              <div className="border border-slate-800 rounded-lg p-3 space-y-1" data-testid="conn-links">
                <label className="flex items-start gap-2 text-slate-300"><input type="checkbox" data-testid="links-toggle" checked={conn.links.enabled} onChange={async (e) => { try { await apiFetch('/api/connections/links', { method: 'PUT', headers: { 'X-AImax-UI': '1' }, body: JSON.stringify({ enabled: e.target.checked }) }); setConn(await apiFetch<Conn>('/api/connections')); } catch (x) { setErr(x instanceof Error ? x.message : String(x)); } }} />
                  <span><b className="text-slate-200">Read links I paste</b> — up to 3 public web pages or PDFs per message are downloaded by this computer and added to the message as reference text, so they are sent to whichever provider answers. Private/internal addresses, logins and cookies are never used.</span></label>
              </div>
              <div className="border border-slate-800 rounded-lg p-3 space-y-1" data-testid="conn-browser">
                <b className="text-slate-200">Pages you pasted from sign-in sites</b>
                <div className="text-slate-400">When a link needs a login, you open it in your own browser, copy the page (Ctrl+A, Ctrl+C) and paste it into AImax. AImax controls no browser and never sees a login. Pasted pages are kept on this computer for 24 hours.</div>
                <button data-testid="forget-signins" onClick={async () => { try { const r = await apiFetch<{ removedCapturedPages: number }>('/api/web/captures', { method: 'DELETE', headers: { 'X-AImax-UI': '1' } }); setErr(''); setForgot(r.removedCapturedPages ? `Done: ${r.removedCapturedPages} pasted page(s) deleted.` : 'Nothing was saved.'); } catch (x) { setErr(x instanceof Error ? x.message : String(x)); } }} className="px-3 py-1 rounded border border-slate-600 text-slate-200 hover:bg-slate-800">Delete pasted pages now</button>
                {forgot && <div className="text-emerald-300" data-testid="forgot-msg">{forgot}</div>}
              </div>
              <FreeCard f={conn.freellmapi} reload={async () => setConn(await apiFetch<Conn>('/api/connections'))} setErr={setErr} />
              <div className="border border-slate-800 rounded-lg p-3 space-y-1" data-testid="conn-ollama">
                <div><Dot ok={conn.ollama.running} /><b className="text-slate-200">Ollama</b> <span className="text-slate-600">· {conn.ollama.url}</span></div>
                <div className="text-slate-400">{conn.ollama.note}</div>
                {conn.ollama.running && <div className="text-slate-500">Models: {conn.ollama.models.join(', ') || 'none pulled'} · selected: {conn.ollama.selected || '—'} · successful chats: {conn.ollama.successfulChats}</div>}
              </div>
              <div className="border border-slate-800 rounded-lg p-3 space-y-1" data-testid="conn-linkvault">
                <div><Dot ok={conn.linkvault.found && !conn.linkvault.error} /><b className="text-slate-200">Link Vault</b>{conn.linkvault.links !== null && <span className="text-slate-500"> · {conn.linkvault.links} links</span>}</div>
                <div className="text-slate-400">{conn.linkvault.note}</div>
                {conn.linkvault.found && !conn.linkvault.error && (
                  <label className="flex items-start gap-2 text-slate-300"><input type="checkbox" data-testid="linkvault-toggle" checked={conn.linkvault.usedByChat} onChange={async (e) => { try { await apiFetch('/api/connections/linkvault', { method: 'PUT', headers: { 'X-AImax-UI': '1' }, body: JSON.stringify({ enabled: e.target.checked }) }); setConn(await apiFetch<Conn>('/api/connections')); } catch (x) { setErr(x instanceof Error ? x.message : String(x)); } }} />
                    <span>Let chats search my Link Vault. Matching titles, links and short summaries are added to the message, so they are sent to whichever provider answers (Claude, Ollama…). Transcripts are never read.</span></label>)}
                <div className="text-slate-600 break-all">{conn.linkvault.path}{conn.linkvault.error ? ` — ${conn.linkvault.error}` : ''}</div>
              </div>
            </>}
          </section>
          <section className="space-y-2">
            <h3 className="text-[10px] uppercase tracking-wider text-slate-500">Accounts — sign in with your subscription</h3>
            <p className="text-slate-500">Signing in works like the Claude, Cursor and ChatGPT apps: a browser window opens and you log in with your own account. AImax never sees your password or token — the official command-line tool of each service stores the login. No API keys needed.</p>
            {data?.warnings.map((w, i) => <div key={i} className="border-l-2 border-yellow-500 pl-2 text-yellow-300" data-testid="settings-warning">{w}</div>)}
            {data?.apiKeyFix && (
              <details className="border-l-2 border-yellow-500 pl-2 text-slate-400" data-testid="apikey-fix">
                <summary className="cursor-pointer text-yellow-300 hover:text-yellow-200">How to remove ANTHROPIC_API_KEY from your computer (so the claude command in your own terminal uses your subscription too)</summary>
                <div className="mt-1">{data.apiKeyFix}</div>
              </details>
            )}
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
                    : <NotInstalled a={a} onInstall={() => void act(a.id, 'install')} copy={copy} recheck={() => void load()} />}
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
