/**
 * Raw-store extractors for the edge-cases corpus harvest. BUN-ONLY (bun:sqlite) — this is the one
 * file in edge-cases-eval allowed to import bun:sqlite; schema.mts/scrub.mts must stay node-clean
 * because the vitest gate imports them.
 *
 * Three stores, three fidelity levels (see README):
 *  - claude-code: ~/.claude/projects transcripts — full tool I/O, carries the corpus
 *  - frink-app: agents.db sub_chats — full fidelity, mostly folds into claude-code via session_id
 *  - cursor: globalStorage state.vscdb — text-only bubbles, summary anchors, no model metadata
 *
 * Every extractor emits the same raw-candidate shape; nothing here calls an LLM.
 */

import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ANCHOR_PHRASE, classifyPromptVariant, EXCLUDED_REPOS, sha8 } from './schema.mts';

const HOME = homedir();
const APP_SUPPORT = path.join(HOME, 'Library/Application Support');
const CC_PROJECTS = path.join(HOME, '.claude/projects');
const CURSOR_GLOBAL_DB = path.join(APP_SUPPORT, 'Cursor/User/globalStorage/state.vscdb');
const CURSOR_WORKSPACES = path.join(APP_SUPPORT, 'Cursor/User/workspaceStorage');
const FRINK_DBS = [
  { flavor: 'dev', file: path.join(APP_SUPPORT, 'Frink Dev/data/agents.db') },
  { flavor: 'prod', file: path.join(APP_SUPPORT, 'frink/data/agents.db') },
];

const GIT_DIFF_RE = /\bgit\b[^\n;|&]*\b(diff|show)\b/;
const GIT_STAT_RE = /\bgit\b[^\n;|&]*\b(diff|show|status)\b/;
const HAS_HUNKS_RE = /^diff --git |^@@ /m;
const TEST_CMD_RE = /\b(vitest|bun (run )?test|npm (run )?test|yarn test|pytest)\b/;

/**
 * Diff recovery ladder over the session's git tool calls ({pos, command, output}, ordered):
 *  1. largest in-turn output with real hunks;
 *  2. else nearest output with hunks BEFORE the invocation (the prompt says "the git diff related
 *     to what we've built" — the anchoring diff was often already printed earlier in the session);
 *  3. any in-turn/nearest-preceding stat-ish git output kept separately as statText (nameStatus hint).
 */
const pickDiff = (events, invocationPos, endPos) => {
  const inTurn = events.filter((e) => e.pos > invocationPos && e.pos < endPos);
  const before = events.filter((e) => e.pos < invocationPos);
  const hunked = (list) =>
    list.filter((e) => GIT_DIFF_RE.test(e.command) && HAS_HUNKS_RE.test(e.output));
  const diffFull =
    hunked(inTurn).sort((a, b) => b.output.length - a.output.length)[0]?.output ??
    hunked(before).at(-1)?.output ??
    '';
  const statText =
    inTurn.find((e) => GIT_STAT_RE.test(e.command) && e.output)?.output ??
    before.filter((e) => GIT_STAT_RE.test(e.command) && e.output).at(-1)?.output ??
    '';
  return { diffFull, statText: diffFull ? '' : statText };
};
const MAX_TOOL_OUTPUT = 64 * 1024;
const MAX_DIFF_RAW = 200 * 1024;
const MAX_TEXT = 32 * 1024;

const KNOWN_REPOS = ['owners-web', 'frink-marketing', 'qavis', 'devkit', 'frink'];
export const detectRepo = (p) => {
  if (!p) return 'other:unknown';
  const lower = p.toLowerCase();
  for (const name of KNOWN_REPOS) if (lower.includes(name)) return name;
  return `other:${path.basename(p)}`;
};

const cap = (s, n) =>
  typeof s === 'string' && s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s;

/** frink-app tool outputs are envelopes ({stdout, stderr, …}); claude-code results are plain text. */
const bashOut = (o) =>
  typeof o === 'string' ? o : `${o?.stdout ?? ''}${o?.stderr ? `\n${o.stderr}` : ''}`;

/** Commit SHAs a `git commit` prints (e.g. "[main abc1234] subject"). Session shas split into
 * pre-invocation (what was built → diff reconstruction) and post (fixes → label evidence). */
const COMMIT_LINE_RE = /\[[\w./-]+(?: \(root-commit\))? ([0-9a-f]{7,12})\]/g;
const OTHER_PREFIX_RE = /^other:/;
const shasIn = (text) => [...(text ?? '').matchAll(COMMIT_LINE_RE)].map((m) => m[1]);

