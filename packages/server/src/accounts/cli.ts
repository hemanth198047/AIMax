/**
 * Subscription sign-in through the vendors' OFFICIAL CLIs (Claude Code, Cursor Agent, OpenAI Codex).
 *
 * AImax never implements a vendor's login, never sees a password/token and never reads credential files: it only
 *  - asks the CLI for its own status (`<cli> … status`), and
 *  - opens a terminal window on this computer that runs the CLI's own login (a browser sign-in with your subscription account).
 * The subcommand names below are from memory of those CLIs and are PROBED at runtime (`<login command> --help`); where a CLI does not
 * have them AImax says so and shows what to type instead. Nothing here has been run against the real CLIs.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { claudeChildEnv, resolveClaudeBin } from '../providers/claude.js';
import { getSetting } from '../providers/usage.js';

const WIN = process.platform === 'win32';

export type AccountId = 'claude' | 'cursor' | 'openai';
export interface AccountDef {
  id: AccountId; label: string; app: string; bins: string[]; installHint: string;
  login: string[]; status: string[]; logout: string[];
  /** Official one-line installer, shown to the user and run in a visible terminal only when they click the button. */
  install?: { win: string; posix: string; doc: string };
  /** Can AImax actually chat through this provider yet? */
  adapter: 'ready' | 'not-built'; blurb: string;
}
export const ACCOUNTS: AccountDef[] = [
  { id: 'claude', label: 'Claude', app: 'claude.ai (Pro / Max subscription)', bins: [process.env.AIMAX_CLAUDE_BIN || 'claude'], installHint: 'Install Claude Code from https://claude.com/claude-code',
    login: ['auth', 'login'], status: ['auth', 'status'], logout: ['auth', 'logout'], adapter: 'ready',
    blurb: 'AImax chats through the Claude Code CLI, which uses your Claude subscription login — no API key.' },
  { id: 'cursor', label: 'Cursor', app: 'Cursor app account', bins: ['cursor-agent', 'agent'], installHint: 'Install the Cursor CLI (the Cursor desktop app cannot be controlled by other programs).',
    install: { win: "irm 'https://cursor.com/install?win32=true' | iex", posix: 'curl https://cursor.com/install -fsS | bash', doc: 'https://cursor.com/docs/cli/installation' },
    login: ['login'], status: ['status'], logout: ['logout'], adapter: 'not-built',
    blurb: 'Signs the Cursor CLI in with your Cursor account. AImax cannot chat through Cursor yet (adapter not built).' },
  { id: 'openai', label: 'OpenAI (ChatGPT / Codex)', app: 'ChatGPT account via the Codex CLI', bins: ['codex'], installHint: 'Install the Codex CLI: npm install -g @openai/codex',
    install: { win: 'npm install -g @openai/codex', posix: 'npm install -g @openai/codex', doc: 'https://github.com/openai/codex' },
    login: ['login'], status: ['login', 'status'], logout: ['logout'], adapter: 'not-built',
    blurb: 'Signs the Codex CLI in with your ChatGPT account. AImax cannot chat through Codex yet (adapter not built).' },
];

const quote = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

function findOnPath(name: string): string | null {
  const exts = WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  if (name.includes('/') || name.includes('\\')) return existsSync(name) ? name : null;
  const extra = [join(homedir(), '.local', 'bin'), ...(WIN && process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'cursor-agent'), join(process.env.LOCALAPPDATA, 'Programs', 'cursor-agent')] : [])];
  for (const d of [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...extra]) for (const e of exts) { const p = join(d, name + e); if (existsSync(p)) return p; }
  return null;
}
export function resolveBin(def: AccountDef): string | null {
  if (def.id === 'claude') { const r = resolveClaudeBin(); return r.file === 'claude' ? findOnPath('claude') : r.file; }
  for (const b of def.bins) { const p = findOnPath(b); if (p) return p; }
  return null;
}

export interface CliRun { code: number | null; out: string; timedOut: boolean }
/** Run a CLI with a fixed argument list; .cmd/.bat shims on Windows need a shell, so they get ONE command string (no user input in it). */
export function runCli(file: string, args: string[], timeoutMs = 8000, env?: NodeJS.ProcessEnv): CliRun {
  const shim = WIN && /\.(cmd|bat)$/i.test(file);
  const r = shim
    ? spawnSync([file, ...args].map(quote).join(' '), { shell: true, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env })
    : spawnSync(file, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim(), timedOut: r.error?.name === 'Error' && /ETIMEDOUT/.test(String((r.error as NodeJS.ErrnoException).code)) };
}

