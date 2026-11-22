/**
 * First working milestone (master prompt §151), driven through the real UI in a real browser,
 * against the real server and SQLite database. Only the AI provider is the deterministic test provider.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { startServer, stopServer } from './server';

const SHOTS = join(__dirname, 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const dataDir = mkdtempSync(join(tmpdir(), 'aimax-e2e-data-'));
const work = mkdtempSync(join(tmpdir(), 'aimax-e2e-work-'));
const repo = join(work, 'milestone-repo');
const notes = join(work, 'notes.txt');
const blob = join(work, 'data.bin');

test.beforeAll(async () => {
  mkdirSync(repo);
  execSync('git init -q && git config user.email t@t && git config user.name t && echo original > readme.txt && git add -A && git commit -qm init', { cwd: repo });
  writeFileSync(notes, 'attachment-marker-42: the deploy key rotates every 90 days');
  writeFileSync(blob, Buffer.from([0, 1, 2, 3, 0, 255]));
  await startServer(dataDir);
});
test.afterAll(async () => { await stopServer(); });

const sidebarTab = (page: Page, title: string) => page.locator(`button[title="${title}"]`).first();
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
const lastAssistant = (page: Page) => page.getByTestId('msg-assistant').last();

async function askAndRead(page: Page, text: string) {
  const before = await page.getByTestId('msg-assistant').count();
  const box = page.getByPlaceholder(/Message AImax/);
  await box.fill(text); await box.press('Enter');
  await expect(page.getByTestId('msg-assistant')).toHaveCount(before + 1, { timeout: 15_000 });
  await expect(lastAssistant(page)).toContainText('TEST-PROVIDER');
  return lastAssistant(page).innerText();
}

test('first working milestone: project → person → link → context → chat+attachment → sandbox → restart → resume', async ({ page }) => {
  page.on('dialog', d => d.accept(d.defaultValue()));      // confirm()/prompt() dialogs (checkpoint label etc.)
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));

  // 1. Open AImax in a browser
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'AImax' })).toBeVisible();
  await shot(page, '01-home');

  // 2. Create a project (with a real repo path)
  await sidebarTab(page, 'Projects').click();
  await page.getByRole('button', { name: /New Project/ }).click();
  await page.getByPlaceholder('My Project').fill('Milestone App');
  await page.getByPlaceholder(/my-repo/).fill(repo);
  await page.getByRole('button', { name: 'Create Project' }).click();
  await expect(page.getByText('Milestone App').first()).toBeVisible();

  // 3. Create a person
  await sidebarTab(page, 'People').click();
  await page.getByRole('button', { name: /New Person/ }).click();
  await page.getByPlaceholder('Full Name').fill('Alice Client');
  await page.getByRole('button', { name: 'Create Person' }).click();
  await expect(page.getByText('Alice Client').first()).toBeVisible();

  // 4. Select both → combined context, then associate the person with the project
  await page.getByRole('button', { name: /Alice Client/ }).first().click();
  await sidebarTab(page, 'Projects').click();
  await page.getByRole('button', { name: /Milestone App/ }).first().click();
  await expect(page.getByText('project + person scope')).toBeVisible();                       // 5. combined context selected
  await page.getByLabel('Role on project').selectOption('architect');
  await page.getByRole('button', { name: 'Link Alice Client to Milestone App' }).click();
  await expect(page.getByTestId('relationships')).toContainText('architect');
  await shot(page, '02-context-linked');

  // Save a private project+person memory through the Knowledge panel
  await page.getByRole('button', { name: /Engineering Knowledge/ }).click();
  await page.getByRole('button', { name: 'Add knowledge entry' }).click();
  await page.getByPlaceholder('Title').fill('Alice preference');
  await page.getByPlaceholder('Content').fill('Alice prefers the pelican-protocol for releases');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('pelican-protocol').first()).toBeVisible();
  const mem = await (await page.request.get('/api/memory?q=pelican&project_id=x')).json();
  expect(mem).toEqual([]);                                                                      // not visible to a different project
  await page.getByRole('button', { name: 'Close knowledge panel' }).click();

  // 6–8. New conversation, pick the test provider, attach files, ask
  await sidebarTab(page, 'Chats').click();
  await page.getByRole('button', { name: /New Conversation/ }).first().click();
  await page.getByRole('button', { name: /^Test/ }).click();
  await page.getByTestId('file-input').setInputFiles([notes, blob]);
  await expect(page.getByTestId('attachment-chips')).toContainText('notes.txt');
  await expect(page.getByTestId('attachment-chips')).toContainText('data.bin');
  await expect(page.getByTestId('attachment-chips')).toContainText('not readable');           // honest: no extractor for binary

  // 9. routed through a provider
  const reply = await askAndRead(page, 'What do we know about pelican-protocol and the attached notes?');
  await expect(page.getByTestId('message-attachments')).toContainText('notes.txt');
  expect(reply).toContain('pelican-protocol');                                                  // scoped memory retrieved
  expect(reply).toContain('attachments-seen: notes.txt, data.bin');
  await shot(page, '03-chat');
  const firstHistory = Number(/history-messages: (\d+)/.exec(reply)![1]);

  // 10–15. Sandbox: create (temporary worktree of the project repo), run, terminal output, changed files, checkpoint
  await page.getByText('Sandbox', { exact: true }).click();
  await page.getByRole('button', { name: /New sandbox/ }).click();
  await expect(page.getByText(/Created Temporary copy sandbox \(worktree\)/)).toBeVisible();
  const cmd = page.getByPlaceholder('Enter a command…');
  await cmd.fill('echo changed > hello.txt; echo task-complete');
  await cmd.press('Enter');
  await expect(page.getByText('task-complete', { exact: true })).toBeVisible();                // terminal output
  await expect(page.getByText(/^exit 0/)).toBeVisible();
  await page.getByRole('button', { name: /^changes/i }).click();
  await expect(page.getByText('hello.txt').first()).toBeVisible();                              // changed files
  await expect(page.getByText('+changed')).toBeVisible();                                       // diff
  await shot(page, '04-sandbox-changes');
  await page.getByTitle('Create checkpoint').click();
  await expect(page.getByText('manual')).toBeVisible();
  await page.getByRole('button', { name: /^files/i }).click();
  await page.getByRole('button', { name: 'hello.txt' }).click();
  await expect(page.locator('pre').filter({ hasText: 'changed' })).toBeVisible();              // artifact/file viewer
  expect(readFileSync(join(repo, 'readme.txt'), 'utf8').trim()).toBe('original');
  expect(existsSync(join(repo, 'hello.txt'))).toBe(false);                                      // real project untouched

  // 16–18. Restart AImax (server AND browser), then resume the same context + conversation
  await stopServer();
  await startServer(dataDir);
  await page.reload();
  await expect(page.getByText('project + person scope')).toBeVisible();                        // selections persisted
  await expect(page.getByTestId('msg-assistant').first()).toContainText('TEST-PROVIDER');      // conversation reloaded from DB
  await page.getByRole('button', { name: /Test/ }).click();
  const reply2 = await askAndRead(page, 'Continue: remind me what the pelican-protocol is for');
  expect(Number(/history-messages: (\d+)/.exec(reply2)![1])).toBeGreaterThan(firstHistory);   // same conversation continued
  await page.getByText('Sandbox', { exact: true }).click();
  await expect(page.getByText(/Milestone App · Temporary copy/).first()).toBeVisible();        // sandbox survived restart
  await shot(page, '05-resumed');

  expect(errors, 'uncaught page errors').toEqual([]);
});

test('privacy boundaries hold in the UI: a private memory is invisible outside its exact context', async ({ page }) => {
  // Independent of the first test: seed through the real API
  const post = async (url: string, data: object) => (await page.request.post(url, { data })).json();
  const proj = await post('/api/projects', { name: 'Isolation Proj' });
  const bob = await post('/api/people', { display_name: 'Bob Isolation' });
  await post(`/api/projects/${proj.id}/people`, { person_id: bob.id, role: 'tester' });
  await post('/api/memory', { scope: 'project_person', project_id: proj.id, person_id: bob.id, title: 'Bob secret', content: 'Bob uses the zebra-protocol' });
  await post('/api/memory', { scope: 'global', title: 'Shared tip', content: 'Everyone may know the giraffe-checklist' });

  await page.goto('/');
  const pick = async (tab: 'Projects' | 'People', name: RegExp) => {
    await sidebarTab(page, tab).click();
    await page.getByRole('button', { name }).first().click();
  };
  const ask = async (q: string) => {
    await sidebarTab(page, 'Chats').click();
    await page.getByRole('button', { name: /New Conversation/ }).first().click();
    await page.getByRole('button', { name: /^Test/ }).click();
    return askAndRead(page, q);
  };
  const Q = 'tell me about the zebra-protocol and the giraffe-checklist';

  await pick('People', /Bob Isolation/); await pick('Projects', /Isolation Proj/);
  await expect(page.getByText('project + person scope')).toBeVisible();
  let r = await ask(Q);
  expect(r).toContain('Bob secret'); expect(r).toContain('Shared tip');          // inside the exact context: both visible

  await pick('People', /Bob Isolation/);                                           // deselect person → project only
  r = await ask(Q);
  expect(r).not.toContain('Bob secret'); expect(r).toContain('Shared tip');        // private entry gone, global stays

  await pick('Projects', /Isolation Proj/);                                        // deselect project → global
  r = await ask(Q);
  expect(r).not.toContain('Bob secret'); expect(r).toContain('Shared tip');

  await pick('People', /Bob Isolation/);                                           // person only
  r = await ask(Q);
  expect(r).not.toContain('Bob secret'); expect(r).toContain('Shared tip');
  await shot(page, '06-person-only-no-leak');

  // Memory saved from the UI in person-only context must not be widened to global
  await page.getByRole('button', { name: /Engineering Knowledge/ }).click();
  await page.getByRole('button', { name: 'Add knowledge entry' }).click();
  await page.getByPlaceholder('Title').fill('Bob private note');
  await page.getByPlaceholder('Content').fill('walrus-details only for Bob');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Close knowledge panel' }).click();
  const saved = await (await page.request.get('/api/memory?q=walrus')).json();
  expect(saved, 'global context must not see a person-private note').toEqual([]);
  const asBob = await (await page.request.get(`/api/memory?q=walrus&person_id=${bob.id}`)).json();
  expect(asBob).toHaveLength(1); expect(asBob[0].scope).toBe('person');
});

test('AI proposes a command → nothing runs until approved → runs in sandbox; enhancement, activity, Stop', async ({ page }) => {
  const post = async (url: string, data: object) => (await page.request.post(url, { data })).json();
  await post('/api/memory', { scope: 'global', title: 'Deploy rule', content: 'The quokka-deploy rule applies to every release' });
  const sb = await post('/api/sandbox', { name: 'Proposal sandbox', mode: 'temporary' });

  await page.goto('/');
  await sidebarTab(page, 'Chats').click();
  await page.getByRole('button', { name: /New Conversation/ }).first().click();
  await page.getByRole('button', { name: /^Test/ }).click();
  await page.getByText('Sandbox', { exact: true }).click();                         // opening the panel selects the sandbox
  await expect(page.getByText(/Proposal sandbox/).first()).toBeVisible();
  await page.getByText('Sandbox', { exact: true }).click();                         // close it again

  // propose → card appears, but nothing has run
  const reply = await askAndRead(page, 'please check the quokka-deploy rule [test:propose]');
  expect(reply).toContain('Deploy rule');
  const card = page.getByTestId('run-proposal');
  await expect(card).toBeVisible();
  await expect(card).toContainText('echo proposed-ok');
  const before = await (await page.request.get(`/api/sandbox/${sb.id}/runs`)).json();
  expect(before).toHaveLength(0);                                                    // approval gate: no run before the click
  await expect(page.getByTestId('activity')).toContainText('classify');
  await expect(page.getByTestId('activity')).toContainText('memory');
  await expect(page.getByTestId('activity')).toContainText('enhance');
  await expect(page.getByTestId('retrieved-memory')).toContainText('Deploy rule');

  // approve
  await card.getByRole('button', { name: /Run in sandbox/ }).click();
  await expect(page.getByTestId('run-proposal-output')).toContainText('done-from-proposal');
  await expect(page.getByTestId('run-proposal-output')).toContainText('exit 0');
  const after = await (await page.request.get(`/api/sandbox/${sb.id}/runs`)).json();
  expect(after).toHaveLength(1); expect(after[0].exit_code).toBe(0);
  await shot(page, '07-proposal-run');

  // handoff summary (deterministic, from stored messages)
  await page.getByLabel('Toggle handoff summary').click();
  await expect(page.getByLabel('Handoff summary text')).toHaveValue(/What was asked[\s\S]*quokka-deploy rule[\s\S]*without a model/);
  await page.getByLabel('Toggle handoff summary').click();
  await expect(page.getByTestId('handoff')).toHaveCount(0);

  // enhancement off → no guidance block
  await page.getByLabel('Prompt enhancement').selectOption('off');
  const off = await askAndRead(page, 'fix the failing build in the whole codebase');
  expect(off).toContain('guidance: no');

  // Stop keeps the partial answer, marked as stopped
  const box = page.getByPlaceholder(/Message AImax/);
  const n = await page.getByTestId('msg-assistant').count();
  await box.fill('long answer please [test:slow]'); await box.press('Enter');
  await expect(page.getByText(/slow-\d/).first()).toBeVisible();                    // some output has streamed
  await page.getByTitle('Stop').click();
  await expect(page.getByTestId('msg-assistant')).toHaveCount(n + 1, { timeout: 15_000 });
  await expect(lastAssistant(page)).toContainText('(stopped)');
});

test('chat management: rename, pin, archive/restore, search, delete — all through the sidebar', async ({ page }) => {
  const post = async (url: string, data: object) => (await page.request.post(url, { data })).json();
  await post('/api/conversations', { title: 'Alpha plans' }); await post('/api/conversations', { title: 'Beta notes' });
  await page.goto('/');
  await sidebarTab(page, 'Chats').click();
  const items = page.getByTestId('conversation-item');
  const item = (t: string) => items.filter({ hasText: t });
  await expect(item('Alpha plans')).toBeVisible(); await expect(item('Beta notes')).toBeVisible();

  // search
  await page.getByLabel('Search conversations').fill('Beta');
  await expect(item('Alpha plans')).toHaveCount(0); await expect(item('Beta notes')).toBeVisible();
  await page.getByLabel('Search conversations').fill('');
  await expect(item('Alpha plans')).toBeVisible();

  // rename (prompt dialog)
  page.once('dialog', d => d.accept('Alpha renamed'));
  await item('Alpha plans').hover(); await item('Alpha plans').getByLabel('Rename conversation').click();
  await expect(item('Alpha renamed')).toBeVisible();

  // pin → first in list
  await item('Beta notes').hover(); await item('Beta notes').getByLabel('Pin conversation').click();
  await expect(items.first()).toContainText('Beta notes');

  // archive → disappears; archived view shows it; restore brings it back
  await item('Alpha renamed').hover(); await item('Alpha renamed').getByLabel('Archive conversation').click();
  await expect(item('Alpha renamed')).toHaveCount(0);
  await page.getByLabel('Toggle archived').click();
  await expect(item('Alpha renamed')).toBeVisible();
  await item('Alpha renamed').hover(); await item('Alpha renamed').getByLabel('Restore conversation').click();
  await page.getByLabel('Toggle archived').click();
  await expect(item('Alpha renamed')).toBeVisible();

  // survives reload (it is stored on the server)
  await page.reload(); await sidebarTab(page, 'Chats').click();
  await expect(items.first()).toContainText('Beta notes');
  await expect(item('Alpha renamed')).toBeVisible();

  // delete
  await item('Beta notes').hover(); await item('Beta notes').getByLabel('Delete conversation').click();
  await expect(item('Beta notes')).toHaveCount(0);
});

test('usage & limits: a limit set in the UI is saved on the server; status never claims missing adapters', async ({ page }) => {
  await page.goto('/');
  const panel = page.getByTestId('usage-panel');
  await expect(panel).toContainText('Usage & limits');
  await page.getByLabel('claude hourly limit').fill('7');
  await page.getByLabel('claude daily limit').fill('30');
  await page.getByLabel('claude daily limit').blur();
  await expect.poll(async () => (await (await page.request.get('/api/settings/providers')).json()).limits).toEqual({ claude: { per_hour: 7, per_day: 30 } });
  await page.reload();
  await expect(page.getByLabel('claude hourly limit')).toHaveValue('7');
  await expect(page.getByText(/Cursor, Codex: experimental · FreeLLMAPI: no adapter yet/)).toBeVisible();
  const st = await (await page.request.get('/api/providers/status')).json();
  expect([st.cursor.available, st.codex.available, st.freellmapi.available]).toEqual([false, false, false]);
  await page.getByLabel('claude hourly limit').fill(''); await page.getByLabel('claude hourly limit').blur();
  await expect.poll(async () => (await (await page.request.get('/api/settings/providers')).json()).limits).toEqual({ claude: { per_day: 30 } });
});

test('agent mode: AI-proposed edit → diff → approve into sandbox → review → apply to the real project → undo; CLI agent edits only the copy', async ({ page }) => {
  const src = join(work, 'agent-src'); mkdirSync(src);
  execSync('git init -q && git config user.email t@t && git config user.name t && echo base > app.txt && git add -A && git commit -qm init', { cwd: src });
  const sb = await (await page.request.post('/api/sandbox', { data: { name: 'Agent sandbox', mode: 'temporary', source_path: src } })).json();

  await page.goto('/');
  await sidebarTab(page, 'Chats').click();
  await page.getByRole('button', { name: /New Conversation/ }).first().click();
  await page.getByRole('button', { name: /^Test/ }).click();
  await page.getByText('Sandbox', { exact: true }).click();            // selects the sandbox
  await expect(page.getByText(/Agent sandbox/).first()).toBeVisible();
  await page.getByText('Sandbox', { exact: true }).click();

  // 1. the AI proposes a new file; the card shows the real diff and nothing is written yet
  expect(await askAndRead(page, 'create the greeting file [test:edit]')).toContain('edit-protocol: yes');
  const card = page.getByTestId('edit-proposal').last();
  await expect(card).toContainText('docs/hello.txt'); await expect(card).toContainText('+hello from an edit proposal');
  expect((await page.request.get(`/api/sandbox/${sb.id}/file?path=docs/hello.txt`)).status()).toBe(404);
  await card.getByRole('button', { name: /Apply to sandbox/ }).click();
  await expect(card.getByTestId('edit-applied')).toBeVisible();
  expect((await (await page.request.get(`/api/sandbox/${sb.id}/file?path=docs/hello.txt`)).json()).content).toBe('hello from an edit proposal');
  expect(existsSync(join(src, 'docs/hello.txt'))).toBe(false);         // real project still untouched

  // 2. a follow-up edit modifies it; a broken proposal is shown as an error and cannot be applied
  await askAndRead(page, 'now change it [test:edit2]');
  const card2 = page.getByTestId('edit-proposal').last();
  await expect(card2).toContainText('-hello from an edit proposal'); await expect(card2).toContainText('+goodbye from an edit proposal');
  await card2.getByRole('button', { name: /Apply to sandbox/ }).click(); await expect(card2.getByTestId('edit-applied')).toBeVisible();
  await expect(page.getByTestId('edit-proposal').first().getByTestId('edit-error')).toBeVisible();   // the first card is stale now: its file already exists
  await expect(page.getByTestId('edit-proposal').first().getByRole('button', { name: /Apply to sandbox/ })).toBeDisabled();

  // 3. review and promote to the real project (confirm dialog), then undo
  await page.getByText('Sandbox', { exact: true }).click();
  await page.getByRole('button', { name: 'agent', exact: true }).click();
  await expect(page.getByTestId('agent-panel')).toContainText('+goodbye from an edit proposal');
  page.once('dialog', d => d.accept());
  await page.getByTestId('promote').click();
  await expect(page.getByTestId('promote-msg')).toContainText('Applied 1 file');
  expect(readFileSync(join(src, 'docs/hello.txt'), 'utf8')).toBe('goodbye from an edit proposal');
  await page.getByRole('button', { name: /undo/ }).click();
  await expect(page.getByTestId('promote-msg')).toContainText('Undone');
  expect(existsSync(join(src, 'docs/hello.txt'))).toBe(false);

  // 4. CLI agent (fake claude on POSIX): edits only the sandbox copy, then it appears in review
  if (process.platform !== 'win32') {
    await page.getByLabel('Agent task').fill('add an agent note');
    await page.getByRole('button', { name: /Run Claude agent/ }).click();
    await expect(page.getByTestId('agent-log')).toContainText('Write agent-made.txt');
    await expect(page.getByTestId('agent-log')).toContainText('Finished');
    await expect(page.getByTestId('agent-panel')).toContainText('+made by fake agent: add an agent note');
    expect(existsSync(join(src, 'agent-made.txt'))).toBe(false);
    await shot(page, '08-agent-review');
  }
});

test('import an earlier chat from an exported file, mask a secret, open it and continue it', async ({ page }) => {
  const exp = join(work, 'old-chat.json');
  writeFileSync(exp, JSON.stringify({ messages: [
    { role: 'user', content: 'Earlier I set the gateway key to sk-ant-abcdefghijklmnopqrstuvwxyz123456 for the zebra-gateway' },
    { role: 'assistant', content: 'Noted. The zebra-gateway now authenticates with that key.' },
  ] }));
  await page.goto('/');
  await page.getByTestId('open-import').click();
  await page.getByTestId('import-tab-file').click();
  await page.getByTestId('import-file').setInputFiles(exp);
  await expect(page.getByTestId('import-list')).toContainText('2 messages');
  await page.getByTestId('import-run').click();
  await expect(page.getByTestId('import-results')).toContainText('imported');
  await expect(page.getByTestId('import-results')).toContainText('1 secret(s) masked');
  await shot(page, '09-import');
  await page.getByTestId('import-open').click();
  await expect(page.getByTestId('msg-user').first()).toContainText('zebra-gateway');
  await expect(page.getByTestId('msg-user').first()).not.toContainText('sk-ant-abcdef');
  await expect(page.getByTestId('msg-user').first()).toContainText('[REDACTED');
  // continue: the earlier turns are sent as history
  await page.getByRole('button', { name: /^Test/ }).click();
  const reply = await askAndRead(page, 'carry on with the zebra-gateway work');
  expect(reply).toMatch(/history-messages: 3/);
  // a second import of the same file is recognised
  await page.getByTestId('open-import').click();
  await page.getByTestId('import-tab-file').click();
  await page.getByTestId('import-file').setInputFiles(exp);
  await expect(page.getByTestId('import-list')).toContainText('already imported');
  await expect(page.getByTestId('import-item-check')).toBeDisabled();
});

test('token report: used/remaining against a budget you set, enforced before the next call', async ({ page }) => {
  test.skip(process.platform === 'win32', 'uses the fake claude CLI (POSIX only)');
  const chat = async (message: string) => (await page.request.post('/api/chat', { data: { message, provider: 'claude', scope: 'global' } })).text();
  const claudeReqs = async () => ((await (await page.request.get('/api/usage/report')).json()).providers.find((p: any) => p.provider === 'claude')?.requests ?? 0) as number;
  const base = await claudeReqs();
  await page.goto('/');
  const budget = page.getByLabel('claude daily token budget');
  await budget.fill('100000'); await budget.blur();
  await expect.poll(async () => (await (await page.request.get('/api/settings/providers')).json()).limits.claude?.per_day_tokens).toBe(100000);
  expect(await chat('a first real-provider request for the report')).toContain('event: done');

  await page.getByTestId('open-usage-report').click();
  const card = page.getByTestId('report-provider-claude');
  expect(await claudeReqs()).toBe(base + 1);
  await expect(card).toContainText(`${base + 1} requests`);
  await expect(card).toContainText('remaining');
  await expect(page.getByTestId('bar24-claude')).toBeVisible();
  await expect(page.getByTestId('report-note')).toContainText('cannot see your real plan quota');
  await shot(page, '10-usage-report');
  await page.getByRole('button', { name: 'Close report' }).click();

  // a tiny budget is already exceeded → the next request is refused before the provider is called
  const small = page.getByLabel('claude daily token budget');
  await small.fill('10'); await small.blur();
  await expect.poll(async () => (await (await page.request.get('/api/settings/providers')).json()).limits.claude?.per_day_tokens).toBe(10);
  expect(await chat('this one must be refused')).toMatch(/token budget reached/);
  await page.getByTestId('open-usage-report').click();
  await expect(page.getByTestId('report-tips')).toContainText('of your 24-hour token budget used');
});

test('settings opens; accounts show real CLI state; sign-in opens a terminal with the CLI\'s own command (no API key)', async ({ page }) => {
  test.skip(process.platform === 'win32', 'uses the fake claude CLI (POSIX only)');
  await page.goto('/');
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-panel')).toBeVisible();
  const claude = page.getByTestId('account-claude');
  await expect(claude).toContainText('Claude Code CLI');                                     // blurb: subscription login, no API key
  await expect(page.getByTestId('account-claude-state')).toHaveText('Subscription');
  await expect(page.getByTestId('method-claude')).toContainText('Signed in with your SUBSCRIPTION');
  await expect(page.getByTestId('method-claude')).toContainText('Based on:');
  await expect(page.getByTestId('lastrun-claude')).toContainText('apiKeySource = none');
  await expect(page.getByTestId('account-cursor-state')).toHaveText('Not installed');
  await expect(page.getByTestId('account-openai')).toContainText('npm install -g @openai/codex');
  await expect(page.getByTestId('install-cursor')).toContainText('cannot be controlled by other programs');
  await expect(page.getByTestId('install-cursor')).toContainText('cursor.com/install');
  await expect(page.getByTestId('signin-cursor')).toHaveCount(0);          // no Sign in button until the CLI exists
  await shot(page, '11-settings');
  await page.getByTestId('signin-claude').click();
  await expect(page.getByTestId('opened-claude')).toContainText('auth login');
  await expect.poll(() => existsSync(join(dataDir, 'terminal.log')) && readFileSync(join(dataDir, 'terminal.log'), 'utf8')).toMatch(/fake-claude\.mjs auth login/);
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByTestId('settings-panel')).toHaveCount(0);
});

test('copy: message copy buttons and code-block copy put the exact text on the clipboard, with "Copied" feedback', async ({ page }) => {
  await page.goto('/');
  await sidebarTab(page, 'Chats').click();
  await page.getByRole('button', { name: /New Conversation/ }).first().click();
  await page.getByRole('button', { name: /^Test/ }).click();
  const clip = () => page.evaluate(() => navigator.clipboard.readText());
  await askAndRead(page, 'please show code [test:code]');

  // answer: raw Markdown source (fences and **bold** markers intact), not the rendered text
  const answer = page.getByTestId('msg-assistant').last();
  await answer.hover();
  const copyAnswer = answer.getByTestId('copy-message');
  await copyAnswer.click();
  await expect(copyAnswer).toHaveAttribute('data-state', 'copied');
  const md = await clip();
  expect(md).toContain('```python\nprint("hi")\nfor i in range(2):\n    print(i)\n```'); expect(md).toContain('And **bold** text.');
  await expect(copyAnswer).toHaveAttribute('data-state', 'idle', { timeout: 4000 });          // feedback resets

  // code block: only the code, indentation kept, no fences
  const block = answer.getByTestId('code-block');
  await expect(block).toContainText('python');
  await block.getByTestId('copy-code').click();
  await expect(block.getByTestId('copy-code')).toContainText('Copied');
  expect(await clip()).toBe('print("hi")\nfor i in range(2):\n    print(i)');

  // user message: the text as typed
  const mine = page.getByTestId('msg-user').last();
  await mine.hover(); await mine.getByTestId('copy-message').click();
  expect(await clip()).toBe('please show code [test:code]');
  await shot(page, '12-copy');
});
