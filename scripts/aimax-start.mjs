#!/usr/bin/env node
/**
 * One-command launcher for AImax (Windows, macOS, Linux). Uses only Node built-ins so it can run BEFORE dependencies exist.
 *
 *   node scripts/aimax-start.mjs [--stop] [--check] [--reinstall] [--force] [--no-open] [--no-ollama]
 *
 *   (default)    check Node + installed packages (repair if damaged) → port check → start Ollama if installed and not running
 *                → start API server + UI → wait until both answer AND the UI really compiles → open the browser
 *                Stop with Ctrl+C or the Q key; everything it started (and anything still holding AImax's ports) is stopped.
 *   --stop       stop a running AImax (whatever is listening on its ports) and exit
 *   --check      only report whether the install is healthy (exit 0/1); changes nothing
 *   --reinstall  delete node_modules and install from scratch
 *   --force      stop whatever already uses AImax's ports before starting
 *   --no-open    do not open the browser        --no-ollama  do not try to start Ollama
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WIN = process.platform === 'win32';
const argv = new Set(process.argv.slice(2));
const SERVER_PORT = Number(process.env.PORT || 3001), UI_PORT = 5173, OLLAMA_PORT = 11434;
const NPM = process.env.AIMAX_NPM || 'npm';
const STAMP = join(ROOT, 'node_modules', '.aimax-install-stamp');
const PIDFILE = join(ROOT, '.aimax.pid');            // lets `--stop` from another window find the launcher and its children

const say = (m = '') => console.log(m);
const step = (m) => console.log(`\n\x1b[36m▸ ${m}\x1b[0m`);
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const fail = (m) => { console.error(`\n\x1b[31m✗ ${m}\x1b[0m\n`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** On Windows commands such as npm/claude/ollama are .cmd shims that need a shell. Passing ONE command string (all parts are fixed
 *  constants or quoted paths, never user input) avoids Node's "args with shell:true" deprecation warning. */
const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const cmdline = (cmd, args) => [cmd, ...args].map(quote).join(' ');
const execSync = (cmd, args, opts = {}) => WIN ? spawnSync(cmdline(cmd, args), { cwd: ROOT, shell: true, ...opts }) : spawnSync(cmd, args, { cwd: ROOT, ...opts });
const execAsync = (cmd, args, opts = {}) => WIN ? spawn(cmdline(cmd, args), { cwd: ROOT, shell: true, ...opts }) : spawn(cmd, args, { cwd: ROOT, ...opts });
const runInherit = (cmd, args) => execSync(cmd, args, { stdio: 'inherit' });

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) { fail(`Node.js 20 or newer is required (you have ${process.versions.node}). Install the LTS from https://nodejs.org and run this again.`); process.exit(1); }

// ── ports / processes ────────────────────────────────────────────────────────────────────────────
const tryConnect = (port, host) => new Promise(res => { const s = net.connect({ port, host }); s.setTimeout(700); s.on('connect', () => { s.destroy(); res(true); }); s.on('timeout', () => { s.destroy(); res(false); }); s.on('error', () => res(false)); });
const inUse = async (port) => (await tryConnect(port, '127.0.0.1')) || (await tryConnect(port, '::1'));
const httpGet = async (url, ms = 1500) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return { ok: r.ok, status: r.status, text: async () => r.text() }; } catch { return { ok: false, status: 0, text: async () => '' }; } };
const httpOk = async (url, ms) => (await httpGet(url, ms)).ok;

function pidsOnPort(port) {
  if (WIN) {
    const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
    return [...new Set((r.stdout || '').split(/\r?\n/).filter(l => /LISTENING/.test(l) && new RegExp(`[:\\]]${port}\\s`).test(l)).map(l => l.trim().split(/\s+/).pop()).filter(p => p && p !== '0'))];
  }
  const r = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }); return (r.stdout || '').split(/\s+/).filter(Boolean);
}
const killTree = (pid) => { if (!pid || String(pid) === String(process.pid)) return; if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else { try { process.kill(-Number(pid), 'SIGKILL'); } catch { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } } } };
/** Stop anything still listening on AImax's ports. Returns the pids it stopped. */
async function sweepPorts() {
  const killed = [];
  for (const port of [SERVER_PORT, UI_PORT]) for (const pid of pidsOnPort(port)) { killTree(pid); killed.push(pid); }
  if (killed.length) await sleep(700);
  return killed;
}

