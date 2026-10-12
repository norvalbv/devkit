#!/usr/bin/env node
// Writer replay for the re-target carry/drop listing. README.md pre-registers the protocol.
// usage: node replay.mjs build [--check] | labels <q7-final-labels.tsv> | controls | call --phase probe|full | score
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, '../../../..');
const CORPUS = 'c29e78e6';
const MODELS = { opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5' };
const RUNS =
  process.env.REPLAY_RUNS ??
  join(homedir(), '.devkit/research/2026-10-11-retarget-carry-replay/runs');
const TIMEOUT_MS = 300_000;
const MAX_ATTEMPTS = 3;
const TARGET_HEAD_RE = /^## Target · /gm;
const FLAG_SPLIT_RE = /--(carry|drop)\b/;
const ID_RE = /(?:note:)?(\d{4}-\d{2}-\d{2}(?:~\d+)?)/g;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const readJsonl = (f) =>
  existsSync(f)
    ? readFileSync(f, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const gitShow = (path) =>
  execFileSync('git', ['-C', ROOT, 'show', `${CORPUS}:${path}`], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });

/** The prototype under test; a computed specifier so the record still parses if the module never ships. */
async function prototype() {
  const at = (p) => pathToFileURL(join(ROOT, p)).href;
  return {
    ...(await import(at('gate-engine/decisions/write/retarget-carry.mts'))),
    ...(await import(at('gate-engine/decisions/decision-format.mts'))),
    ...(await import(at('gate-engine/decisions/recall/note-relations.mts'))),
  };
}

/** Every listed note under every superseded Target: the CLI's listing at each historical re-target. */
function collapsed(m, body) {
  const heads = [...body.matchAll(TARGET_HEAD_RE)].map((h) => h.index);
  return heads.slice(1).flatMap((at) => m.outgoingNotes(body.slice(0, at)));
}

function render(m, slug, notes, block) {
  return [
    `You are recording a new Target on the decision axis "${slug}" with \`guard-decisions add ${slug} --target …\`. The new Target is shown at the end. The CLI printed:`,
    '',
    m.formatPending(slug, notes),
    '',
    '=== THE NEW TARGET ===',
    block,
    '',
    'Reply with one line holding only the arguments: --carry "<ids>" --drop "<ids>". Name every listed id exactly once.',
  ].join('\n');
}

/** The 14 prompts as the prototype renders them from the corpus. */
async function renderAll() {
  const m = await prototype();
  const axes = execFileSync(
    'git',
    ['-C', ROOT, 'ls-tree', '--name-only', CORPUS, 'docs/decisions/'],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter((p) => p.endsWith('.md') && !p.endsWith('INDEX.md'));
  const rows = [];
  for (const path of axes) {
    const slug = path.slice('docs/decisions/'.length, -3);
    const body = m.parseDecision(gitShow(path)).body;
    const notes = collapsed(m, body);
    if (!notes.length) continue;
    const prompt = render(m, slug, notes, m.currentTarget(body).block);
    const prior = m
      .outgoingNotes(body.slice(0, [...body.matchAll(TARGET_HEAD_RE)].at(-1).index))
      .map((n) => n.id);
    rows.push({
      slug,
      ids: notes.map((n) => n.id),
      prior,
      chars: prompt.length,
      promptSha256: sha256(prompt),
      prompt,
    });
  }
  return rows;
}

async function build(check) {
  const rows = await renderAll();
  const text = `${rows.map(({ prompt, ...r }) => JSON.stringify(r)).join('\n')}\n`;
  const out = join(DIR, 'prompts.jsonl');
  if (!check)
    return (
      writeFileSync(out, text),
      console.log(
        `${rows.length} axes, ${rows.reduce((s, r) => s + r.ids.length, 0)} listed notes → prompts.jsonl`,
      )
    );
  if (readFileSync(out, 'utf8') !== text)
    throw new Error('prompts.jsonl differs from what the current module renders');
  console.log('prompts.jsonl matches the current module byte for byte');
}

/** Q7 ids are `<slug>#<part>.<n>` over `body.split('\n## ')`; pair each, in document order, with its note id. */
async function labels(q7File) {
  const m = await prototype();
  const gold = readFileSync(q7File, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => l.split('\t'));
  const ids = new Map();
  for (const slug of new Set(gold.map(([q7]) => q7.split('#')[0]))) {
    const body = m.parseDecision(gitShow(`docs/decisions/${slug}.md`)).body;
    const notes = m.axisNotes(body);
    let next = 0;
    for (const [pi, part] of body.split('\n## ').entries())
      for (const [ni, line] of part
        .split('\n')
        .filter((l) => m.NOTE_BULLET_RE.test(l))
        .entries()) {
        const at = notes.findIndex(
          (n, i) => i >= next && line.startsWith(`- ${n.date}`) && line.trimEnd().endsWith(n.text),
        );
        if (at !== -1) next = at + 1;
        ids.set(`${slug}#${pi}.${ni}`, at === -1 ? '-' : notes[at].id);
      }
  }
  const out = ['q7_id\tslug\tnote_id\tlabel\tguard\tscored_as'];
  for (const [q7, label, guard] of gold)
    out.push(
      [q7, q7.split('#')[0], ids.get(q7) ?? '-', label, guard, scoredAs(q7, label, guard)].join(
        '\t',
      ),
    );
  writeFileSync(join(DIR, 'labels.tsv'), `${out.join('\n')}\n`);
  console.log(`${out.length - 1} labels → labels.tsv`);
}

const A_REPO = new Set([
  'gate-opt-out-is-visible-and-detectable#1.0',
  'coverage-gate#1.5',
  'agent-comment-firewall#2.1',
  'agent-comment-firewall#2.2',
  'agent-comment-firewall#2.3',
  'agent-comment-firewall#2.4',
  'agent-comment-firewall#3.0',
]);
const EXCLUDED = new Set(['agent-comment-firewall#4.1', 'plan-critique-evidence-loop#3.0']);

function scoredAs(q7, label, guard) {
  if (EXCLUDED.has(q7)) return 'excluded';
  if (label === 'D' && guard === 'N') return 'C1';
  if (A_REPO.has(q7)) return 'A-repo';
  if (label === 'A' || label === 'C') return 'C2-text';
  return label === 'D' ? 'D-T' : label;
}

function loadLabels() {
  const [head, ...rows] = readFileSync(join(DIR, 'labels.tsv'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => l.split('\t'));
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

/** Count carried items per scoring class from a set of carried `slug#note-id` keys. */
function tally(labelRows, carried) {
  const t = {};
  for (const l of labelRows) {
    const c = (t[l.scored_as] ??= { n: 0, carried: 0, unlisted: 0 });
    c.n += 1;
    if (l.note_id === '-') c.unlisted += 1;
    if (carried.has(`${l.slug}#${l.note_id}`)) c.carried += 1;
  }
  return t;
}

const verdict = (t) => ({
  c1Pass: t.C1.carried >= 28,
  c2Pass: t['C2-text'].carried <= 4,
  pass: t.C1.carried >= 28 && t['C2-text'].carried <= 4,
});

function controls() {
  const rows = loadLabels();
  const prompts = readJsonl(join(DIR, 'prompts.jsonl'));
  const listed = new Set(prompts.flatMap((p) => p.ids.map((id) => `${p.slug}#${id}`)));
  const gold = new Set(
    rows.filter((l) => l.scored_as === 'C1').map((l) => `${l.slug}#${l.note_id}`),
  );
  const out = {};
  for (const [name, carried] of [
    ['always-carry', listed],
    ['always-drop', new Set()],
    ['gold-oracle', gold],
  ]) {
    const t = tally(rows, new Set([...carried].filter((k) => listed.has(k))));
    out[name] = {
      C1: `${t.C1.carried}/${t.C1.n}`,
      C2: `${t['C2-text'].carried}/${t['C2-text'].n}`,
      ...verdict(t),
    };
  }
  console.log(JSON.stringify(out, null, 2));
  return out;
}

function callWriter(model, prompt) {
  const cwd = mkdtempSync(join(tmpdir(), 'retarget-replay-'));
  const argv = [
    '-p',
    '--model',
    model,
    '--output-format',
    'json',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--setting-sources',
    '',
    '--disallowedTools',
    '*',
    '--settings',
    '{"disableAllHooks":true}',
    '--no-session-persistence',
  ];
  const env = { ...process.env, DEVKIT_NO_TELEMETRY: '1' };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn('claude', argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    const finish = (exitCode) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      let parsed = {};
      try {
        parsed = JSON.parse(stdout);
      } catch {}
      resolve({
        argv,
        startedAt: new Date(t0).toISOString(),
        ms: Date.now() - t0,
        exitCode,
        answer: parsed.result ?? '',
        isError: parsed.is_error ?? true,
        costUsd: parsed.total_cost_usd ?? null,
        modelUsage: Object.keys(parsed.modelUsage ?? {}),
        stderrTail: stderr.slice(-300),
      });
    };
    child.on('error', (e) => {
      stderr += String(e);
      finish(null);
    });
    child.on('close', finish);
    child.stdin.end(prompt);
  });
}

async function call(phase) {
  const frozen = new Map(
    readJsonl(join(DIR, 'prompts.jsonl')).map((p) => [p.slug, p.promptSha256]),
  );
  const prompts = await renderAll();
  for (const p of prompts)
    if (frozen.get(p.slug) !== p.promptSha256)
      throw new Error(`${p.slug}: prompt differs from the frozen prompts.jsonl`);
  if (frozen.size !== prompts.length)
    throw new Error('prompts.jsonl and the rendered set name different axes');
  const cells =
    phase === 'probe'
      ? Object.entries(MODELS).flatMap(([alias, model]) =>
          prompts.map((p) => ({ alias, model, rep: 1, p })),
        )
      : [2, 3].flatMap((rep) =>
          prompts.map((p) => ({ alias: 'opus', model: MODELS.opus, rep, p })),
        );
  mkdirSync(RUNS, { recursive: true });
  const out = join(RUNS, `${phase}.jsonl`);
  const done = new Map();
  for (const r of readJsonl(out))
    done.set(
      `${r.model}|${r.rep}|${r.slug}`,
      r.ok ? MAX_ATTEMPTS : (done.get(`${r.model}|${r.rep}|${r.slug}`) ?? 0) + 1,
    );
  const queue = cells.filter(
    (c) => (done.get(`${c.model}|${c.rep}|${c.p.slug}`) ?? 0) < MAX_ATTEMPTS,
  );
  const headSha = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  console.log(`${phase}: ${queue.length} calls → ${out}`);
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      for (
        let attempt = (done.get(`${c.model}|${c.rep}|${c.p.slug}`) ?? 0) + 1;
        attempt <= MAX_ATTEMPTS;
        attempt += 1
      ) {
        const r = await callWriter(c.model, c.p.prompt);
        const ok = r.exitCode === 0 && !r.isError && r.answer.trim() !== '';
        appendFileSync(
          out,
          `${JSON.stringify({ phase, alias: c.alias, model: c.model, rep: c.rep, slug: c.p.slug, promptSha256: c.p.promptSha256, attempt, headSha, ...r, ok })}\n`,
        );
        if (ok) break;
      }
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.REPLAY_CONCURRENCY ?? 3) }, worker));
}

