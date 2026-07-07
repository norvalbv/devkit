#!/usr/bin/env node

/**
 * completeness-eval case MINER — a finder, not a generator.
 *
 * Scans local Claude Code session logs (~/.claude/projects) for real feature-completeness-reviewer
 * runs and emits one candidate per invocation to candidates.jsonl (GITIGNORED — raw session data
 * never lands in the repo). A human then authors corpus rows OFF these candidates:
 *
 *   · devkit-origin candidates may become rows verbatim (`provenance: "mined"`);
 *   · private-repo candidates (frink, owners-web, …) must be REBUILT as neutralized fixtures —
 *     same file topology and gap structure, renamed identifiers, rewritten prose, zero verbatim
 *     code (`provenance: "adapted"`) — devkit is a public repo.
 *
 * Keeping the authoring step human is deliberate: the corpus's counterweight to preference
 * leakage (an in-family judge is gentler on in-family text) is that its scenarios come from real
 * review history, not from the model imagining test cases.
 *
 *   node mine-cases.mts               # scan all projects → candidates.jsonl (+ summary table)
 *   node mine-cases.mts --project devkit   # substring filter on the project dir name
 *
 * Sidecar-first: every subagent run leaves <session>/subagents/agent-*.meta.json recording its
 * agentType — that is authoritative and tiny, so the scan never reads a multi-MB transcript to
 * discover what it was. Transcripts are then sampled head+tail only (prompt + final findings).
 */

import { closeSync, openSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENT_TYPE = 'feature-completeness-reviewer';
const PROMPT_CAP = 6000;
const OUTPUT_CAP = 6000;
const CHUNK = 512 * 1024; // head/tail sample size per transcript — never the whole file

interface Candidate {
  project: string;
  session: string;
  agentFile: string;
  ts: string | null;
  prompt: string;
  output: string;
}

function readSlice(file: string, from: number, length: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, from);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** First user-message text (the Task prompt) from a transcript head sample. */
export function extractPrompt(headText: string): string {
  for (const line of headText.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const msg = obj?.message;
      if (obj?.type === 'user' || msg?.role === 'user') {
        const content = msg?.content ?? obj?.content;
        if (typeof content === 'string') return content.slice(0, PROMPT_CAP);
        if (Array.isArray(content)) {
          const text = content
            .filter((c: { type?: string }) => c?.type === 'text')
            .map((c: { text?: string }) => c.text ?? '')
            .join('\n');
          if (text.trim()) return text.slice(0, PROMPT_CAP);
        }
      }
    } catch {
      // partial line at the chunk boundary — skip
    }
  }
  return '';
}

/** Last assistant text (the findings/verdict) from a transcript tail sample. */
export function extractOutput(tailText: string): { text: string; ts: string | null } {
  let out = '';
  let ts: string | null = null;
  for (const line of tailText.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const msg = obj?.message;
      if (obj?.type === 'assistant' || msg?.role === 'assistant') {
        const content = msg?.content ?? obj?.content;
        const text = Array.isArray(content)
          ? content
              .filter((c: { type?: string }) => c?.type === 'text')
              .map((c: { text?: string }) => c.text ?? '')
              .join('\n')
          : typeof content === 'string'
            ? content
            : '';
        if (text.trim()) {
          out = text; // keep overwriting — the LAST assistant text wins
          ts = obj?.timestamp ?? ts;
        }
      }
    } catch {
      // partial line at the chunk boundary — skip
    }
  }
  return { text: out.slice(0, OUTPUT_CAP), ts };
}

function mineProject(projectDir: string, project: string): Candidate[] {
  const out: Candidate[] = [];
  let sessions: string[];
  try {
    sessions = readdirSync(projectDir).filter((d) => {
      try {
        return statSync(path.join(projectDir, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return out;
  }
  for (const session of sessions) {
    const subDir = path.join(projectDir, session, 'subagents');
    let metas: string[];
    try {
      metas = readdirSync(subDir).filter((f) => f.endsWith('.meta.json'));
    } catch {
      continue; // no subagents dir — nothing to mine here
    }
    for (const metaFile of metas) {
      try {
        const meta = JSON.parse(readSlice(path.join(subDir, metaFile), 0, 64 * 1024));
        if (meta?.agentType !== AGENT_TYPE) continue;
        const transcript = path.join(subDir, metaFile.replace('.meta.json', '.jsonl'));
        const size = statSync(transcript).size;
        const head = readSlice(transcript, 0, Math.min(CHUNK, size));
        const tail = size > CHUNK ? readSlice(transcript, size - CHUNK, CHUNK) : head;
        const prompt = extractPrompt(head);
        const { text: output, ts } = extractOutput(tail);
        if (!prompt && !output) continue;
        out.push({ project, session, agentFile: transcript, ts, prompt, output });
      } catch {
        // unreadable sidecar/transcript — skip, mining is best-effort
      }
    }
  }
  return out;
}

function main(argv: string[]) {
  const pIdx = argv.indexOf('--project');
  const filter = pIdx !== -1 ? argv[pIdx + 1] : null;
  const projectsRoot = path.join(homedir(), '.claude', 'projects');
  let projects: string[];
  try {
    projects = readdirSync(projectsRoot);
  } catch {
    console.error(`mine-cases: no ${projectsRoot}`);
    process.exit(2);
  }
  if (filter) projects = projects.filter((p) => p.includes(filter));
  const candidates: Candidate[] = [];
  for (const p of projects) candidates.push(...mineProject(path.join(projectsRoot, p), p));
  candidates.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const outPath = path.join(here, 'candidates.jsonl');
  writeFileSync(
    outPath,
    candidates.map((c) => JSON.stringify(c)).join('\n') + (candidates.length ? '\n' : ''),
  );

  const byProject: Record<string, number> = {};
  for (const c of candidates) byProject[c.project] = (byProject[c.project] ?? 0) + 1;
  console.log(
    `mine-cases: ${candidates.length} candidate(s) → ${path.relative(process.cwd(), outPath)} (gitignored)`,
  );
  for (const [p, n] of Object.entries(byProject).sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(4)}  ${p}`);
  console.log(
    '\nAuthoring rule: devkit-origin rows may be verbatim (provenance "mined"); private-repo rows must be\n' +
      'rebuilt neutralized (provenance "adapted") — same gap structure, renamed identifiers, no verbatim code.',
  );
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main(process.argv.slice(2));
