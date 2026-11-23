# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e/milestone.spec.ts >> pasted links are read and shown as context; private addresses and failures are reported; the setting turns it off
- Location: e2e/milestone.spec.ts:498:1

# Error details

```
Error: Command failed: git init -q && git config user.email t@t && git config user.name t && echo original > readme.txt && git add -A && git commit -qm init
/bin/sh: 1: git: not found

```

# Test source

```ts
  1   | /**
  2   |  * First working milestone (master prompt §151), driven through the real UI in a real browser,
  3   |  * against the real server and SQLite database. Only the AI provider is the deterministic test provider.
  4   |  */
  5   | import { test, expect, type Page } from '@playwright/test';
  6   | import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
  7   | import { tmpdir } from 'node:os';
  8   | import { join } from 'node:path';
  9   | import { execSync } from 'node:child_process';
  10  | import { startServer, stopServer } from './server';
  11  | 
  12  | const SHOTS = join(__dirname, 'screenshots');
  13  | mkdirSync(SHOTS, { recursive: true });
  14  | 
  15  | const dataDir = mkdtempSync(join(tmpdir(), 'aimax-e2e-data-'));
  16  | const work = mkdtempSync(join(tmpdir(), 'aimax-e2e-work-'));
  17  | const repo = join(work, 'milestone-repo');
  18  | const notes = join(work, 'notes.txt');
  19  | const blob = join(work, 'data.bin');
  20  | 
  21  | test.beforeAll(async () => {
  22  |   mkdirSync(repo);
> 23  |   execSync('git init -q && git config user.email t@t && git config user.name t && echo original > readme.txt && git add -A && git commit -qm init', { cwd: repo });
      |   ^ Error: Command failed: git init -q && git config user.email t@t && git config user.name t && echo original > readme.txt && git add -A && git commit -qm init
  24  |   writeFileSync(notes, 'attachment-marker-42: the deploy key rotates every 90 days');
  25  |   writeFileSync(blob, Buffer.from([0, 1, 2, 3, 0, 255]));
  26  |   await startServer(dataDir);
  27  | });
  28  | test.afterAll(async () => { await stopServer(); });
  29  | 
  30  | const sidebarTab = (page: Page, title: string) => page.locator(`button[title="${title}"]`).first();
  31  | const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  32  | const lastAssistant = (page: Page) => page.getByTestId('msg-assistant').last();
  33  | 
  34  | async function askAndRead(page: Page, text: string) {
  35  |   const before = await page.getByTestId('msg-assistant').count();
  36  |   const box = page.getByPlaceholder(/Message AImax/);
  37  |   await box.fill(text); await box.press('Enter');
  38  |   await expect(page.getByTestId('msg-assistant')).toHaveCount(before + 1, { timeout: 15_000 });
  39  |   await expect(lastAssistant(page)).toContainText('TEST-PROVIDER');
  40  |   return lastAssistant(page).innerText();
  41  | }
  42  | 
  43  | test('first working milestone: project → person → link → context → chat+attachment → sandbox → restart → resume', async ({ page }) => {
  44  |   page.on('dialog', d => d.accept(d.defaultValue()));      // confirm()/prompt() dialogs (checkpoint label etc.)
  45  |   const errors: string[] = [];
  46  |   page.on('pageerror', e => errors.push(String(e)));
  47  | 
  48  |   // 1. Open AImax in a browser
  49  |   await page.goto('/');
  50  |   await expect(page.getByRole('heading', { name: 'AImax' })).toBeVisible();
  51  |   await shot(page, '01-home');
  52  | 
  53  |   // 2. Create a project (with a real repo path)
  54  |   await sidebarTab(page, 'Projects').click();
  55  |   await page.getByRole('button', { name: /New Project/ }).click();
  56  |   await page.getByPlaceholder('My Project').fill('Milestone App');
  57  |   await page.getByPlaceholder(/my-repo/).fill(repo);
  58  |   await page.getByRole('button', { name: 'Create Project' }).click();
  59  |   await expect(page.getByText('Milestone App').first()).toBeVisible();
  60  | 
  61  |   // 3. Create a person
  62  |   await sidebarTab(page, 'People').click();
  63  |   await page.getByRole('button', { name: /New Person/ }).click();
  64  |   await page.getByPlaceholder('Full Name').fill('Alice Client');
  65  |   await page.getByRole('button', { name: 'Create Person' }).click();
  66  |   await expect(page.getByText('Alice Client').first()).toBeVisible();
  67  | 
  68  |   // 4. Select both → combined context, then associate the person with the project
  69  |   await page.getByRole('button', { name: /Alice Client/ }).first().click();
  70  |   await sidebarTab(page, 'Projects').click();
  71  |   await page.getByRole('button', { name: /Milestone App/ }).first().click();
  72  |   await expect(page.getByText('project + person scope')).toBeVisible();                       // 5. combined context selected
  73  |   await page.getByLabel('Role on project').selectOption('architect');
  74  |   await page.getByRole('button', { name: 'Link Alice Client to Milestone App' }).click();
  75  |   await expect(page.getByTestId('relationships')).toContainText('architect');
  76  |   await shot(page, '02-context-linked');
  77  | 
  78  |   // Save a private project+person memory through the Knowledge panel
  79  |   await page.getByRole('button', { name: /Engineering Knowledge/ }).click();
  80  |   await page.getByRole('button', { name: 'Add knowledge entry' }).click();
  81  |   await page.getByPlaceholder('Title').fill('Alice preference');
  82  |   await page.getByPlaceholder('Content').fill('Alice prefers the pelican-protocol for releases');
  83  |   await page.getByRole('button', { name: 'Save', exact: true }).click();
  84  |   await expect(page.getByText('pelican-protocol').first()).toBeVisible();
  85  |   const mem = await (await page.request.get('/api/memory?q=pelican&project_id=x')).json();
  86  |   expect(mem).toEqual([]);                                                                      // not visible to a different project
  87  |   await page.getByRole('button', { name: 'Close knowledge panel' }).click();
  88  | 
  89  |   // 6–8. New conversation, pick the test provider, attach files, ask
  90  |   await sidebarTab(page, 'Chats').click();
  91  |   await page.getByRole('button', { name: /New Conversation/ }).first().click();
  92  |   await page.getByRole('button', { name: /^Test/ }).click();
  93  |   await page.getByTestId('file-input').setInputFiles([notes, blob]);
  94  |   await expect(page.getByTestId('attachment-chips')).toContainText('notes.txt');
  95  |   await expect(page.getByTestId('attachment-chips')).toContainText('data.bin');
  96  |   await expect(page.getByTestId('attachment-chips')).toContainText('not readable');           // honest: no extractor for binary
  97  | 
  98  |   // 9. routed through a provider
  99  |   const reply = await askAndRead(page, 'What do we know about pelican-protocol and the attached notes?');
  100 |   await expect(page.getByTestId('message-attachments')).toContainText('notes.txt');
  101 |   expect(reply).toContain('pelican-protocol');                                                  // scoped memory retrieved
  102 |   expect(reply).toContain('attachments-seen: notes.txt, data.bin');
  103 |   await shot(page, '03-chat');
  104 |   const firstHistory = Number(/history-messages: (\d+)/.exec(reply)![1]);
  105 | 
  106 |   // 10–15. Sandbox: create (temporary worktree of the project repo), run, terminal output, changed files, checkpoint
  107 |   await page.getByText('Sandbox', { exact: true }).click();
  108 |   await page.getByRole('button', { name: /New sandbox/ }).click();
  109 |   await expect(page.getByText(/Created Temporary copy sandbox \(worktree\)/)).toBeVisible();
  110 |   const cmd = page.getByPlaceholder('Enter a command…');
  111 |   await cmd.fill('echo changed > hello.txt; echo task-complete');
  112 |   await cmd.press('Enter');
  113 |   await expect(page.getByText('task-complete', { exact: true })).toBeVisible();                // terminal output
  114 |   await expect(page.getByText(/^exit 0/)).toBeVisible();
  115 |   await page.getByRole('button', { name: /^changes/i }).click();
  116 |   await expect(page.getByText('hello.txt').first()).toBeVisible();                              // changed files
  117 |   await expect(page.getByText('+changed')).toBeVisible();                                       // diff
  118 |   await shot(page, '04-sandbox-changes');
  119 |   await page.getByTitle('Create checkpoint').click();
  120 |   await expect(page.getByText('manual')).toBeVisible();
  121 |   await page.getByRole('button', { name: /^files/i }).click();
  122 |   await page.getByRole('button', { name: 'hello.txt' }).click();
  123 |   await expect(page.locator('pre').filter({ hasText: 'changed' })).toBeVisible();              // artifact/file viewer
```