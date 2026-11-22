#!/usr/bin/env node
/**
 * One-command launcher for AImax (Windows, macOS, Linux). Uses only Node built-ins so it can run BEFORE dependencies exist.
 *
 *   node scripts/aimax-start.mjs [--check] [--reinstall] [--force] [--no-open] [--no-ollama]
 *
 *   (default)    check Node + installed packages (repair if damaged) → free-port check → start Ollama if installed and not running
 *                → start API server + UI → wait until both answer → open the browser
 *   --check      only report whether the install is healthy (exit 0/1); changes nothing
 *   --reinstall  delete node_modules and install from scratch
 *   --force      stop whatever is already listening on AImax's ports (3001, 5173) — Windows/macOS/Linux with lsof
 *   --no-open    do not open the browser
 *   --no-ollama  do not try to start Ollama
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WIN = process.platform === 'win32';
const argv = new Set(process.argv.slice(2));
const SERVER_PORT = Number(process.env.PORT || 3001), UI_PORT = 5173, OLLAMA_PORT = 11434;
const NPM = process.env.AIMAX_NPM || (WIN ? 'npm.cmd' : 'npm');
const STAMP = join(ROOT, 'node_modules', '.aimax-install-stamp');

const say = (m = '') => console.log(m);
const step = (m) => console.log(`\n\x1b[36m▸ ${m}\x1b[0m`);
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const fail = (m) => { console.error(`\n\x1b[31m✗ ${m}\x1b[0m\n`); };

/** shell:true on Windows is needed to run npm.cmd; arguments here are fixed strings, never user input. */
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: WIN, ...opts });

// ── 1. Node ──────────────────────────────────────────────────────────────────────────────────────
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) { fail(`Node.js 20 or newer is required (you have ${process.versions.node}). Install the LTS from https://nodejs.org and run this again.`); process.exit(1); }

// ── 2. install health ────────────────────────────────────────────────────────────────────────────
function declaredDeps() {
  const files = [join(ROOT, 'package.json'), ...(existsSync(join(ROOT, 'packages')) ? readdirSync(join(ROOT, 'packages')).map(d => join(ROOT, 'packages', d, 'package.json')) : [])].filter(existsSync);
  const names = new Set();
  for (const f of files) { const j = JSON.parse(readFileSync(f, 'utf8')); for (const k of ['dependencies', 'devDependencies']) for (const n of Object.keys(j[k] ?? {})) if (!n.startsWith('@aimax/')) names.add(n); }
  return [...names];
}
const pkgDirs = (name) => [join(ROOT, 'node_modules', name), ...(existsSync(join(ROOT, 'packages')) ? readdirSync(join(ROOT, 'packages')).map(d => join(ROOT, 'packages', d, 'node_modules', name)) : [])];
const inputsHash = () => {
  const h = createHash('sha1'); const files = [join(ROOT, 'package-lock.json'), join(ROOT, 'package.json'), ...(readdirSync(join(ROOT, 'packages')).map(d => join(ROOT, 'packages', d, 'package.json')))];
  for (const f of files) if (existsSync(f)) h.update(readFileSync(f)); return h.digest('hex');
};

/** Returns a list of problems (empty = healthy). Checks that every declared package is present, a few files that break the UI build when
 *  half-installed, and that the native SQLite module and Rollup actually load. */
function problems() {
  const out = [];
  if (!existsSync(join(ROOT, 'node_modules'))) return ['dependencies are not installed (no node_modules folder)'];
  const missing = declaredDeps().filter(n => !pkgDirs(n).some(d => existsSync(join(d, 'package.json'))));
  if (missing.length) out.push(`missing packages: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` … (+${missing.length - 8})` : ''}`);
  for (const f of ['caniuse-lite/dist/unpacker/agents.js', 'caniuse-lite/data/agents.js']) if (!existsSync(join(ROOT, 'node_modules', f)) && existsSync(join(ROOT, 'node_modules', 'caniuse-lite'))) out.push(`damaged package file: ${f}`);
  if (!out.length) {
    const sqlite = spawnSync(process.execPath, ['-e', "const D=require('better-sqlite3');new D(':memory:').close()"], { cwd: join(ROOT, 'packages', 'server'), encoding: 'utf8' });
    if (sqlite.status !== 0) out.push(`better-sqlite3 does not load (${(sqlite.stderr || '').split('\n').find(l => /Error/.test(l))?.trim().slice(0, 140) || 'native build missing for this Node version'})`);
    const rollup = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('rollup')"], { cwd: join(ROOT, 'packages', 'client'), encoding: 'utf8' });
    if (rollup.status !== 0) out.push(`rollup does not load (${(rollup.stderr || '').split('\n').find(l => /Error|Cannot/.test(l))?.trim().slice(0, 140) || 'native build missing'})`);
  }
  return out;
}