const tryParse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const makeCandidate = (fields) => {
  const promptText = fields.promptText ?? '';
  return {
    source: fields.source,
    sourceRef: fields.sourceRef,
    sessionId: fields.sessionId ?? null,
    repo: fields.repo,
    branch: fields.branch ?? null,
    prNumber: fields.prNumber ?? null,
    date: fields.date,
    model: fields.model ?? null,
    provider: fields.provider,
    promptText: cap(promptText, MAX_TEXT),
    promptVariant: classifyPromptVariant(promptText),
    promptSha: sha8(promptText.toLowerCase().replace(/\s+/g, ' ')),
    diffFull: cap(fields.diffFull ?? '', MAX_DIFF_RAW) || null,
    diffOrigin: fields.diffFull ? 'in-session' : null,
    statText: cap(fields.statText ?? '', 4096) || null,
    preCommits: [...new Set(fields.preCommits ?? [])],
    postCommits: [...new Set(fields.postCommits ?? [])],
    editedFiles: [...new Set(fields.editedFiles ?? [])],
    responseText: cap(fields.responseText ?? '', MAX_TEXT * 4),
    turnActivity: fields.turnActivity ?? { filesWritten: [], testRuns: [] },
    aftermath: fields.aftermath ?? { userTurns: [], filesWritten: [], testRuns: [] },
    crossRefs: [],
    id: `${{ 'claude-code': 'cc', 'frink-app': 'fk', cursor: 'cu' }[fields.source]}-${fields.repo.replace(OTHER_PREFIX_RE, '')}-${fields.date.slice(0, 10).replaceAll('-', '')}-${sha8(fields.sourceRef)}`,
  };
};

// ── frink-app (agents.db) ────────────────────────────────────────────────────────────────────────

const snapshotDb = (file, rawDir, name) => {
  const snapDir = path.join(rawDir, 'snapshots');
  mkdirSync(snapDir, { recursive: true });
  const snap = path.join(snapDir, `${name}.db`);
  rmSync(snap, { force: true });
  try {
    const live = new Database(file, { readonly: true });
    live.exec(`VACUUM INTO '${snap.replaceAll("'", "''")}'`);
    live.close();
  } catch {
    // VACUUM INTO refused (locked/old sqlite) — fall back to copying db+wal and let sqlite recover.
    copyFileSync(file, snap);
    for (const ext of ['-wal', '-shm'])
      if (existsSync(file + ext)) copyFileSync(file + ext, snap + ext);
  }
  return snap;
};

const partText = (m) =>
  (m.parts ?? [])
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');

