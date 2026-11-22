import type { FastifyInstance } from 'fastify';
import { ACCOUNTS, accountStatus, installCommandFor, openTerminal, resolveBin, type AccountId } from '../accounts/cli.js';
import { DATA_DIR, getDb } from '../db/index.js';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { checkOllamaAvailable, listOllamaModels } from '../providers/ollama.js';
import { getSetting } from '../providers/usage.js';
import { linkVaultPath } from './linkvault.js';

const quote = (a: string) => (/[\s"]/.test(a) ? `"${a}"` : a);

export async function accountsRoutes(app: FastifyInstance) {
  /** Ollama and LinkVault: are they reachable, and does AImax actually use them? */
  app.get('/api/connections', async () => {
    const up = await checkOllamaAvailable(); const models = up ? await listOllamaModels() : []; const chosen = getSetting<string>('ollama_model', '');
    const n = (getDb().prepare("SELECT COUNT(*) n, MAX(ts) last FROM usage_events WHERE provider='ollama' AND ok=1").get() as { n: number; last: string | null });
    const lvPath = linkVaultPath(); let lv: { found: boolean; path: string; links: number | null; error: string } = { found: existsSync(lvPath), path: lvPath, links: null, error: '' };
    if (lv.found) { try { const d = new Database(lvPath, { readonly: true }); try { lv.links = (d.prepare('SELECT COUNT(*) n FROM links').get() as { n: number }).n; } finally { d.close(); } } catch (e) { lv.error = e instanceof Error ? e.message : String(e); } }
    return {
      ollama: { running: up, url: process.env.OLLAMA_HOST || 'http://localhost:11434', models: models.map(m => m.name), selected: models.some(m => m.name === chosen) ? chosen : (models[0]?.name ?? ''), successfulChats: n.n, lastUsed: n.last,
        note: up ? (n.n ? 'Connected and used for chats.' : 'Connected, but no chat has used it yet — pick Ollama in the model picker.') : 'Not reachable. Start it with "ollama serve" (AImax starts it for you when launched with aimax.ps1).' },
      linkvault: { ...lv, usedByChat: false, note: lv.found && !lv.error ? 'Connected (read-only). It feeds the Link Vault panel only — chats do not read it yet.' : lv.found ? 'File found but unreadable.' : 'Database file not found. Set AIMAX_LINKVAULT_DB to its full path and restart.' },
    };
  });

  /** Status of each subscription CLI. Runs the CLIs' own read-only status commands; never reads credentials. */
  app.get('/api/accounts', async () => {
    const accounts = ACCOUNTS.map(accountStatus);
    const envKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY'].filter(k => process.env[k]);
    return {
      accounts,
      warnings: [
        ...(envKeys.filter(k => k.startsWith('ANTHROPIC')).length && process.env.AIMAX_ALLOW_API_KEY !== '1'
          ? [`${envKeys.filter(k => k.startsWith('ANTHROPIC')).join(', ')} is set on this computer. In your own terminal, claude bills that API key instead of using your subscription (that is what causes "credit balance too low"). AImax removes it when it starts Claude, so chats made through AImax use your subscription.`] : []),
        ...(envKeys.includes('OPENAI_API_KEY') ? ['OPENAI_API_KEY is set on this computer. AImax does not use it.'] : []),
      ],
      apiKeyFix: envKeys.some(k => k.startsWith('ANTHROPIC')) ? (process.platform === 'win32'
        ? 'In PowerShell: (1) see where it is set — [bool][Environment]::GetEnvironmentVariable("ANTHROPIC_API_KEY","User") and [bool][Environment]::GetEnvironmentVariable("ANTHROPIC_API_KEY","Machine"); (2) remove the user one — [Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY",$null,"User") (the Machine one needs an Administrator PowerShell, or Windows Settings → search "environment variables"); (3) close and reopen your terminals.'
        : 'Find it with:  grep -rn ANTHROPIC_API_KEY ~/.bashrc ~/.zshrc ~/.profile ~/.zprofile 2>/dev/null  then delete that line and open a new terminal.') : '',
      info: { dataDir: DATA_DIR, platform: process.platform, node: process.version, claudeBin: resolveBin(ACCOUNTS[0]) },
    };
  });

  /**
   * Open a terminal on this computer running the CLI's own login/logout. The command comes from a fixed table, never from the request.
   * A custom header is required so a web page in another browser tab cannot trigger it (browsers refuse that header cross-site without CORS approval).
   */
  app.post<{ Params: { id: string }; Body: { action?: string } }>('/api/accounts/:id/terminal', async (req, reply) => {
    if (req.headers['x-aimax-ui'] !== '1') return reply.status(403).send({ error: 'Forbidden' });
    const def = ACCOUNTS.find(a => a.id === (req.params.id as AccountId));
    if (!def) return reply.status(404).send({ error: 'Unknown provider' });
    const action = req.body?.action === 'logout' ? 'logout' : req.body?.action === 'login' ? 'login' : req.body?.action === 'install' ? 'install' : null;
    if (!action) return reply.status(400).send({ error: 'action must be "login", "logout" or "install"' });
    if (action === 'install') {                                   // the vendor's own installer, from a fixed table, in a window the user can see
      const cmd = installCommandFor(def);
      if (!cmd) return reply.status(400).send({ error: `No installer is offered for ${def.label}` });
      if (resolveBin(def)) return reply.status(409).send({ error: `${def.label} CLI is already installed` });
      return process.platform === 'win32' && def.id === 'cursor' ? openTerminal(cmd, { powershell: cmd }) : openTerminal(cmd);
    }
    const file = resolveBin(def);
    if (!file) return reply.status(404).send({ error: `${def.label} CLI is not installed. ${def.installHint}` });
    const st = accountStatus(def);
    const args = action === 'login' ? (st.loginSupported ? def.login : []) : def.logout;
    return openTerminal([quote(file), ...args].join(' '));
  });
}