const wipe = () => { step('Deleting node_modules (this can take a minute)'); rmSync(join(ROOT, 'node_modules'), { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }); for (const d of readdirSync(join(ROOT, 'packages'))) rmSync(join(ROOT, 'packages', d, 'node_modules'), { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }); };
const install = () => { step('Installing packages (npm install)'); const r = run(NPM, ['install', '--no-audit', '--no-fund']); return r.status === 0; };
const stamp = () => { try { writeFileSync(STAMP, inputsHash()); } catch { /* node_modules missing */ } };

function ensureInstall() {
  step('Checking installed packages');
  if (argv.has('--reinstall')) { wipe(); if (!install()) return false; }
  let p = problems(); const stale = existsSync(STAMP) ? readFileSync(STAMP, 'utf8') !== inputsHash() : true;
  if (!p.length && !stale) { ok('install is healthy'); return true; }
  if (p.length) p.forEach(x => warn(x)); else warn('package list changed since the last install');
  if (argv.has('--check')) return p.length === 0;
  if (!install()) warn('npm install reported an error');
  p = problems();
  if (p.length) {
    warn('still not healthy after npm install — doing a clean reinstall');
    p.forEach(x => warn(x));
    wipe(); if (!install()) warn('npm install reported an error');
    p = problems();
  }
  if (p.length) { p.forEach(x => fail(x)); say('Close other terminals / editors that use this folder, make sure AImax is not running, then run:  node scripts/aimax-start.mjs --reinstall'); return false; }
  stamp(); ok('install repaired'); return true;
}

// ── 3. ports ─────────────────────────────────────────────────────────────────────────────────────
const tryConnect = (port, host) => new Promise(res => { const s = net.connect({ port, host }); s.setTimeout(700); s.on('connect', () => { s.destroy(); res(true); }); s.on('timeout', () => { s.destroy(); res(false); }); s.on('error', () => res(false)); });
const inUse = async (port) => (await tryConnect(port, '127.0.0.1')) || (await tryConnect(port, '::1'));
const httpOk = async (url, ms = 1500) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok; } catch { return false; } };

function pidsOnPort(port) {
  if (WIN) {
    const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
    return [...new Set((r.stdout || '').split(/\r?\n/).filter(l => /LISTENING/.test(l) && new RegExp(`[:\\]]${port}\\s`).test(l)).map(l => l.trim().split(/\s+/).pop()).filter(Boolean))];
  }
  const r = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }); return (r.stdout || '').split(/\s+/).filter(Boolean);
}
const killPid = (pid) => WIN ? spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' }) : spawnSync('kill', ['-9', pid], { stdio: 'ignore' });

async function checkPorts() {
  step('Checking ports');
  const serverUp = await inUse(SERVER_PORT), uiUp = await inUse(UI_PORT);
  if (serverUp && uiUp && await httpOk(`http://127.0.0.1:${SERVER_PORT}/api/providers/status`)) return 'running';
  for (const [port, name] of [[SERVER_PORT, 'AImax server'], [UI_PORT, 'AImax UI']]) {
    if (!(await inUse(port))) { ok(`port ${port} is free (${name})`); continue; }
    const pids = pidsOnPort(port);
    if (argv.has('--force') && pids.length) { pids.forEach(killPid); await new Promise(r => setTimeout(r, 800)); if (await inUse(port)) { fail(`could not free port ${port}`); return 'blocked'; } ok(`stopped process(es) ${pids.join(', ')} on port ${port}`); continue; }
    fail(`port ${port} (${name}) is already in use${pids.length ? ` by process ${pids.join(', ')}` : ''}. This is probably an older AImax window or another program.`);
    say(WIN ? `  See what it is:   netstat -ano | findstr :${port}      then:  tasklist /FI "PID eq <pid>"` : `  See what it is:   lsof -i :${port}`);
    say('  Close it, or run this again with --force to stop it.');
    return 'blocked';
  }
  return 'free';
}