export interface SignInMethod {
  /** subscription = your Claude/ChatGPT/Cursor plan; api = pay-per-use API key / Console credits; unknown = the CLI did not say */
  kind: 'subscription' | 'api' | 'unknown';
  label: string;            // one plain sentence: what you are signed in with
  evidence: string;         // exactly what the CLI said that this is based on
  account: string;          // email / account name when the CLI reports one
  /** Non-empty when an API key from the environment OVERRIDES the stored login (so billing is the API, whatever you signed in with). */
  override?: string;
  fields: { key: string; value: string }[];   // everything the CLI reported, as a table
}
const classify = (v: string): 'subscription' | 'api' | null => {
  const sub = /claude[ _.-]?ai|chatgpt|subscription|\b(pro|max|plus|team|enterprise|free)\b|oauth|account login|cursor account/i.test(v);
  const api = /console|api[ _-]?key|apikey|pay[- ]?as[- ]?you[- ]?go/i.test(v);   // never the bare word "api": "API provider: Anthropic" says nothing about billing
  return sub && !api ? 'subscription' : api && !sub ? 'api' : null;
};
const pick = (o: Record<string, unknown>, names: string[]): string => { for (const n of names) { const k = Object.keys(o).find(x => x.toLowerCase().replace(/[_\-\s]/g, '') === n.toLowerCase().replace(/[_\-\s]/g, '')); if (k && o[k] !== null && o[k] !== undefined && o[k] !== '') return String(o[k]); } return ''; };

/** Work out HOW you are signed in from what the CLI itself printed. JSON output is read field by field (key names are never searched for words);
 *  plain text is only trusted for explicit wording. Anything else is reported as "unknown" — never guessed. */
export function parseSignInMethod(text: string, provider: AccountId): SignInMethod {
  const unknown = (fields: SignInMethod['fields'] = [], account = ''): SignInMethod => ({ kind: 'unknown', label: 'The CLI did not say how you are signed in', evidence: text ? 'its status output has no explicit sign-in method (shown below)' : 'it printed nothing', account, fields });
  const t = text.trim(); if (!t) return unknown();
  let obj: Record<string, unknown> | null = null;
  const m = t.match(/\{[\s\S]*\}/); if (m) { try { const j = JSON.parse(m[0]); if (j && typeof j === 'object' && !Array.isArray(j)) obj = j as Record<string, unknown>; } catch { /* not JSON */ } }
  if (obj) {
    const flat: Record<string, unknown> = {}; const walk = (o: Record<string, unknown>, pre = '') => { for (const [k, v] of Object.entries(o)) { if (v && typeof v === 'object' && !Array.isArray(v)) walk(v as Record<string, unknown>, pre + k + '.'); else flat[pre + k] = v; } }; walk(obj);
    const fields = Object.entries(flat).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([key, v]) => ({ key, value: String(v) }));
    const account = pick(flat, ['email', 'account', 'user', 'username']); const plan = pick(flat, ['subscriptionType', 'plan', 'subscription', 'tier']);
    const method = pick(flat, ['authMethod', 'loginMethod', 'method', 'authType']); const keySource = pick(flat, ['apiKeySource']);
    const kindFromMethod = method ? classify(method) : null;
    const override = keySource && !/^(none|null|false)$/i.test(keySource) ? `an API key from ${keySource} is set and takes priority over this login` : '';
    if (kindFromMethod === 'subscription' || (!method && plan)) return { kind: 'subscription', label: `${provider === 'claude' ? 'Claude' : provider === 'openai' ? 'ChatGPT' : 'Cursor'} subscription${plan ? ` (${plan})` : ''}`, evidence: method ? `the CLI reported authMethod = "${method}"${plan ? `, subscriptionType = "${plan}"` : ''}` : `the CLI reported a plan: "${plan}"`, account, fields, override };
    if (kindFromMethod === 'api') return { kind: 'api', label: 'API key / Console billing (pay-per-use credits)', evidence: `the CLI reported authMethod = "${method}"`, account, fields };
    if (!method && keySource && !/^(none|null|false)$/i.test(keySource)) return { kind: 'api', label: 'API key (pay-per-use credits)', evidence: `the CLI reported apiKeySource = "${keySource}"`, account, fields };
    return unknown(fields, account);
  }
  const fields = t.split(/\r?\n/).map(l => l.match(/^\s*([A-Za-z][A-Za-z ._-]{1,30}):\s*(.+)$/)).filter((x): x is RegExpMatchArray => !!x).map(x => ({ key: x[1].trim(), value: x[2].trim() }));
  const email = (t.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) ?? [''])[0];
  const line = t.split(/\r?\n/).find(l => /(login|auth(entication)?|sign[- ]?in) method\s*:/i.test(l)) ?? t.split(/\r?\n/).find(l => /logged in (using|with|via)\b/i.test(l));
  if (line) { const v = line.replace(/^.*?(method\s*:|logged in (using|with|via))/i, '').trim(); const k = classify(v); if (k) return { kind: k, label: k === 'subscription' ? `Subscription / account login (${v})` : `API key / Console billing (${v})`, evidence: `the CLI said: "${line.trim().slice(0, 120)}"`, account: email, fields }; }
  const k = classify(t);
  if (k === 'subscription' && /logged in|signed in/i.test(t)) return { kind: 'subscription', label: 'Subscription / account login', evidence: 'the CLI status mentions a subscription/account and no API key', account: email, fields };
  if (k === 'api' && /logged in|signed in/i.test(t)) return { kind: 'api', label: 'API key / Console billing (pay-per-use credits)', evidence: 'the CLI status mentions an API key or Console and no subscription', account: email, fields };
  return unknown(fields, email);
}