export function harvestFrinkApp(rawDir) {
  const candidates = [];
  for (const { flavor, file } of FRINK_DBS) {
    if (!existsSync(file)) continue;
    const db = new Database(snapshotDb(file, rawDir, `agents-${flavor}`), { readonly: true });
    const rows = db
      .query(
        `SELECT sc.id, sc.session_id, sc.messages, sc.created_at, c.branch, c.pr_number, c.worktree_path
         FROM sub_chats sc LEFT JOIN chats c ON c.id = sc.chat_id
         WHERE sc.messages LIKE '%' || ? || '%'`,
      )
      .all(ANCHOR_PHRASE);
    for (const row of rows) {
      const messages = JSON.parse(row.messages);
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        // User text part only — excludes flow-authoring sessions where the phrase sits inside
        // frink_flows_get/patch tool parts of assistant messages.
        if (m.role !== 'user' || !partText(m).includes(ANCHOR_PHRASE)) continue;
        let end = i + 1;
        while (end < messages.length && messages[end].role !== 'user') end++;
        const turn = messages.slice(i + 1, end);
        const models = new Set(turn.flatMap((t) => Object.keys(t.metadata?.modelUsage ?? {})));
        const events = [];
        const commitEvents = [];
        let pos = 0;
        let invocationPos = -1;
        let endPos = Number.MAX_SAFE_INTEGER;
        for (let j = 0; j < messages.length; j++) {
          if (j === i) invocationPos = pos;
          if (j === end) endPos = pos;
          for (const p of messages[j].parts ?? []) {
            pos++;
            if (p.type !== 'tool-Bash') continue;
            const cmd = p.input?.command ?? '';
            const output = bashOut(p.output);
            if (GIT_STAT_RE.test(cmd)) events.push({ pos, command: cmd, output });
            for (const sha of shasIn(output)) commitEvents.push({ pos, sha });
          }
        }
        const { diffFull, statText } = pickDiff(events, invocationPos, endPos);
        const preCommits = commitEvents.filter((e) => e.pos < invocationPos).map((e) => e.sha);
        const postCommits = commitEvents.filter((e) => e.pos > invocationPos).map((e) => e.sha);
        const editedFiles = [];
        for (const t of messages.slice(0, i))
          for (const p of t.parts ?? [])
            if (p.type === 'tool-Write' || p.type === 'tool-Edit') {
              const fp = p.input?.file_path ?? p.input?.path;
              if (fp) editedFiles.push(fp);
            }
        // In-turn tool activity — where the prompt's commanded test-writing/TDD-fixing happens, and
        // the only place an f2p (test seen failing, then passing) can be observed.
        const turnActivity = { filesWritten: [], testRuns: [] };
        for (const t of turn)
          for (const p of t.parts ?? []) {
            if (p.type === 'tool-Write' || p.type === 'tool-Edit') {
              const fp = p.input?.file_path ?? p.input?.path;
              if (fp) turnActivity.filesWritten.push(fp);
            }
            if (p.type === 'tool-Bash' && TEST_CMD_RE.test(p.input?.command ?? ''))
              turnActivity.testRuns.push({
                command: cap(p.input.command, 512),
                output: cap(bashOut(p.output), 4096),
              });
          }
        const aftermath = { userTurns: [], filesWritten: [], testRuns: [] };
        for (const t of messages.slice(end)) {
          if (t.role === 'user') aftermath.userTurns.push(cap(partText(t), 2048));
          for (const p of t.parts ?? []) {
            if (p.type === 'tool-Write' || p.type === 'tool-Edit') {
              const fp = p.input?.file_path ?? p.input?.path;
              if (fp) aftermath.filesWritten.push(fp);
            }
            if (p.type === 'tool-Bash' && TEST_CMD_RE.test(p.input?.command ?? ''))
              aftermath.testRuns.push({
                command: cap(p.input.command, 512),
                output: cap(bashOut(p.output), 4096),
              });
          }
        }
        candidates.push(
          makeCandidate({
            source: 'frink-app',
            sourceRef: `agents-${flavor}:sub_chats/${row.id}#msg=${m.id}`,
            sessionId: row.session_id,
            repo:
              detectRepo(row.worktree_path) === 'other:unknown'
                ? 'frink'
                : detectRepo(row.worktree_path),
            branch: row.branch,
            prNumber: row.pr_number,
            date: new Date(row.created_at * 1000).toISOString(),
            model: [...models][0] ?? null,
            provider: 'frink-app',
            promptText: partText(m),
            diffFull,
            statText,
            preCommits,
            postCommits,
            editedFiles,
            turnActivity,
            responseText: turn.map(partText).filter(Boolean).join('\n\n'),
            aftermath,
          }),
        );
      }
    }
    db.close();
  }
  return candidates;
}

// ── claude-code (~/.claude/projects transcripts) ─────────────────────────────────────────────────

const stripReminders = (s) =>
  s
    .replaceAll(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replaceAll(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '');

const ccText = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
};

const parseTranscript = (file) => {
  const lines = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    const obj = tryParse(raw);
    if (!obj || (obj.type !== 'user' && obj.type !== 'assistant')) continue;
    const content = obj.message?.content;
    const entry = {
      uuid: obj.uuid,
      type: obj.type,
      isSidechain: !!obj.isSidechain,
      timestamp: obj.timestamp,
      cwd: obj.cwd,
      gitBranch: obj.gitBranch,
      model: obj.message?.model ?? null,
      text: cap(ccText(content), MAX_TEXT),
      toolUses: [],
      toolResults: {},
    };
    if (Array.isArray(content))
      for (const b of content) {
        if (b.type === 'tool_use')
          entry.toolUses.push({
            id: b.id,
            name: b.name,
            command: cap(b.input?.command ?? '', 2048),
            filePath: b.input?.file_path ?? null,
          });
        if (b.type === 'tool_result') {
          const text = Array.isArray(b.content)
            ? ccText(b.content)
            : typeof b.content === 'string'
              ? b.content
              : '';
          entry.toolResults[b.tool_use_id] = cap(text, MAX_TOOL_OUTPUT);
        }
      }
    lines.push(entry);
  }
  return lines;
};

const isRealUserTurn = (l) =>
  l.type === 'user' &&
  !l.isSidechain &&
  stripReminders(l.text).trim().length > 0 &&
  !Object.keys(l.toolResults).length;

