#!/usr/bin/env node
import { execSync } from 'child_process';

const API = 'http://localhost:3001';
const cmd = process.argv[2];
const args = process.argv.slice(3);

async function api(path, options) {
  try {
    const res = await fetch(`${API}${path}`, options);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

switch (cmd) {
  case 'status': {
    const health = await api('/api/health');
    if (health) {
      console.log(`AImax server: running (v${health.version})`);
      const providers = await api('/api/providers/status');
      if (providers) {
        console.log(`  Claude:  ${providers.claude?.available ? '✓ available' : '✗ not detected'}`);
        console.log(`  Ollama:  ${providers.ollama?.available ? `✓ ${providers.ollama.models?.length} model(s)` : '✗ not running'}`);
        console.log(`  Cursor:  ${providers.cursor?.available ? '✓' : '✗ not detected'}`);
      }
    } else {
      console.log('AImax server: not running');
      console.log('Start with:  npm run dev  (from AImax directory)');
    }
    break;
  }

  case 'doctor': {
    console.log('AImax Environment Check\n');
    const tools = [
      ['node --version', 'Node.js'],
      ['npm --version', 'npm'],
      ['claude --version', 'Claude Code'],
      ['ollama --version', 'Ollama'],
      ['git --version', 'Git'],
      ['docker --version', 'Docker'],
      ['python --version', 'Python'],
    ];
    for (const [c, label] of tools) {
      try {
        const v = execSync(c, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n')[0];
        console.log(`  ✓ ${label.padEnd(14)} ${v}`);
      } catch {
        console.log(`  ✗ ${label.padEnd(14)} not found`);
      }
    }
    const health = await api('/api/health');
    console.log(`\nAImax server: ${health ? `running v${health.version}` : 'not running (start with: npm run dev)'}`);
    break;
  }

  case 'projects': {
    if (args[0] === 'list') {
      const projects = await api('/api/projects');
      if (!projects?.length) { console.log('No projects. Create one in the UI.'); break; }
      console.log('\nProjects:');
      for (const p of projects) {
        console.log(`  ${p.id.slice(0, 8)}  ${p.name.padEnd(30)} [${p.status}] ${p.category}`);
      }
    }
    break;
  }

  case 'people': {
    if (args[0] === 'list') {
      const people = await api('/api/people');
      if (!people?.length) { console.log('No people. Add them in the UI.'); break; }
      console.log('\nPeople:');
      for (const p of people) {
        console.log(`  ${p.id.slice(0, 8)}  ${p.display_name.padEnd(30)} ${p.role || p.relationship}`);
      }
    }
    break;
  }

  case 'memory': {
    if (args[0] === 'search' && args[1]) {
      const results = await api(`/api/memory?q=${encodeURIComponent(args[1])}`);
      if (!results?.length) { console.log('No results.'); break; }
      console.log(`\nMemory results for "${args[1]}":\n`);
      for (const r of results) {
        console.log(`  [${r.type}] ${r.title}`);
        console.log(`  ${r.content.slice(0, 150).replace(/\n/g, ' ')}`);
        console.log();
      }
    }
    break;
  }

  default:
    console.log(`
AImax CLI v0.1.0
Maximum Intelligence. Minimum Waste.

Commands:
  aimax status            Show server and provider status
  aimax doctor            Check environment and dependencies
  aimax projects list     List all projects
  aimax people list       List all people
  aimax memory search <q> Search MemoryVault

UI: http://localhost:5173  (after: npm run dev)
`);
}
