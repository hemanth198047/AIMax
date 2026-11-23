import { useState } from 'react';
import { apiFetch } from '../api/client';
import { useSignIn } from '../stores/signinStore';

const H = { 'X-AImax-UI': '1' };

/**
 * Shown when a pasted link needs a login. No browser automation: the user opens the page in THEIR OWN browser (where they are already signed in),
 * copies the text (Ctrl+A, Ctrl+C) and pastes it here. AImax never touches a login and only stores what the user pastes.
 */
export default function SignInBanner() {
  const { pending, setPending, setResend } = useSignIn();
  const [step, setStep] = useState<'start' | 'paste' | 'done'>('start'); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(''); const [chars, setChars] = useState(0); const [manual, setManual] = useState('');
  if (!pending || pending.urls.length === 0) return null;
  const url = pending.urls[0]; let host = url; try { host = new URL(url).hostname; } catch { /* keep raw */ }
  const send = async (text: string) => { const r = await apiFetch<{ chars: number }>('/api/web/capture', { method: 'POST', headers: H, body: JSON.stringify({ url, text }) }); setChars(r.chars); setStep('done'); setManual(''); };
  const call = async (fn: () => Promise<void>) => { setBusy(true); setMsg(''); try { await fn(); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const openPage = () => { window.open(url, '_blank', 'noopener'); setStep('paste'); };
  const paste = () => call(async () => {
    let text = ''; try { text = await navigator.clipboard.readText(); } catch { throw new Error('The browser did not allow reading the clipboard. Paste the text into the box below instead (Ctrl+V), then click "Use pasted text".'); }
    await send(text);
  });
  const dismiss = () => { setPending(null); setStep('start'); setMsg(''); };
  const resend = () => { const m = pending.message; setPending(null); setStep('start'); setResend(m); };
  const btn = 'px-3 py-1 rounded text-xs disabled:opacity-40';
  return (
    <div className="mb-2 border border-amber-500/40 bg-amber-500/10 rounded-lg p-3 text-xs text-slate-200 space-y-2" role="region" aria-label="Sign-in needed" data-testid="signin-banner">
      <div><b>{host}</b> needs a sign-in, so AImax cannot read it by itself. Use your own browser, where you are probably already signed in — AImax never touches your login.</div>
      {step === 'start' && <div className="flex gap-2"><button onClick={openPage} data-testid="signin-open" className={`${btn} bg-indigo-600 text-white hover:bg-indigo-500`}>Open the page in my browser</button><button onClick={dismiss} className={`${btn} border border-slate-600`}>Not now</button></div>}
      {step === 'paste' && <>
        <ol className="list-decimal ml-4 text-slate-300"><li>In the tab that opened, sign in if asked and wait for the page to load.</li><li>Click in the page, press <b>Ctrl+A</b> then <b>Ctrl+C</b> (select all, copy).</li><li>Come back here and click <b>Paste copied page</b>.</li></ol>
        <div className="flex gap-2"><button onClick={() => void paste()} disabled={busy} data-testid="signin-read" className={`${btn} bg-indigo-600 text-white hover:bg-indigo-500`}>{busy ? 'Reading…' : 'Paste copied page'}</button><button onClick={openPage} className={`${btn} border border-slate-600`}>Open the page again</button><button onClick={dismiss} className={`${btn} border border-slate-600`}>Cancel</button></div>
        <details open={!!msg} className="text-slate-400"><summary className="cursor-pointer">Clipboard not working? Paste the text here</summary>
          <textarea value={manual} onChange={(e) => setManual(e.target.value)} rows={3} aria-label="Pasted page text" className="w-full mt-1 bg-slate-950 border border-slate-700 rounded p-2 text-slate-200" />
          <button onClick={() => void call(() => send(manual))} disabled={busy || manual.trim().length < 40} data-testid="signin-manual" className={`${btn} border border-slate-600 mt-1`}>Use pasted text</button></details></>}
      {step === 'done' && <>
        <div className="text-emerald-300" data-testid="signin-captured">Got it: {chars.toLocaleString()} characters from {host}. Kept on this computer for 24 hours.</div>
        <div className="flex gap-2"><button onClick={resend} data-testid="signin-resend" className={`${btn} bg-indigo-600 text-white hover:bg-indigo-500`}>Re-send my message</button><button onClick={dismiss} className={`${btn} border border-slate-600`}>Close</button></div></>}
      {msg && <div className="text-red-300" data-testid="signin-error">{msg}</div>}
    </div>
  );
}