const NEGATIVE = /not (logged|signed)[ -]?in|logged out|signed out|no (active )?(session|account|credentials?|login)|unauthenticated|not authenticated|please (log|sign)[ -]?in|run .*login/i;
export interface AccountStatus {
  id: AccountId; label: string; app: string; blurb: string; adapter: 'ready' | 'not-built';
  installed: boolean; path: string | null; version: string; installHint: string;
  /** Does this CLI have the login/status subcommands we expect? (probed) */
  loginSupported: boolean; statusSupported: boolean;
  /** true / false from the CLI's own status command, null = cannot tell. HEURISTIC: based on exit code and wording. */
  signedIn: boolean | null; statusText: string; how: string;
  loginCommand: string; logoutCommand: string; hint: string;
  /** How you are signed in, taken from the CLI's own status output (see parseSignInMethod). */
  method: SignInMethod;
  /** What Claude itself reported at the start of the last real chat run through AImax (ground truth, independent of the status command). */
  lastRun: { apiKeySource: string; at: string } | null;
  /** Not-installed help: the official installer command + docs, and (Cursor) whether the desktop app was found. */
  installCommand: string | null; installDoc: string | null; desktopApp: string | null;
}

export function accountStatus(def: AccountDef): AccountStatus {
  const file = resolveBin(def);
  const base = { id: def.id, label: def.label, app: def.app, blurb: def.blurb, adapter: def.adapter, installHint: def.installHint };
  if (!file) return { ...base, installed: false, path: null, version: '', loginSupported: false, statusSupported: false, signedIn: null, statusText: '', how: 'not installed',
    loginCommand: [def.bins[0], ...def.login].join(' '), logoutCommand: [def.bins[0], ...def.logout].join(' '), hint: def.installHint, lastRun: null, installCommand: installCommandFor(def), installDoc: def.install?.doc ?? null, desktopApp: def.id === 'cursor' ? findCursorApp() : null, method: { kind: 'unknown', label: 'Not installed', evidence: '', account: '', fields: [] } };
  const version = runCli(file, ['--version'], 6000).out.split(/\r?\n/)[0].slice(0, 80);
  const loginSupported = runCli(file, [...def.login, '--help'], 6000).code === 0;
  const statusProbe = loginSupported ? runCli(file, [...def.status, '--help'], 6000).code === 0 : false;
  let signedIn: boolean | null = null; let statusText = ''; let statusFull = ''; let how = 'unknown';
  if (statusProbe) {
    const s = runCli(file, def.status, 10_000, def.id === 'claude' ? claudeChildEnv() : undefined); statusText = s.out.slice(0, 1500); statusFull = s.out;
    signedIn = s.timedOut ? null : (s.code === 0 && !NEGATIVE.test(s.out)); how = s.timedOut ? 'status command timed out' : `from "${[def.bins[0], ...def.status].join(' ')}" (exit ${s.code}) — heuristic`;
  } else if (def.id === 'claude') {
    // Older Claude Code without `auth` subcommands: only a file-EXISTENCE check (contents are never read). macOS keeps it in the Keychain → unknown.
    const f = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json');
    if (existsSync(f)) { signedIn = true; how = 'credentials file exists (contents not read) — heuristic'; } else how = process.platform === 'darwin' ? 'credentials live in the macOS Keychain; cannot tell from here' : 'no credentials file found';
  }
  const loginCommand = loginSupported ? [def.bins[0], ...def.login].join(' ') : def.id === 'claude' ? 'claude' : [def.bins[0], ...def.login].join(' ');
  const method: SignInMethod = signedIn === false ? { kind: 'unknown', label: 'Not signed in', evidence: statusText ? 'the CLI says you are not signed in' : '', account: '', fields: [] }
    : signedIn === null && !statusFull ? { kind: 'unknown', label: 'Cannot tell — this CLI version has no status command', evidence: how, account: '', fields: [] } : parseSignInMethod(statusFull, def.id);
  const lastRun = def.id === 'claude' ? getSetting<{ apiKeySource: string; at: string } | null>('claude:last_run', null) : null;
  return { ...base, method, lastRun, installCommand: installCommandFor(def), installDoc: def.install?.doc ?? null, desktopApp: def.id === 'cursor' ? findCursorApp() : null, installed: true, path: file, version, loginSupported, statusSupported: statusProbe, signedIn, statusText, how, loginCommand,
    logoutCommand: [def.bins[0], ...def.logout].join(' '),
    hint: loginSupported ? '' : def.id === 'claude' ? 'This Claude Code version has no "claude auth login". Run "claude" in a terminal and type /login.' : 'This CLI version did not recognise its login command — run it with --help to see how it signs in.' };
}