if (argv.has('--stop')) {
  say('\x1b[1mAImax launcher — stop\x1b[0m');
  const killed = [];
  try { const j = JSON.parse(readFileSync(PIDFILE, 'utf8')); for (const pid of [j.dev, j.ollama, j.launcher]) if (pid && pid !== process.pid) { killTree(pid); killed.push(pid); } } catch { /* no pid file: not started by the launcher */ }
  try { rmSync(PIDFILE, { force: true }); } catch { /* ignore */ }
  await sleep(500);
  killed.push(...await sweepPorts());
  const still = (await inUse(SERVER_PORT)) || (await inUse(UI_PORT));
  if (still) { fail(`something is still listening on port ${SERVER_PORT} or ${UI_PORT}. Close that window, or look it up with:  ${WIN ? `netstat -ano | findstr :${SERVER_PORT}` : `lsof -i :${SERVER_PORT}`}`); process.exit(1); }
  ok(killed.length ? `stopped process(es) ${killed.join(', ')}` : 'AImax was not running'); process.exit(0);
}

// ── install health ───────────────────────────────────────────────────────────────────────────────
const pkgJsonFiles = () => [join(ROOT, 'package.json'), ...(existsSync(join(ROOT, 'packages')) ? readdirSync(join(ROOT, 'packages')).map(d => join(ROOT, 'packages', d, 'package.json')) : [])].filter(existsSync);
function declaredDeps() {
  const names = new Set();
  for (const f of pkgJsonFiles()) { const j = JSON.parse(readFileSync(f, 'utf8')); for (const k of ['dependencies', 'devDependencies']) for (const n of Object.keys(j[k] ?? {})) if (!n.startsWith('@aimax/')) names.add(n); }
  return [...names];
}
const pkgDirs = (name) => [join(ROOT, 'node_modules', name), ...(existsSync(join(ROOT, 'packages')) ? readdirSync(join(ROOT, 'packages')).map(d => join(ROOT, 'packages', d, 'node_modules', name)) : [])];
const inputsHash = () => { const h = createHash('sha1'); for (const f of [join(ROOT, 'package-lock.json'), ...pkgJsonFiles()]) if (existsSync(f)) h.update(readFileSync(f)); return h.digest('hex'); };

/** Does this lockfile entry apply to this machine? (platform-specific optional packages are skipped on other systems) */
function appliesHere(e) {
  const fits = (list, cur) => { if (!Array.isArray(list) || !list.length) return true; const neg = list.filter(x => x.startsWith('!')).map(x => x.slice(1)); const pos = list.filter(x => !x.startsWith('!')); return neg.includes(cur) ? false : pos.length ? pos.includes(cur) : true; };
  return fits(e.os, process.platform) && fits(e.cpu, process.arch);
}
/** Compare the lockfile with what is on disk, and the lockfile with itself (a dependency nobody pinned is never installed). */
function lockProblems() {
  const out = { missingOnDisk: [], incompleteLock: [] };
  const f = join(ROOT, 'package-lock.json'); if (!existsSync(f)) return out;
  let P; try { P = JSON.parse(readFileSync(f, 'utf8')).packages ?? {}; } catch { out.incompleteLock.push('package-lock.json is unreadable'); return out; }
  for (const [key, e] of Object.entries(P)) {
    if (!key || e.link || !key.includes('node_modules/') || !appliesHere(e)) continue;
    if (!existsSync(join(ROOT, key, 'package.json')) && !e.optional) out.missingOnDisk.push({ key, name: key.slice(key.lastIndexOf('node_modules/') + 13), version: e.version });
  }
  const find = (from, name) => { let base = from; for (;;) { if (P[(base ? base + '/' : '') + 'node_modules/' + name]) return true; if (!base) return false; const i = base.lastIndexOf('/node_modules/'); base = i >= 0 ? base.slice(0, i) : ''; } };
  const miss = new Set();
  for (const [key, e] of Object.entries(P)) { if (e.link) continue; for (const kind of ['dependencies', 'peerDependencies']) for (const n of Object.keys(e[kind] ?? {})) { if (kind === 'peerDependencies' && e.peerDependenciesMeta?.[n]?.optional) continue; if (!find(key, n)) miss.add(n); } }
  if (miss.size) out.incompleteLock.push(`package-lock.json has no entry for: ${[...miss].slice(0, 6).join(', ')}`);
  return out;
}

