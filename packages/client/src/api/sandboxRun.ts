/** Shared streaming runner for the sandbox SSE endpoint (used by the terminal and by approved AI proposals). */
export interface RunHandlers {
  onStart?: (runId: string) => void;
  onChunk?: (text: string, stream: 'stdout' | 'stderr') => void;
  onDone?: (d: { exitCode: number; status: string; truncated: boolean; durationMs: number }) => void;
}
export type RunOutcome = { ok: true } | { ok: false; needsConfirmation?: boolean; message: string };

export async function streamRun(sandboxId: string, command: string, handlers: RunHandlers, opts: { confirm?: boolean; timeout?: number; signal?: AbortSignal } = {}): Promise<RunOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/sandbox/${sandboxId}/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: opts.signal,
      body: JSON.stringify({ command, timeout: opts.timeout ?? 60000, confirm: opts.confirm === true }),
    });
  } catch (e) { return { ok: false, message: (e as Error).name === 'AbortError' ? 'cancelled' : (e as Error).message }; }
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => ({} as { error?: string; needs_confirmation?: boolean }));
    return { ok: false, needsConfirmation: !!j.needs_confirmation, message: j.error ?? `HTTP ${res.status}` };
  }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1]; const data = /^data: (.+)$/m.exec(block)?.[1];
        if (!ev || !data) continue;
        const d = JSON.parse(data);
        if (ev === 'start') handlers.onStart?.(d.runId);
        else if (ev === 'chunk') handlers.onChunk?.(String(d.text), d.stream === 'stderr' ? 'stderr' : 'stdout');
        else if (ev === 'done') handlers.onDone?.(d);
      }
    }
  } catch (e) { if ((e as Error).name !== 'AbortError') return { ok: false, message: (e as Error).message }; }
  return { ok: true };
}

export async function cancelRun(runId: string) {
  await fetch(`/api/sandbox/runs/${runId}/cancel`, { method: 'POST' }).catch(() => undefined);
}
