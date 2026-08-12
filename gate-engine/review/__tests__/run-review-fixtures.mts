import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { REVIEWERS } from '../reviewers.mts';

export const COMMIT_GUARD_INIT_SCRIPT = `
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('.claude', { recursive: true });
writeFileSync(
  '.claude/.pre-commit-review.json',
  JSON.stringify({ files: [{ path: 'src/fixture.ts', status: 'pending', issues: [] }] }),
);
`;

const trackedDirs: string[] = [];

export function trackReviewFixtureDir(dir: string): string {
  trackedDirs.push(dir);
  return dir;
}

export function cleanupReviewFixtures(): void {
  while (trackedDirs.length) rmSync(trackedDirs.pop() as string, { recursive: true, force: true });
}

// A consumer repo with a backend/frontend topology, synced agent briefs, and one staged file
// per requested domain. Returns its root.
export function consumerRepo({
  backend = false,
  frontend = false,
  styles = false,
  emptyFrontendRoots = false,
} = {}): string {
  const repo = trackReviewFixtureDir(mkdtempSync(join(tmpdir(), 'guard-review-gate-')));
  execSync('git init -q', { cwd: repo });
  writeFileSync(
    join(repo, 'guard.config.json'),
    JSON.stringify({
      scanRoots: ['src'],
      review: {
        backendRoots: ['src/main'],
        // The shipped templates/generic shape on a frontend repo: the domain is live, its roots
        // are not declared, and the two frontend reviewers are therefore never selected.
        frontendRoots: emptyFrontendRoots ? [] : ['src/renderer'],
      },
    }),
  );
  const agents = join(repo, '.claude', 'agents');
  mkdirSync(agents, { recursive: true });
  for (const name of [
    'api-security-reviewer',
    'backend-performance-reviewer',
    'frontend-security-reviewer',
    'frontend-performance-reviewer',
    'commit-guard',
    'correctness-reviewer',
    'conventions-reviewer',
    'feature-completeness-reviewer',
  ]) {
    writeFileSync(join(agents, `${name}.md`), `---\nname: ${name}\n---\nBrief for ${name}.`);
  }
  const commitGuardScript = join(
    repo,
    '.claude',
    'skills',
    'commit-guard',
    'scripts',
    'checklist.mjs',
  );
  mkdirSync(join(repo, '.claude', 'skills', 'commit-guard', 'scripts'), { recursive: true });
  writeFileSync(commitGuardScript, COMMIT_GUARD_INIT_SCRIPT);
  if (backend) {
    mkdirSync(join(repo, 'src', 'main'), { recursive: true });
    writeFileSync(join(repo, 'src', 'main', 'db.ts'), 'export const q = 1;\n');
  }
  if (frontend) {
    mkdirSync(join(repo, 'src', 'renderer'), { recursive: true });
    writeFileSync(join(repo, 'src', 'renderer', 'App.tsx'), 'export const A = 1;\n');
  }
  if (styles) {
    mkdirSync(join(repo, 'src', 'renderer'), { recursive: true });
    writeFileSync(join(repo, 'src', 'renderer', 'theme.scss'), '.a { color: red; }\n');
  }
  execSync('git add .', { cwd: repo });
  return repo;
}

export function reviewAssets(): string {
  const root = trackReviewFixtureDir(mkdtempSync(join(tmpdir(), 'guard-review-assets-')));
  mkdirSync(join(root, 'agents'), { recursive: true });
  mkdirSync(join(root, 'skills', '_devkit'), { recursive: true });
  writeFileSync(join(root, 'skills', '_devkit', 'review-roots.mjs'), '// shared support\n');
  writeFileSync(join(root, 'skills', '_devkit', 'checklist-store.mjs'), '// shared store\n');
  for (const reviewer of REVIEWERS) {
    writeFileSync(
      join(root, 'agents', `${reviewer.name}.md`),
      `---\nname: ${reviewer.name}\n---\nPACKAGED brief for ${reviewer.name}.`,
    );
    if (!reviewer.skill) continue;
    mkdirSync(join(root, 'skills', reviewer.skill, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'skills', reviewer.skill, 'SKILL.md'), `# ${reviewer.skill}\n`);
    writeFileSync(
      join(root, 'skills', reviewer.skill, 'scripts', 'checklist.mjs'),
      reviewer.name === 'commit-guard' ? COMMIT_GUARD_INIT_SCRIPT : '#!/usr/bin/env node\n',
    );
    if (reviewer.skill === 'commit-guard') {
      mkdirSync(join(root, 'skills', reviewer.skill, 'references'), { recursive: true });
      writeFileSync(
        join(root, 'skills', reviewer.skill, 'references', 'co-occurrence.md'),
        '# detector contract\n',
      );
    }
  }
  return root;
}