/** List of problems (empty = healthy). Also actually LOADS the pieces that break the UI/DB when half-installed. */
function problems() {
  const out = [];
  if (!existsSync(join(ROOT, 'node_modules'))) return ['dependencies are not installed (no node_modules folder)'];
  const missing = declaredDeps().filter(n => !pkgDirs(n).some(d => existsSync(join(d, 'package.json'))));
  if (missing.length) out.push(`missing packages: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` … (+${missing.length - 8})` : ''}`);
  const lp = lockProblems();
  if (lp.missingOnDisk.length) out.push(`${lp.missingOnDisk.length} package(s) from package-lock.json are not on disk: ${lp.missingOnDisk.slice(0, 6).map(m => m.name).join(', ')}${lp.missingOnDisk.length > 6 ? ' …' : ''}`);
  lp.incompleteLock.forEach(x => out.push(`${x} — run "git pull" to get the fixed lockfile`));
  if (!out.length) {
    const probe = (cwd, code, label, esm) => { const r = spawnSync(process.execPath, [...(esm ? ['--input-type=module'] : []), '-e', code], { cwd, encoding: 'utf8' }); if (r.status !== 0) out.push(`${label} does not load (${(r.stderr || '').split('\n').find(l => /Error|Cannot/.test(l))?.trim().slice(0, 150) || 'unknown error'})`); };
    probe(join(ROOT, 'packages', 'server'), "const D=require('better-sqlite3');new D(':memory:').close()", 'better-sqlite3');
    probe(join(ROOT, 'packages', 'client'), "await import('rollup')", 'rollup', true);
    probe(join(ROOT, 'packages', 'client'), "require('@babel/helper-compilation-targets')", 'the UI compiler (babel/browserslist)');
  }
  return out;
}

const wipe = () => { step('Deleting node_modules (this can take a minute)'); const opt = { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }; rmSync(join(ROOT, 'node_modules'), opt); for (const d of readdirSync(join(ROOT, 'packages'))) rmSync(join(ROOT, 'packages', d, 'node_modules'), opt); };
const install = () => { step('Installing packages (npm install)'); return runInherit(NPM, ['install', '--no-audit', '--no-fund']).status === 0; };
const stamp = () => { try { writeFileSync(STAMP, inputsHash()); } catch { /* no node_modules */ } };
/** Reinstall exactly the packages the lockfile lists but that are not on disk, without touching package.json / package-lock.json. */
function repairMissing() {
  const m = lockProblems().missingOnDisk.filter(x => x.key === `node_modules/${x.name}` && x.version);
  if (!m.length || m.length > 10 || !existsSync(join(ROOT, 'node_modules'))) return false;   // a few damaged packages only; many missing = reinstall everything instead
  step(`Re-installing ${m.length} missing package(s): ${m.slice(0, 5).map(x => x.name).join(', ')}`);
  return runInherit(NPM, ['install', '--no-save', '--no-audit', '--no-fund', ...m.slice(0, 40).map(x => `${x.name}@${x.version}`)]).status === 0;
}

function ensureInstall() {
  step('Checking installed packages');
  if (argv.has('--reinstall')) { wipe(); runInherit(NPM, ['cache', 'verify']); if (!install()) warn('npm install reported an error'); }
  let p = problems(); const stale = existsSync(STAMP) ? readFileSync(STAMP, 'utf8') !== inputsHash() : true;
  if (!p.length && !stale) { ok('install is healthy'); return true; }
  if (p.length) p.forEach(x => warn(x)); else warn('package list changed since the last install');
  if (argv.has('--check')) return p.length === 0;
  if (!argv.has('--reinstall') && !install()) warn('npm install reported an error');
  p = problems();
  if (p.length && repairMissing()) p = problems();
  if (p.length) {
    warn('still not healthy — doing a clean reinstall (npm cache check + fresh node_modules)');
    p.forEach(x => warn(x));
    wipe(); runInherit(NPM, ['cache', 'verify']); if (!install()) warn('npm install reported an error');
    p = problems(); if (p.length && repairMissing()) p = problems();
  }
  if (p.length) {
    p.forEach(x => fail(x));
    say('Things to try: close other terminals/editors using this folder, make sure antivirus is not quarantining node_modules, run "git pull", then:  .\\aimax.ps1 -Reinstall');
    say('If it still fails, send the red lines above.'); return false;
  }
  stamp(); ok('install repaired'); return true;
}