/** The Cursor DESKTOP app (an editor, not scriptable). Only used to tell the user what we found. */
export function findCursorApp(): string | null {
  const c = [...(WIN && process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Programs', 'cursor', 'Cursor.exe')] : []), '/Applications/Cursor.app', join(homedir(), 'Applications', 'Cursor.app')];
  for (const p of c) if (existsSync(p)) return p;
  return findOnPath('cursor');
}
export const installCommandFor = (def: AccountDef): string | null => def.install ? (WIN ? def.install.win : def.install.posix) : null;

export interface OpenResult { opened: boolean; command: string; note: string }
/** Open a terminal window on THIS computer running one of the fixed commands above. `command` never contains user input. */
export function openTerminal(command: string, opts: { powershell?: string } = {}): OpenResult {
  if (process.env.AIMAX_TERMINAL_LOG) { appendFileSync(process.env.AIMAX_TERMINAL_LOG, command + '\n'); return { opened: true, command, note: 'test mode: command logged, no window opened' }; }
  try {
    if (WIN && opts.powershell) { spawn('cmd.exe', ['/c', 'start', 'AImax', 'powershell', '-NoExit', '-NoProfile', '-Command', opts.powershell], { detached: true, stdio: 'ignore' }).unref(); return { opened: true, command, note: 'A PowerShell window opened and is running the installer.' }; }
    if (WIN) { spawn('cmd.exe', ['/c', 'start', 'AImax sign-in', 'cmd.exe', '/k', command], { detached: true, stdio: 'ignore' }).unref(); return { opened: true, command, note: 'A terminal window opened. Finish the sign-in there (it opens your browser).' }; }
    if (process.platform === 'darwin') { spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(command)}`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref(); return { opened: true, command, note: 'A Terminal window opened. Finish the sign-in there.' }; }
    const sh = `${command}; echo; read -r -p "Press Enter to close" _`;
    const tries: [string, string[]][] = [['x-terminal-emulator', ['-e', 'sh', '-c', sh]], ['gnome-terminal', ['--', 'sh', '-c', sh]], ['konsole', ['-e', 'sh', '-c', sh]], ['xterm', ['-e', 'sh', '-c', sh]]];
    for (const [bin, args] of tries) if (findOnPath(bin)) { spawn(bin, args, { detached: true, stdio: 'ignore' }).unref(); return { opened: true, command, note: 'A terminal window opened. Finish the sign-in there.' }; }
  } catch { /* fall through to the manual instruction */ }
  return { opened: false, command, note: 'Could not open a terminal automatically. Open one yourself and run the command shown.' };
}
