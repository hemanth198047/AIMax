import { useState } from 'react';
import { apiFetch } from '../api/client';
import { useSignIn } from '../stores/signinStore';

const H = { 'X-AImax-UI': '1' };

/** Shown when a pasted link needs a login: opens AImax's own browser window, lets the user sign in, then reads the page they choose. */
export default function SignInBanner() {
  const { pending, setPending, setResend } = useSignIn();
  const [step, setStep] = useState<'start' | 'open' | 'done'>('start'); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(''); const [captured, setCaptured] = useState('');
  if (!pending || pending.urls.length === 0) return null;
  const url = pending.urls[0]; let host = url; try { host = new URL(url).hostname; } catch { /* keep raw */ }
  const call = async (fn: () => Promise<void>) => { setBusy(true); setMsg(''); try { await fn(); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const open = () => call(async () => { await apiFetch('/api/web/signin', { method: 'POST', headers: H, body: JSON.stringify({ url }) }); setStep('open'); });
  const read = () => call(async () => { const r = await apiFetch<{ title: string; chars: number }>('/api/web/signin/capture', { method: 'POST', headers: H, body: JSON.stringify({ url }) }); setCaptured(`${r.title || host} (${r.chars.toLocaleString()} characters)`); setStep('done'); });
  const close = async () => { try { await apiFetch('/api/web/signin', { method: 'DELETE', headers: H }); } catch { /* already closed */ } setPending(null); setStep('start'); setMsg(''); };
  const resend = async () => { try { await apiFetch('/api/web/signin', { method: 'DELETE', headers: H }); } catch { /* ignore */ } const m = pending.message; setPending(null); setStep('start'); setResend(m); };
  const btn = 'px-3 py-1 rounded text-xs disabled:opacity-40';
  return (
    <div className="mb-2 border border-amber-500/40 bg-amber-500/10 rounded-lg p-3 text-xs text-slate-200 space-y-2" role="region" aria-label="Sign-in needed" data-testid="signin-banner">
      <div><b>{host}</b> needs you to sign in before AImax can read it. AImax opens its own browser window — you type your password into the site, never into AImax.</div>
      {step === 'start' && <div className="flex gap-2"><button onClick={() => void open()} disabled={busy} data-testid="signin-open" className={`${btn} bg-indigo-600 text-white hover:bg-indigo-500`}>{busy ? 'Opening…' : 'Open browser to sign in'}</button><button onClick={() => void close()} className={`${btn} border border-slate-600`}>Not now</button></div>}
      {step === 'open' && <>
        <ol className="list-decimal ml-4 text-slate-300"><li>In the window that just opened, sign in.</li><li>Open the page you want AImax to read (it should already be there).</li><li>Wait for it to finish loading, then click <b>Read this page</b>.</li></ol>
        <div className="flex gap-2"><button onClick={() => void read()} disabled={busy} data-testid="signin-read" className={`${btn} bg-indigo-600 text-white hover:bg-indigo-500`}>{busy ? 'Reading…' : 'Read this page'}</button><button onClick={() => void open()} disabled={busy} className={`${btn} border border-slate-600`}>Re-open window</button><button onClick={() => void close()} className={`${btn} border border-slate-600`}>Cancel</button></div></>}
      {step === 'done' && <>
        <div className="text-emerald-300" data-testid="signin-captured">Read {captured}. It is kept on this computer for 24 hours.</div>
        <div className="flex gap-2"><button onClick={() => void resend()} data-testid="signin-resend" className={`${btn} bg-indigo-600 text-white hover:bg-indigo-500`}>Re-send my message</button><button onClick={() => void close()} className={`${btn} border border-slate-600`}>Close</button></div></>}
      {msg && <div className="text-red-300" data-testid="signin-error">{msg}</div>}
    </div>
  );
}
