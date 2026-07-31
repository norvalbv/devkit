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
function generatedItems(skill, content, filename = 'staged.ts') {
  const repo = mkdtempSync(join(tmpdir(), 'catalog-trigger-'));
  dirs.push(repo);
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-q']);
  writeFileSync(
    join(repo, 'guard.config.json'),
    JSON.stringify({ review: { backendRoots: ['src'], frontendRoots: ['src'] } }),
  );
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', filename), content);
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
  // Always-fire trigger tightening: each quiet twin is the exact false-positive class that made
  // the item fire on virtually every ship in telemetry while never once failing.
  {
    skill: 'frontend-security',
    item: 'oauth-security',
    fires: "const target = AUTH_BASE + '?redirect_uri=' + encodeURIComponent(cb);\n",
    quiet: 'const [state, setState] = useState(initialScope);\n',
  },
  {
    skill: 'frontend-security',
    item: 'input-validation',
    fires: 'const field = <input value={name} onChange={setName} />;\n',
    quiet: 'const value = computeTotal(rows);\n',
  },
  {
    skill: 'api-security',
    item: 'oauth-security',
    fires: "const url = base + '?client_id=' + CLIENT_ID + '&response_type=code';\n",
    quiet: 'const state = machine.state; const scope = currentScope();\n',
  },
  {
    skill: 'api-security',
    item: 'sql-injection',
    fires: "const q = 'SELECT id FROM users WHERE org_id = 1';\n",
    quiet: 'const me = useQuery(); const tab = routerQuery.tab;\n',
  },
  {
    skill: 'api-security',
    item: 'input-validation',
    fires: 'const parsed = schema.parse(req.body);\n',
    quiet: 'const tab = router.query.tab;\n',
  },
  {
    skill: 'api-security',
    item: 'error-handling',
    fires: 'try { await run(); } catch (err) { respond(500); }\n',
    quiet: 'const error = lastRun.error; respond(error);\n',
  },
  {
    skill: 'api-security',
    item: 'logging-security',
    fires: "logger.info({ userId }, 'session started');\n",
    quiet: 'const loginState = validateLogic(payload);\n',
  },
  {
    skill: 'api-security',
    item: 'processing-security',
    fires: "app.post('/upload', handleUpload);\n",
    quiet: 'const file = resolvePath(dir, name); copy(file);\n',
  },
  {
    skill: 'backend-performance',
    item: 'db-query-optimization',
    fires: 'const rows = await prisma.user.findMany({ orgId });\n',
    quiet: 'const result = client.query(text);\n',
  },
  {
    skill: 'backend-performance',
    item: 'pagination',
    fires: 'return paginate(items, { offset });\n',
    quiet: 'const limit = MAX_ITEMS; loadPage(page, limit);\n',
  },
  {
    skill: 'backend-performance',
    item: 'indexing',
    // Same filename for both halves: proves the a/src/index.ts diff-header path alone no
    // longer trips the item, while real index work in that same file still does.
    file: 'index.ts',
    fires: "const rows = await db.findMany({ orderBy: { createdAt: 'desc' } });\n",
    quiet: 'export const noop = () => {};\n',
  },
  {
    skill: 'backend-performance',
    item: 'async-handling',
    fires: 'for (const sub of subs) { await deliver(sub); }\n',
    quiet: 'const user = await getUser(id); return toJson(user);\n',
  },
  {
    skill: 'backend-performance',
    item: 'connection-pooling',
    fires: 'const pool = new Pool({ connectionString });\n',
    quiet: 'const opts = { max: 5, idle: 30, timeout: 1000 };\n',
  },
  {
    skill: 'backend-performance',
    item: 'logging-overhead',
    fires: "logger.debug({ payload }, 'delivering');\n",
    quiet: 'const loginError = await login(user);\n',
  },
  {
    skill: 'backend-performance',
    item: 'n-plus-one',
    fires: 'const users = ids.map((id) => repo.find(id));\n',
    // A .map( far from an unrelated await: the bounded gap must not couple them.
    quiet: `const ids = rows.map((r) => r.id);\n// ${'x'.repeat(400)}\nawait flush(ids);\n`,
  },
  {
    skill: 'frontend-performance',
    item: 'bundle-size',
    fires: "import { chart } from 'd3';\n",
    quiet: "import type { Props } from 'react';\nimport { helper } from './helper';\n",
  },
  {
    skill: 'frontend-performance',
    item: 'dependency-size',
    // Multi-line import: the from-clause line still counts as an added package dependency.
    fires: "import {\n  BarChart,\n} from 'recharts';\n",
    quiet: "import type { Props } from 'react';\nimport { helper } from './helper';\n",
  },
  {
    skill: 'frontend-performance',
    item: 'css-optimization',
    fires: "import './theme.css';\n",
    quiet: "const row = <div className={cx('row')} />;\n",
  },
  {
    skill: 'frontend-performance',
    item: 'hooks-optimization',
    // Regression pin: this trigger holds real catches — tightening elsewhere must not touch it.
    fires: 'useEffect(() => { sync(); }, [deps]);\n',
    quiet: 'const effect = buildEffect();\n',
  },
];

describe('catalog trigger regexes (fires / stays quiet pairs)', () => {
  for (const { skill, item, fires, quiet, file } of CASES) {
    it(`${skill}/${item} fires on its construct`, () => {
      expect(generatedItems(skill, fires, file)).toContain(item);
    });
    it(`${skill}/${item} stays quiet on the safe twin`, () => {
      expect(generatedItems(skill, quiet, file)).not.toContain(item);
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