/** Parse one answer: the ids under --carry and --drop, invalid ids, and listed ids left unanswered. */
function parseAnswer(answer, listed) {
  const named = { carry: [], drop: [] };
  const parts = answer.split(FLAG_SPLIT_RE);
  for (let i = 1; i < parts.length; i += 2)
    named[parts[i]].push(...[...parts[i + 1].matchAll(ID_RE)].map((m) => `note:${m[1]}`));
  const both = named.carry.filter((id) => named.drop.includes(id));
  const invalid = [...named.carry, ...named.drop].filter((id) => !listed.includes(id));
  const carry = named.carry.filter((id) => listed.includes(id) && !both.includes(id));
  const answered = new Set([...named.carry, ...named.drop]);
  return {
    carry,
    drop: named.drop.filter((id) => listed.includes(id) && !both.includes(id)),
    both,
    invalid,
    unanswered: listed.filter((id) => !answered.has(id)),
  };
}

function score() {
  const prompts = new Map(readJsonl(join(DIR, 'prompts.jsonl')).map((p) => [p.slug, p]));
  const rows = [
    ...readJsonl(join(RUNS, 'probe.jsonl')),
    ...readJsonl(join(RUNS, 'full.jsonl')),
  ].filter((r) => r.ok);
  const results = rows.map((r) => ({
    model: r.model,
    rep: r.rep,
    slug: r.slug,
    promptSha256: r.promptSha256,
    costUsd: r.costUsd,
    ms: r.ms,
    ...parseAnswer(r.answer, prompts.get(r.slug).ids),
  }));
  writeFileSync(join(DIR, 'results.json'), `${JSON.stringify(results, null, 1)}\n`);
  const labelRows = loadLabels();
  const carriedBy = (model, reps) => {
    const keys = new Set();
    for (const p of prompts.values())
      for (const id of p.ids) {
        const votes = results.filter(
          (r) => r.model === model && r.slug === p.slug && reps.includes(r.rep),
        );
        if (votes.filter((r) => r.carry.includes(id)).length * 2 > reps.length)
          keys.add(`${p.slug}#${id}`);
      }
    return keys;
  };
  const summary = { corpus: CORPUS, models: MODELS, calls: rows.length, gating: {}, reported: {} };
  const opus = tally(labelRows, carriedBy(MODELS.opus, [1, 2, 3]));
  summary.gating.opusMajorityK3 = {
    C1: `${opus.C1.carried}/${opus.C1.n}`,
    C2text: `${opus['C2-text'].carried}/${opus['C2-text'].n}`,
    ...verdict(opus),
  };
  summary.reported.opusClasses = opus;
  summary.reported.haikuK1 = tally(labelRows, carriedBy(MODELS.haiku, [1]));
  const prior = new Set(
    [...prompts.values()].flatMap((p) => p.prior.map((id) => `${p.slug}#${id}`)),
  );
  const priorRows = labelRows.filter((l) => prior.has(`${l.slug}#${l.note_id}`));
  summary.reported.immediatelyPriorTarget = {
    opus: tally(priorRows, carriedBy(MODELS.opus, [1, 2, 3])),
    haiku: tally(priorRows, carriedBy(MODELS.haiku, [1])),
  };
  summary.reported.opusPerRep = [1, 2, 3].map((rep) =>
    tally(labelRows, carriedBy(MODELS.opus, [rep])),
  );
  summary.reported.perAxis = [...prompts.keys()].map((slug) => {
    const own = labelRows.filter((l) => l.slug === slug);
    return {
      slug,
      listed: prompts.get(slug).ids.length,
      opus: tally(own, carriedBy(MODELS.opus, [1, 2, 3])),
      haiku: tally(own, carriedBy(MODELS.haiku, [1])),
    };
  });
  const unanimous = [...prompts.values()].flatMap((p) =>
    p.ids.map(
      (id) =>
        new Set(
          [1, 2, 3].map((rep) =>
            results.some(
              (r) =>
                r.model === MODELS.opus &&
                r.rep === rep &&
                r.slug === p.slug &&
                r.carry.includes(id),
            ),
          ),
        ).size === 1,
    ),
  );
  summary.reported.opusAllRepsAgree = `${unanimous.filter(Boolean).length}/${unanimous.length}`;
  summary.reported.invalidAnswers = results.filter((r) => r.invalid.length || r.both.length).length;
  summary.reported.unansweredItems = results.reduce((s, r) => s + r.unanswered.length, 0);
  summary.reported.costUsd = results.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  writeFileSync(join(DIR, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`);
  console.log(JSON.stringify(summary.gating, null, 1));
}

const [cmd, ...rest] = process.argv.slice(2);
const phase = rest[rest.indexOf('--phase') + 1];
const run = {
  build: () => build(rest.includes('--check')),
  labels: () => labels(rest[0]),
  controls,
  call: () => call(phase),
  score,
}[cmd];
if (!run)
  throw new Error(
    'usage: replay.mjs build [--check] | labels <tsv> | controls | call --phase probe|full | score',
  );
await run();