async function checkPorts() {
  step('Checking ports');
  const serverUp = await inUse(SERVER_PORT), uiUp = await inUse(UI_PORT);
  if (serverUp && uiUp && await httpOk(`http://127.0.0.1:${SERVER_PORT}/api/providers/status`)) return 'running';
  for (const [port, name] of [[SERVER_PORT, 'AImax server'], [UI_PORT, 'AImax UI']]) {
    if (!(await inUse(port))) { ok(`port ${port} is free (${name})`); continue; }
    const pids = pidsOnPort(port);
    if (argv.has('--force') && pids.length) { pids.forEach(killTree); await sleep(800); if (await inUse(port)) { fail(`could not free port ${port}`); return 'blocked'; } ok(`stopped process(es) ${pids.join(', ')} on port ${port}`); continue; }
    fail(`port ${port} (${name}) is already in use${pids.length ? ` by process ${pids.join(', ')}` : ''}. This is probably an older AImax window or another program.`);
    say(WIN ? `  See what it is:   netstat -ano | findstr :${port}      then:  tasklist /FI "PID eq <pid>"` : `  See what it is:   lsof -i :${port}`);
    say('  Stop it with   .\\aimax.ps1 -Stop   (or run this again with -Force).');
    return 'blocked';
  }
  return 'free';
}

// ── optional helpers ─────────────────────────────────────────────────────────────────────────────
let ollamaChild = null;
async function ensureOllama() {
  step('Checking Ollama (optional local models)');
  if (await httpOk(`http://127.0.0.1:${OLLAMA_PORT}/api/tags`)) { ok('Ollama is already running'); return; }
  const found = WIN ? spawnSync('where ollama', { shell: true, encoding: 'utf8' }) : spawnSync('which', ['ollama'], { encoding: 'utf8' });
  if (found.status !== 0) { warn('Ollama is not installed — skipping (AImax works without it; install from https://ollama.com for local models)'); return; }
  ollamaChild = execAsync('ollama', ['serve'], { stdio: 'ignore', windowsHide: true, detached: !WIN });
  ollamaChild.on('error', () => { ollamaChild = null; });
  for (let i = 0; i < 20; i++) { await sleep(500); if (await httpOk(`http://127.0.0.1:${OLLAMA_PORT}/api/tags`, 800)) { ok('started Ollama (it will be stopped when you stop AImax)'); return; } }
  warn('started Ollama but it did not answer within 10 s — continuing without it');
}
function reportClaude() {
  const r = execSync(process.env.AIMAX_CLAUDE_BIN || 'claude', ['--version'], { encoding: 'utf8', timeout: 8000 });
  if (r.status === 0) ok(`Claude CLI: ${(r.stdout || '').trim().split(/\r?\n/)[0]}`); else warn('Claude CLI not found on PATH — the Claude provider will be unavailable (set AIMAX_CLAUDE_BIN if it lives elsewhere)');
}
function openBrowser(url) {
  if (argv.has('--no-open') || process.env.AIMAX_NO_OPEN) return;
  try { if (WIN) spawn(`start "" "${url}"`, { shell: true, stdio: 'ignore', detached: true }).unref(); else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref(); } catch { /* open it by hand */ }
}

