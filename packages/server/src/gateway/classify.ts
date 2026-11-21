/** Deterministic task classification (no model call). First matching rule wins; order encodes priority. */
export type TaskType = 'bugfix' | 'feature' | 'refactor' | 'testing' | 'architecture' | 'documentation' | 'ui' | 'security'
  | 'performance' | 'deployment' | 'research' | 'configuration' | 'question';

const RULES: Array<[TaskType, RegExp]> = [
  ['security', /\b(vulnerab\w*|cve-\d|xss|csrf|sql ?injection|auth(entication|orization)? (bypass|flaw)|secrets?\b.*(leak|exposed)|threat model|pen ?test)/i],
  ['bugfix', /\b(bugs?|broken|crash(es|ed|ing)?|exceptions?|stack ?trace|errors?|fails?|failing|failures?|doesn'?t work|not working|regression|npe|fix(es|ed)? (the |this |a )?(bug|issue|error|crash|failure|failing))\b/i],
  ['testing', /\b(unit tests?|integration tests?|e2e|test coverage|write tests?|add tests?|playwright|jest|junit|vitest|mock)\b/i],
  ['performance', /\b(slow|latency|performance|optimi[sz]e|memory leak|throughput|profil(e|ing)|n\+1|bottleneck)\b/i],
  ['refactor', /\b(refactor|clean ?up|restructure|rename|extract (a )?(method|function|class|component)|tech(nical)? debt|simplif(y|ication))\b/i],
  ['ui', /\b(ui|ux|layout|css|tailwind|responsive|accessib\w*|a11y|component|button|modal|dark mode|design system)\b/i],
  ['deployment', /\b(deploy\w*|docker(file)?|kubernetes|k8s|ci\/cd|pipeline|github actions|release|helm|terraform)\b/i],
  ['configuration', /\b(config(ure|uration)?|env(ironment)? vars?|settings?|\.env|application\.ya?ml|tsconfig|webpack|vite\.config)\b/i],
  ['documentation', /\b(document(ation)?|readme|docstring|jsdoc|javadoc|changelog|explain (this|the) code|write (a )?guide)\b/i],
  ['architecture', /\b(architect\w*|design (a|the) (system|service|api|schema)|trade-?offs?|microservices?|monolith|scalab\w*|data model|erd)\b/i],
  ['feature', /\b(add|implement|create|build|support|introduce|new feature|endpoint|integrate)\b/i],
  ['research', /\b(compare|research|investigate|survey|alternatives?|pros and cons|which (library|framework)|best practices?)\b/i],
];

export interface Classification { type: TaskType; complexity: 'low' | 'medium' | 'high'; signals: string[] }

export function classifyTask(text: string): Classification {
  const t = text.trim();
  const signals: string[] = [];
  let type: TaskType = 'question';
  for (const [kind, re] of RULES) { if (re.test(t)) { type = kind; signals.push(`matched:${kind}`); break; } }

  let score = 0;
  if (t.length > 600) { score += 2; signals.push('long-message'); } else if (t.length > 200) score += 1;
  if (/```/.test(t) || /\bat [\w.$]+\([\w.]+:\d+\)/.test(t)) { score += 1; signals.push('has-code-or-trace'); }
  if ((t.match(/\b(and|then|also|additionally)\b/gi) ?? []).length >= 3) { score += 1; signals.push('multi-step'); }
  if (/\b(across|all|every|entire|whole)\b[^.\n]{0,20}\b(codebase|repo|project|services?|modules?)\b/i.test(t)) { score += 2; signals.push('wide-scope'); }
  if (type === 'architecture' || type === 'security') score += 1;
  return { type, complexity: score >= 3 ? 'high' : score >= 1 ? 'medium' : 'low', signals };
}