export function harvestClaudeCode() {
  let files = [];
  try {
    files = execFileSync('grep', ['-rl', ANCHOR_PHRASE, CC_PROJECTS, '--include=*.jsonl'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return []; // no matches or no store on this machine
  }
  const candidates = [];
  for (const file of files) {
    const lines = parseTranscript(file);
    const sessionId = path.basename(file, '.jsonl');
    const allResults = {};
    for (const l of lines) Object.assign(allResults, l.toolResults);
    const gitEvents = lines.flatMap((l, idx) =>
      l.toolUses
        .filter((u) => u.name === 'Bash' && GIT_STAT_RE.test(u.command))
        .map((u) => ({ pos: idx, command: u.command, output: allResults[u.id] ?? '' })),
    );
    const commitEvents = lines.flatMap((l, idx) =>
      l.toolUses
        .filter((u) => u.name === 'Bash')
        .flatMap((u) => shasIn(allResults[u.id]).map((sha) => ({ pos: idx, sha }))),
    );
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!isRealUserTurn(l) || !stripReminders(l.text).includes(ANCHOR_PHRASE)) continue;
      const repo = detectRepo(l.cwd);
      if (EXCLUDED_REPOS.includes(repo)) continue; // employer code — never harvested
      let end = i + 1;
      while (end < lines.length && !isRealUserTurn(lines[end])) end++;
      const turn = lines.slice(i + 1, end);
      const { diffFull, statText } = pickDiff(gitEvents, i, end);
      const preCommits = commitEvents.filter((e) => e.pos < i).map((e) => e.sha);
      const postCommits = commitEvents.filter((e) => e.pos > i).map((e) => e.sha);
      const editedFiles = lines
        .slice(0, i)
        .flatMap((t) =>
          t.toolUses.filter((u) => (u.name === 'Write' || u.name === 'Edit') && u.filePath),
        )
        .map((u) => u.filePath);
      const turnActivity = { filesWritten: [], testRuns: [] };
      for (const t of turn)
        for (const u of t.toolUses) {
          if ((u.name === 'Write' || u.name === 'Edit') && u.filePath)
            turnActivity.filesWritten.push(u.filePath);
          if (u.name === 'Bash' && TEST_CMD_RE.test(u.command))
            turnActivity.testRuns.push({
              command: cap(u.command, 512),
              output: cap(allResults[u.id] ?? '', 4096),
            });
        }
      const aftermath = { userTurns: [], filesWritten: [], testRuns: [] };
      for (const t of lines.slice(end)) {
        if (isRealUserTurn(t) && aftermath.userTurns.length < 20)
          aftermath.userTurns.push(cap(stripReminders(t.text).trim(), 2048));
        for (const u of t.toolUses) {
          if ((u.name === 'Write' || u.name === 'Edit') && u.filePath)
            aftermath.filesWritten.push(u.filePath);
          if (u.name === 'Bash' && TEST_CMD_RE.test(u.command))
            aftermath.testRuns.push({
              command: cap(u.command, 512),
              output: cap(allResults[u.id] ?? '', 4096),
            });
        }
      }
      candidates.push(
        makeCandidate({
          source: 'claude-code',
          sourceRef: `${path.relative(CC_PROJECTS, file)}#uuid=${l.uuid}`,
          sessionId,
          repo,
          branch: l.gitBranch || null,
          date: l.timestamp,
          model: turn.find((t) => t.model)?.model ?? null,
          provider: 'claude-code',
          promptText: stripReminders(l.text).trim(),
          diffFull,
          statText,
          preCommits,
          postCommits,
          editedFiles,
          turnActivity,
          responseText: turn
            .filter((t) => t.type === 'assistant')
            .map((t) => t.text)
            .filter(Boolean)
            .join('\n\n'),
          aftermath,
        }),
      );
    }
  }
  return candidates;
}

// ── cursor (globalStorage state.vscdb) ───────────────────────────────────────────────────────────

