import { realpathSync, existsSync } from 'node:fs';
import { resolve, sep, dirname, isAbsolute } from 'node:path';

export class SandboxError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/**
 * Resolve `rel` inside `root`, refusing anything that escapes it — via "..", absolute paths,
 * or symlinks (the deepest existing ancestor is resolved with realpath before comparing).
 */
export function resolveInside(root: string, rel: string): string {
  if (rel.includes('\0')) throw new SandboxError('Invalid path');
  const realRoot = realpathSync(root);
  const target = resolve(realRoot, isAbsolute(rel) ? '.' + sep + rel.replace(/^([a-zA-Z]:)?[\\/]+/, '') : rel);
  let probe = target;
  while (!existsSync(probe)) {
    const up = dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const realProbe = realpathSync(probe);
  const inside = realProbe === realRoot || realProbe.startsWith(realRoot + sep);
  if (!inside || !(target === realRoot || target.startsWith(realRoot + sep))) {
    throw new SandboxError('Path escapes the sandbox', 403);
  }
  return target;
}

const ENV_ALLOW = ['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'NODE_ENV'];
const SECRET_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;

/** Minimal allow-listed environment. Host secrets/home are never inherited. */
export function scrubEnv(workDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOW) {
    if (process.env[k] !== undefined && !SECRET_RE.test(k)) env[k] = process.env[k];
  }
  env.HOME = workDir;
  env.USERPROFILE = workDir;
  env.TERM = 'dumb';
  env.AIMAX_SANDBOX = '1';
  for (const [k, v] of Object.entries(extra)) if (!SECRET_RE.test(k)) env[k] = v;
  return env;
}

const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)/i,
  /\bRemove-Item\b.*-Recurse/i,
  /\b(del|erase|rmdir|rd)\b.*\/s/i,
  /\bgit\s+(push\b.*(--force|-f\b)|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D)/i,
  /\bformat(-volume)?\b/i,
  /\b(mkfs|dd\s+if=|shutdown|reboot)\b/i,
  /(curl|wget|iwr|Invoke-WebRequest)[^|]*\|\s*(sh|bash|iex|powershell)/i,
];
export function isDestructive(command: string): boolean {
  return DESTRUCTIVE.some(re => re.test(command));
}
