/** A CLI coding agent that works inside a sandbox workspace. Adapters: claude (built); cursor, codex (need real CLI output). */
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; target: string };

export interface AgentRunOptions {
  cwd: string;                         // the sandbox workspace — the agent's only working directory
  task: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onEvent: (e: AgentEvent) => void;
}
export interface AgentResult { text: string; sessionId: string | null; tools: number; error?: string }

export interface AgentAdapter {
  id: string;
  label: string;
  available(): Promise<boolean>;
  run(opts: AgentRunOptions): Promise<AgentResult>;
}