// ── 4. optional helpers ──────────────────────────────────────────────────────────────────────────
let ollamaChild = null;
async function ensureOllama() {
  step('Checking Ollama (optional local models)');
  if (await httpOk(`http://127.0.0.1:${OLLAMA_PORT}/api/tags`)) { ok('Ollama is already running'); return; }
  const found = spawnSync(WIN ? 'where' : 'which', ['ollama'], { encoding: 'utf8', shell: WIN });
  if (found.status !== 0) { warn('Ollama is not installed — skipping (AImax works without it; install from https://ollama.com for local models)'); return; }
  ollamaChild = spawn('ollama', ['serve'], { stdio: 'ignore', shell: WIN, windowsHide: true });
  ollamaChild.on('error', () => { ollamaChild = null; });
  for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 500)); if (await httpOk(`http://127.0.0.1:${OLLAMA_PORT}/api/tags`, 800)) { ok('started Ollama (it will be stopped when you close AImax)'); return; } }
  warn('started Ollama but it did not answer within 10 s — continuing without it');
}
function reportClaude() {
  const bin = process.env.AIMAX_CLAUDE_BIN || 'claude';
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', shell: WIN, timeout: 8000 });
  if (r.status === 0) ok(`Claude CLI: ${(r.stdout || '').trim().split(/\r?\n/)[0]}`); else warn('Claude CLI not found on PATH — Claude provider will be unavailable (set AIMAX_CLAUDE_BIN if it lives elsewhere)');
}

// ── 5. run ───────────────────────────────────────────────────────────────────────────────────────
function openBrowser(url) {
  if (argv.has('--no-open') || process.env.AIMAX_NO_OPEN) return;
  try { if (WIN) spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref(); else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref(); } catch { /* user can open it by hand */ }
}
let dev = null;
function cleanup() {
  if (dev && dev.pid) { if (WIN) spawnSync('taskkill', ['/PID', String(dev.pid), '/T', '/F'], { stdio: 'ignore' }); else { try { process.kill(-dev.pid); } catch { try { dev.kill(); } catch { /* gone */ } } } }
  if (ollamaChild && ollamaChild.pid) { if (WIN) spawnSync('taskkill', ['/PID', String(ollamaChild.pid), '/T', '/F'], { stdio: 'ignore' }); else { try { ollamaChild.kill(); } catch { /* gone */ } } }
}

async function main() {
  say('\x1b[1mAImax launcher\x1b[0m');
  if (!ensureInstall()) process.exit(1);
  if (argv.has('--check')) { process.exit(0); }
  const ports = await checkPorts();
  if (ports === 'blocked') process.exit(1);
  const url = `http://localhost:${UI_PORT}`;
  if (ports === 'running') { ok('AImax is already running'); openBrowser(url); say(`\n  ${url}\n`); return; }
  if (!argv.has('--no-ollama')) await ensureOllama();
  reportClaude();

  step('Starting AImax (API server + UI)');
  dev = spawn(NPM, ['run', 'dev'], { cwd: ROOT, stdio: 'inherit', shell: WIN, detached: !WIN });
  const exited = new Promise(res => dev.on('exit', code => res(code ?? 0)));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(0); });
  process.on('exit', cleanup);

  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    const early = await Promise.race([exited, new Promise(r => setTimeout(() => r(null), 500))]);
    if (early !== null) { fail(`AImax stopped during start-up (exit code ${early}). Read the messages above; the first error is the one that matters.`); process.exit(early || 1); }
    ready = (await httpOk(`http://127.0.0.1:${SERVER_PORT}/api/providers/status`, 800)) && (await httpOk(`http://127.0.0.1:${UI_PORT}/`, 800));
  }
  if (!ready) { fail('AImax did not become ready within 60 seconds. Read the messages above.'); cleanup(); process.exit(1); }
  say(`\n\x1b[32m✓ AImax is ready:\x1b[0m ${url}   (press Ctrl+C to stop everything)\n`);
  openBrowser(url);
  process.exit(await exited);
}
main().catch(e => { fail(e instanceof Error ? e.message : String(e)); cleanup(); process.exit(1); });