const buildCursorWorkspaceMap = () => {
  const map = new Map();
  if (!existsSync(CURSOR_WORKSPACES)) return map;
  for (const dir of readdirSync(CURSOR_WORKSPACES)) {
    const wsDb = path.join(CURSOR_WORKSPACES, dir, 'state.vscdb');
    const wsJson = path.join(CURSOR_WORKSPACES, dir, 'workspace.json');
    if (!existsSync(wsDb) || !existsSync(wsJson)) continue;
    const folder = tryParse(readFileSync(wsJson, 'utf8'))?.folder;
    if (!folder) continue;
    try {
      const db = new Database(wsDb, { readonly: true });
      const row = db.query("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get();
      db.close();
      for (const c of JSON.parse(row?.value ?? '{}').allComposers ?? [])
        map.set(c.composerId, decodeURIComponent(folder.replace('file://', '')));
    } catch {
      // workspace DB locked or schema drift — skip; rows fall back to other:unknown
    }
  }
  return map;
};

const PATH_RE = /\/Users\/[\w.%/ -]+/g;
const repoPathVote = (json) => {
  const votes = {};
  for (const m of json.matchAll(PATH_RE)) {
    const repo = detectRepo(decodeURIComponent(m[0]));
    if (repo !== 'other:unknown') votes[repo] = (votes[repo] ?? 0) + 1;
  }
  const [winner] = Object.entries(votes).sort((a, b) => b[1] - a[1])[0] ?? [];
  return winner ?? null;
};

export function harvestCursor() {
  if (!existsSync(CURSOR_GLOBAL_DB)) return [];
  const db = new Database(CURSOR_GLOBAL_DB, { readonly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  const wsMap = buildCursorWorkspaceMap();
  const hits = db
    .query(
      `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%' || ? || '%'`,
    )
    .all(ANCHOR_PHRASE);
  const byKey = db.query('SELECT value FROM cursorDiskKV WHERE key = ?');
  const candidates = [];
  for (const { key, value } of hits) {
    const bubble = tryParse(value);
    if (bubble?.type !== 1) continue; // user bubbles only
    // Two invocation shapes: the phrase typed/pasted into the message text (pre-command era), or a
    // `/edge-cases` slash command whose file content Cursor attaches under cursorCommands. Context
    // rides (rules/attachments quoting the command file) match the LIKE but are neither.
    const command = (bubble.cursorCommands ?? []).find((c) =>
      (c.content ?? '').includes(ANCHOR_PHRASE),
    );
    if (!(bubble.text ?? '').includes(ANCHOR_PHRASE) && !command) continue;
    const invocationText = [command?.content, bubble.text].filter(Boolean).join('\n\n');
    const [, composerId, bubbleId] = key.split(':');
    let composer = {};
    try {
      composer = JSON.parse(byKey.get(`composerData:${composerId}`)?.value ?? '{}');
    } catch {
      /* keep defaults */
    }
    const headers = composer.fullConversationHeadersOnly ?? [];
    const pos = headers.findIndex((h) => h.bubbleId === bubbleId);
    const fetchText = (h) => {
      try {
        return (
          JSON.parse(byKey.get(`bubbleId:${composerId}:${h.bubbleId}`)?.value ?? '{}').text ?? ''
        );
      } catch {
        return '';
      }
    };
    const following = pos >= 0 ? headers.slice(pos + 1) : [];
    const untilNextUser = following.slice(
      0,
      following.findIndex((h) => h.type === 1) === -1
        ? undefined
        : following.findIndex((h) => h.type === 1),
    );
    const responseText = untilNextUser
      .filter((h) => h.type === 2)
      .map(fetchText)
      .filter(Boolean)
      .join('\n\n');
    const preceding = pos >= 0 ? headers.slice(Math.max(0, pos - 10), pos) : [];
    // workspaceStorage's composer.composerData only tracks recent composers — for the rest, infer
    // the repo from absolute paths embedded in the composer/bubble JSON (file selections, chunks),
    // majority-vote via detectRepo. Paths are often URI-encoded (%20).
    const wsFolder =
      wsMap.get(composerId) ??
      repoPathVote(`${value}\n${byKey.get(`composerData:${composerId}`)?.value ?? ''}`);
    const date =
      bubble.createdAt ?? (composer.createdAt ? new Date(composer.createdAt).toISOString() : null);
    if (!date) continue;
    const repo = detectRepo(wsFolder);
    if (EXCLUDED_REPOS.includes(repo)) continue;
    candidates.push(
      makeCandidate({
        source: 'cursor',
        sourceRef: `cursor:${key}`,
        sessionId: null,
        repo,
        branch: composer.activeBranch ?? composer.createdOnBranch ?? null,
        date,
        model: null,
        provider: 'cursor',
        promptText: invocationText,
        diffFull: '', // cursor bubbles carry no recoverable diffs (verified) — summary-only anchor
        responseText: cap(responseText, MAX_TEXT * 4),
        aftermath: {
          userTurns: [],
          filesWritten: [],
          testRuns: [],
          precedingContext: cap(preceding.map(fetchText).filter(Boolean).join('\n\n'), MAX_TEXT),
        },
      }),
    );
  }
  db.close();
  return candidates;
}