// ── run + shutdown ───────────────────────────────────────────────────────────────────────────────
let dev = null, stopping = false, startedByUs = false;
async function shutdown(code = 0) {
  if (stopping) { process.exit(code || 1); return; }          // second Ctrl+C / signal: leave immediately
  stopping = true;
  say('\n\x1b[36m▸ Stopping AImax…\x1b[0m');
  if (dev?.pid) killTree(dev.pid);
  if (ollamaChild?.pid) killTree(ollamaChild.pid);
  await sleep(500);
  if (startedByUs) { const left = await sweepPorts(); if (left.length) ok(`also stopped leftover process(es) ${left.join(', ')}`); }
  const busy = (await inUse(SERVER_PORT)) || (await inUse(UI_PORT));
  try { rmSync(PIDFILE, { force: true }); } catch { /* ignore */ }
  say(busy ? '\x1b[33m! Something still holds port 3001/5173. Run  .\\aimax.ps1 -Stop\x1b[0m' : '\x1b[32m✓ Stopped. Ports 3001 and 5173 are free.\x1b[0m');
  process.exit(code);
}

async function main() {
  say('\x1b[1mAImax launcher\x1b[0m');
  if (!ensureInstall()) process.exit(1);
  if (argv.has('--check')) process.exit(0);
  const ports = await checkPorts();
  if (ports === 'blocked') process.exit(1);
  const url = `http://localhost:${UI_PORT}`;
  if (ports === 'running') { ok('AImax is already running'); openBrowser(url); say(`\n  ${url}      (stop it with  .\\aimax.ps1 -Stop)\n`); return; }
  if (!argv.has('--no-ollama')) await ensureOllama();
  reportClaude();

  step('Starting AImax (API server + UI)');
  startedByUs = true;
  // stdin is NOT inherited: the launcher owns the keyboard (Ctrl+C / Q), so shutdown does not depend on console signals reaching a process tree.
  dev = execAsync(NPM, ['run', 'dev'], { stdio: ['ignore', 'inherit', 'inherit'], detached: !WIN, env: { ...process.env, FORCE_COLOR: '1' } });
  const exited = new Promise(res => dev.on('exit', code => res(code ?? 0)));
  const writePids = () => { try { writeFileSync(PIDFILE, JSON.stringify({ launcher: process.pid, dev: dev.pid, ollama: ollamaChild?.pid ?? null })); } catch { /* read-only folder: --stop falls back to the port sweep */ } };
  writePids();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) { try { process.on(sig, () => void shutdown(0)); } catch { /* signal not supported here */ } }
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdin.on('data', (b) => { const s = b.toString(); if (s.includes('\x03') || /^[qQ]/.test(s)) void shutdown(0); });
  }

  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    const early = await Promise.race([exited, sleep(500).then(() => null)]);
    if (early !== null) { fail(`AImax stopped during start-up (exit code ${early}). The first error above is the one that matters.`); await shutdown(early || 1); }
    ready = (await httpOk(`http://127.0.0.1:${SERVER_PORT}/api/health`, 3000)) && (await httpOk(`http://localhost:${UI_PORT}/`, 3000));   // /api/health is cheap; status checks tools and can be slow on first call
  }
  if (!ready) { fail('AImax did not become ready within 60 seconds. Read the messages above.'); await shutdown(1); }

  // "Port answers" is not "UI works": ask Vite to compile the entry file. A broken install shows up here as an HTTP 500.
  const probe = await httpGet(`http://localhost:${UI_PORT}/src/main.tsx`, 30000);
  if (!probe.ok) {
    const body = ((await probe.text()).split('\n').map(l => l.replace(/<[^>]+>/g, '').trim()).find(l => /Failed to resolve|Cannot find|Error:|error:/i.test(l)) ?? '');
    fail(`The UI server is up but the UI does not compile (HTTP ${probe.status}). ${body.slice(0, 200)}\n  Fix:  .\\aimax.ps1 -Reinstall   (and run "git pull" first if you have not)`);
    await shutdown(1);
  }
  say(`\n\x1b[32m✓ AImax is ready:\x1b[0m ${url}\n  Stop with Ctrl+C or press Q  (or from another window:  .\\aimax.ps1 -Stop)\n`);
  openBrowser(url);
  const code = await exited;
  if (!stopping) { say(`\nAImax stopped (exit code ${code}).`); await shutdown(code); }
}
main().catch(async (e) => { fail(e instanceof Error ? e.message : String(e)); await shutdown(1); });
