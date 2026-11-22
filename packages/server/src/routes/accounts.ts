import type { FastifyInstance } from 'fastify';
import { ACCOUNTS, accountStatus, openTerminal, resolveBin, type AccountId } from '../accounts/cli.js';
import { DATA_DIR } from '../db/index.js';

const quote = (a: string) => (/[\s"]/.test(a) ? `"${a}"` : a);

export async function accountsRoutes(app: FastifyInstance) {
  /** Status of each subscription CLI. Runs the CLIs' own read-only status commands; never reads credentials. */
  app.get('/api/accounts', async () => {
    const accounts = ACCOUNTS.map(accountStatus);
    const envKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY'].filter(k => process.env[k]);
    return {
      accounts,
      warnings: [
        ...(envKeys.filter(k => k.startsWith('ANTHROPIC')).length && process.env.AIMAX_ALLOW_API_KEY !== '1'
          ? [`${envKeys.filter(k => k.startsWith('ANTHROPIC')).join(', ')} is set on this computer. Claude Code would bill that API key instead of using your subscription, so AImax ignores it when it starts Claude.`] : []),
        ...(envKeys.includes('OPENAI_API_KEY') ? ['OPENAI_API_KEY is set on this computer. AImax does not use it.'] : []),
      ],
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
    const action = req.body?.action === 'logout' ? 'logout' : req.body?.action === 'login' ? 'login' : null;
    if (!action) return reply.status(400).send({ error: 'action must be "login" or "logout"' });
    const file = resolveBin(def);
    if (!file) return reply.status(404).send({ error: `${def.label} CLI is not installed. ${def.installHint}` });
    const st = accountStatus(def);
    const args = action === 'login' ? (st.loginSupported ? def.login : []) : def.logout;
    return openTerminal([quote(file), ...args].join(' '));
  });
}
