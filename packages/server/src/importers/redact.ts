/** Best-effort masking of credentials in imported transcripts. It cannot catch everything — review before sharing anywhere. */
const RULES: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED private key]'],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}/g, '[REDACTED api key]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED github token]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, '[REDACTED github token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED aws key id]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED slack token]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED google key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED jwt]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{20,}/g, (_m, b) => `${b} [REDACTED]`],
  [/\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*)(["']?)[^\s"'`,;]{6,}\2/gi, (_m, k, q) => `${k}${q}[REDACTED]${q}`],
];

export function redact(text: string): { text: string; count: number } {
  let count = 0; let out = text;
  for (const [re, rep] of RULES) out = out.replace(re, (...a) => { count++; return typeof rep === 'string' ? rep : rep(...(a as [string, ...string[]])); });
  return { text: out, count };
}
