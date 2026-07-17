import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Fires / doesn't-fire pairs for the catalog items added by the licensed-source coverage refresh.
// Each checklist item is only worth its judge cost if its regex trigger actually discriminates:
// these tests stage a minimal file in a fixture repo, run the real `checklist.mjs generate`
// (spawned — vitest excludes skills/**), and assert the item's presence/absence in the state file.

const skillScript = (skill) =>
  fileURLToPath(new URL(`../../skills/${skill}/scripts/checklist.mjs`, import.meta.url));

const STATE_FILE = {
  'api-security': '.claude/.api-security-review.json',
  'backend-performance': '.claude/.backend-performance-review.json',
  'frontend-performance': '.claude/.frontend-performance-review.json',
  'frontend-security': '.claude/.frontend-security-review.json',
};

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

/** Stage `content` in a fixture repo, run `generate`, return the enumerated item names. */
function generatedItems(skill, content) {
  const repo = mkdtempSync(join(tmpdir(), 'catalog-trigger-'));
  dirs.push(repo);
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-q']);
  writeFileSync(
    join(repo, 'guard.config.json'),
    JSON.stringify({ review: { backendRoots: ['src'], frontendRoots: ['src'] } }),
  );
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'staged.ts'), content);
  git(['add', '.']);
  const r = spawnSync('node', [skillScript(skill), 'generate'], { cwd: repo, encoding: 'utf8' });
  expect(r.status).toBe(0);
  const state = JSON.parse(readFileSync(join(repo, STATE_FILE[skill]), 'utf8'));
  return state.items.map((i) => i.name);
}

const CASES = [
  {
    skill: 'api-security',
    item: 'mass-assignment',
    fires: 'await db.user.update({ where: { id }, data: { ...req.body } });\n',
    quiet: 'await db.user.update({ where: { id }, data: { name: parsed.name } });\n',
  },
  {
    skill: 'api-security',
    item: 'command-injection',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture content — the staged bug IS a template interpolation into execSync
    fires: "import { execSync } from 'node:child_process';\nexecSync(`convert ${name}`);\n",
    quiet: 'export const convert = (name: string) => transforms[name]();\n',
  },
  {
    skill: 'api-security',
    item: 'path-traversal',
    // sink + request-input marker must BOTH be present
    fires:
      "import { readFile } from 'node:fs/promises';\nconst doc = await readFile(req.params.name);\n",
    quiet:
      "import { readFile } from 'node:fs/promises';\nconst doc = await readFile(MANIFEST_PATH);\n",
  },
  {
    skill: 'api-security',
    item: 'object-level-authz',
    fires: 'const invoice = await db.invoice.findUnique({ where: { id: req.params.id } });\n',
    quiet: 'const invoice = await db.invoice.findUnique({ where: { id: SEED_ID } });\n',
  },
  {
    skill: 'api-security',
    item: 'open-redirect',
    fires: 'res.redirect(target);\n',
    quiet: 'res.json({ location: target });\n',
  },
  {
    skill: 'api-security',
    item: 'ssrf-prevention',
    fires: 'const upstream = await fetch(webhookUrl);\n',
    quiet: "const upstream = await fetch('https://api.example.com/health');\n",
  },
  {
    skill: 'backend-performance',
    item: 'sync-io',
    fires: "import { readFileSync } from 'node:fs';\nconst manifest = readFileSync(p, 'utf8');\n",
    quiet: "import { existsSync } from 'node:fs';\nif (existsSync(p)) load(p);\n",
  },
  {
    skill: 'backend-performance',
    item: 'unbounded-cache',
    fires: 'const sessionCache = new Map();\n',
    quiet: 'const seen = new Set(ids);\n',
  },
  {
    skill: 'frontend-performance',
    item: 'layout-thrash',
    fires: 'const rect = node.getBoundingClientRect();\n',
    quiet: 'const rect = layoutModel.rectFor(node);\n',
  },
  {
    skill: 'frontend-performance',
    item: 'animation-performance',
    fires: "el.style.transition = 'left 200ms ease';\n",
    quiet: "el.style.transition = 'opacity 200ms ease';\n",
  },
  {
    skill: 'frontend-security',
    item: 'postmessage-origin',
    fires: "window.addEventListener('message', (e) => apply(e.data));\n",
    quiet: "window.addEventListener('click', (e) => apply(e.detail));\n",
  },
];

describe('catalog trigger regexes (fires / stays quiet pairs)', () => {
  for (const { skill, item, fires, quiet } of CASES) {
    it(`${skill}/${item} fires on its construct`, () => {
      expect(generatedItems(skill, fires)).toContain(item);
    });
    it(`${skill}/${item} stays quiet on the safe twin`, () => {
      expect(generatedItems(skill, quiet)).not.toContain(item);
    });
  }
});

describe('prose staged files are excluded from the scan', () => {
  // A README full of trigger words ("password", "token", "cache", "transition") rides along
  // with a real source change: its prose must not add checklist items for the judge to
  // hallucinate on. The state file should reflect only the source file's constructs.
  const PROSE =
    '# Auth guide\n\nStore the password hash, rotate the token, cache sessions, transition state.\n';
  it('api-security ignores a staged .md under the root', () => {
    const repo = mkdtempSync(join(tmpdir(), 'catalog-prose-'));
    dirs.push(repo);
    const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git(['init', '-q']);
    writeFileSync(
      join(repo, 'guard.config.json'),
      JSON.stringify({ review: { backendRoots: ['src'], frontendRoots: ['src'] } }),
    );
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'README.md'), PROSE);
    writeFileSync(join(repo, 'src', 'staged.ts'), 'export const noop = () => {};\n');
    git(['add', '.']);
    const r = spawnSync('node', [skillScript('api-security'), 'generate'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    const state = JSON.parse(readFileSync(join(repo, STATE_FILE['api-security']), 'utf8'));
    expect(state.files).toEqual(['src/staged.ts']);
    expect(state.items.map((i) => i.name)).not.toContain('auth-mechanism');
  });
});
