import { spawn } from 'child_process';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function claudeChat(
  messages: ChatMessage[],
  onChunk: (text: string) => void
): Promise<string> {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUser) throw new Error('No user message');

  // Build a context-aware prompt if there's history
  let prompt = lastUser.content;
  if (messages.length > 1) {
    const history = messages.slice(0, -1)
      .map(m => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    prompt = `Previous conversation:\n${history}\n\nHuman: ${lastUser.content}`;
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', prompt, '--output-format', 'text'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    });

    let output = '';
    let error = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      onChunk(text);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      error += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0 && !output) {
        reject(new Error(`Claude CLI error (code ${code}): ${error.slice(0, 300)}`));
      } else {
        resolve(output.trim());
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    setTimeout(() => {
      proc.kill();
      if (!output) reject(new Error('Claude CLI timed out'));
      else resolve(output.trim());
    }, 120000);
  });
}

export async function checkClaudeAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('claude', ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
    setTimeout(() => { proc.kill(); resolve(false); }, 5000);
  });
}