export function syncSkillAssets(repo: string): void {
  mkdirSync(join(repo, '.claude', 'skills', '_devkit'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'skills', '_devkit', 'review-roots.mjs'), 'export {};\n');
  writeFileSync(join(repo, '.claude', 'skills', '_devkit', 'checklist-store.mjs'), 'export {};\n');
  for (const skill of [
    'api-security',
    'backend-performance',
    'frontend-security',
    'frontend-performance',
    'commit-guard',
    'correctness',
  ]) {
    mkdirSync(join(repo, '.claude', 'skills', skill, 'scripts'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
    writeFileSync(
      join(repo, '.claude', 'skills', skill, 'scripts', 'checklist.mjs'),
      skill === 'commit-guard' ? COMMIT_GUARD_INIT_SCRIPT : `// ${skill} checklist\n`,
    );
    if (skill === 'commit-guard') {
      mkdirSync(join(repo, '.claude', 'skills', skill, 'references'), { recursive: true });
      writeFileSync(
        join(repo, '.claude', 'skills', skill, 'references', 'co-occurrence.md'),
        '# detector contract\n',
      );
    }
  }
}

// Fake judge runners. Each returns a Promise<string|null> like execJudgeAsync.
export const mkExec = (impl) => vi.fn(impl);

// A real judge leaves a checklist state-file artifact behind (the anti-hallucination contract) —
// fake judges must too, or every PASS is voided to inconclusive. Reviewer identity rides the label.
export const reviewerFromLabel = (label) =>
  REVIEWERS.find((r) => label === `review:${r.name}` || label === `review:${r.name}:escalate`);

export function writeArtifact(repo, label, { pending = 0, failed = 0 } = {}): void {
  const reviewer = reviewerFromLabel(label);
  // A skill-less reviewer (conventions-reviewer) has no checklist stateFile — nothing to write;
  // its PASS is trusted directly (see run-review.mts's `hasChecklist` branch).
  if (!reviewer?.stateFile) return;
  const key = reviewer.name === 'commit-guard' ? 'files' : 'items';
  const mk = (status, i) =>
    reviewer.name === 'commit-guard'
      ? { path: `src/f${i}.ts`, status, issues: [] }
      : { name: `check-${status}-${i}`, category: 'X', status, issues: [] };
  const rows = [
    mk('pass', 0),
    ...Array.from({ length: pending }, (_, i) => mk('pending', i + 1)),
    ...Array.from({ length: failed }, (_, i) => mk('fail', i + 1)),
  ];
  writeFileSync(join(repo, reviewer.stateFile), JSON.stringify({ [key]: rows }));
}

// PASS judge that honours the checklist contract (writes a complete artifact).
export const passWithArtifact = (repo) =>
  mkExec(async ({ label }) => {
    writeArtifact(repo, label);
    return 'looks fine\nVERDICT: PASS';
  });

// A judge that brackets each invocation with an in-flight counter so a test can assert the gate's
// concurrency cap. The `await` on a macrotask (setTimeout) forces overlap: without a cap all selected
// reviewers would sit in-flight together. `failFirst` returns null on the FIRST call per label (an
// outage that earns the strict retry) then passes — so the retry is a second sequential exec inside
// the SAME cascade slot, proving the cap counts cascades, not raw exec calls.
export function concurrencyProbe(repo, { failFirst = false } = {}) {
  let inflight = 0;
  let max = 0;
  const failed = new Set();
  const exec = mkExec(async ({ label }) => {
    inflight++;
    max = Math.max(max, inflight);
    try {
      await new Promise((resolve) => setTimeout(resolve));
      if (failFirst && !failed.has(label)) {
        failed.add(label);
        return null;
      }
      writeArtifact(repo, label);
      return 'VERDICT: PASS';
    } finally {
      inflight--;
    }
  });
  return { exec, maxInflight: () => max };
}
