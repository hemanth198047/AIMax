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
import { resolveClaudeBin } from '../providers/claude.js';

const WIN = process.platform === 'win32';

export type AccountId = 'claude' | 'cursor' | 'openai';
export interface AccountDef {
  id: AccountId; label: string; app: string; bins: string[]; installHint: string;
  login: string[]; status: string[]; logout: string[];
  /** Can AImax actually chat through this provider yet? */
  adapter: 'ready' | 'not-built'; blurb: string;
}
export const ACCOUNTS: AccountDef[] = [
  { id: 'claude', label: 'Claude', app: 'claude.ai (Pro / Max subscription)', bins: [process.env.AIMAX_CLAUDE_BIN || 'claude'], installHint: 'Install Claude Code from https://claude.com/claude-code',
    login: ['auth', 'login'], status: ['auth', 'status'], logout: ['auth', 'logout'], adapter: 'ready',
    blurb: 'AImax chats through the Claude Code CLI, which uses your Claude subscription login — no API key.' },
  { id: 'cursor', label: 'Cursor', app: 'Cursor app account', bins: ['cursor-agent', 'agent'], installHint: 'Install the Cursor CLI (cursor-agent) from https://cursor.com/cli',
    login: ['login'], status: ['status'], logout: ['logout'], adapter: 'not-built',
    blurb: 'Signs the Cursor CLI in with your Cursor account. AImax cannot chat through Cursor yet (adapter not built).' },
  { id: 'openai', label: 'OpenAI (ChatGPT / Codex)', app: 'ChatGPT account via the Codex CLI', bins: ['codex'], installHint: 'Install the Codex CLI: npm install -g @openai/codex',
    login: ['login'], status: ['login', 'status'], logout: ['logout'], adapter: 'not-built',
    blurb: 'Signs the Codex CLI in with your ChatGPT account. AImax cannot chat through Codex yet (adapter not built).' },
];

const quote = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

function findOnPath(name: string): string | null {
  const exts = WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  if (name.includes('/') || name.includes('\\')) return existsSync(name) ? name : null;
  for (const d of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) for (const e of exts) { const p = join(d, name + e); if (existsSync(p)) return p; }
  return null;
}
export function resolveBin(def: AccountDef): string | null {
  if (def.id === 'claude') { const r = resolveClaudeBin(); return r.file === 'claude' ? findOnPath('claude') : r.file; }
  for (const b of def.bins) { const p = findOnPath(b); if (p) return p; }
  return null;
}

export interface CliRun { code: number | null; out: string; timedOut: boolean }
/** Run a CLI with a fixed argument list; .cmd/.bat shims on Windows need a shell, so they get ONE command string (no user input in it). */
export function runCli(file: string, args: string[], timeoutMs = 8000): CliRun {
  const shim = WIN && /\.(cmd|bat)$/i.test(file);
  const r = shim
    ? spawnSync([file, ...args].map(quote).join(' '), { shell: true, encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
    : spawnSync(file, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim(), timedOut: r.error?.name === 'Error' && /ETIMEDOUT/.test(String((r.error as NodeJS.ErrnoException).code)) };
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
  /** 'api' = the status text mentions Console/API-key billing, 'subscription' = mentions a subscription plan, null = cannot tell. HEURISTIC on the CLI's wording. */
  billing: 'api' | 'subscription' | null;
}

export function accountStatus(def: AccountDef): AccountStatus {
  const file = resolveBin(def);
  const base = { id: def.id, label: def.label, app: def.app, blurb: def.blurb, adapter: def.adapter, installHint: def.installHint };
  if (!file) return { ...base, installed: false, path: null, version: '', loginSupported: false, statusSupported: false, signedIn: null, statusText: '', how: 'not installed',
    loginCommand: [def.bins[0], ...def.login].join(' '), logoutCommand: [def.bins[0], ...def.logout].join(' '), hint: def.installHint, billing: null };
  const version = runCli(file, ['--version'], 6000).out.split(/\r?\n/)[0].slice(0, 80);
  const loginSupported = runCli(file, [...def.login, '--help'], 6000).code === 0;
  const statusProbe = loginSupported ? runCli(file, [...def.status, '--help'], 6000).code === 0 : false;
  let signedIn: boolean | null = null; let statusText = ''; let how = 'unknown';
  if (statusProbe) {
    const s = runCli(file, def.status, 10_000); statusText = s.out.slice(0, 400);
    signedIn = s.timedOut ? null : (s.code === 0 && !NEGATIVE.test(s.out)); how = s.timedOut ? 'status command timed out' : `from "${[def.bins[0], ...def.status].join(' ')}" (exit ${s.code}) — heuristic`;
  } else if (def.id === 'claude') {
    // Older Claude Code without `auth` subcommands: only a file-EXISTENCE check (contents are never read). macOS keeps it in the Keychain → unknown.
    const f = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json');
    if (existsSync(f)) { signedIn = true; how = 'credentials file exists (contents not read) — heuristic'; } else how = process.platform === 'darwin' ? 'credentials live in the macOS Keychain; cannot tell from here' : 'no credentials file found';
  }
  const loginCommand = loginSupported ? [def.bins[0], ...def.login].join(' ') : def.id === 'claude' ? 'claude' : [def.bins[0], ...def.login].join(' ');
  const billing: AccountStatus['billing'] = /console|api[ _-]?key|api (usage|billing)|anthropic_api_key/i.test(statusText) ? 'api' : /subscription|\b(pro|max|plus|team)\b|claude\.ai|chatgpt/i.test(statusText) ? 'subscription' : null;
  return { ...base, billing, installed: true, path: file, version, loginSupported, statusSupported: statusProbe, signedIn, statusText, how, loginCommand,
    logoutCommand: [def.bins[0], ...def.logout].join(' '),
    hint: loginSupported ? '' : def.id === 'claude' ? 'This Claude Code version has no "claude auth login". Run "claude" in a terminal and type /login.' : 'This CLI version did not recognise its login command — run it with --help to see how it signs in.' };
}

export interface OpenResult { opened: boolean; command: string; note: string }
/** Open a terminal window on THIS computer running one of the fixed commands above. `command` never contains user input. */
export function openTerminal(command: string): OpenResult {
  if (process.env.AIMAX_TERMINAL_LOG) { appendFileSync(process.env.AIMAX_TERMINAL_LOG, command + '\n'); return { opened: true, command, note: 'test mode: command logged, no window opened' }; }
  try {
    if (WIN) { spawn('cmd.exe', ['/c', 'start', 'AImax sign-in', 'cmd.exe', '/k', command], { detached: true, stdio: 'ignore' }).unref(); return { opened: true, command, note: 'A terminal window opened. Finish the sign-in there (it opens your browser).' }; }
    if (process.platform === 'darwin') { spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(command)}`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref(); return { opened: true, command, note: 'A Terminal window opened. Finish the sign-in there.' }; }
    const sh = `${command}; echo; read -r -p "Press Enter to close" _`;
    const tries: [string, string[]][] = [['x-terminal-emulator', ['-e', 'sh', '-c', sh]], ['gnome-terminal', ['--', 'sh', '-c', sh]], ['konsole', ['-e', 'sh', '-c', sh]], ['xterm', ['-e', 'sh', '-c', sh]]];
    for (const [bin, args] of tries) if (findOnPath(bin)) { spawn(bin, args, { detached: true, stdio: 'ignore' }).unref(); return { opened: true, command, note: 'A terminal window opened. Finish the sign-in there.' }; }
  } catch { /* fall through to the manual instruction */ }
  return { opened: false, command, note: 'Could not open a terminal automatically. Open one yourself and run the command shown.' };
}
