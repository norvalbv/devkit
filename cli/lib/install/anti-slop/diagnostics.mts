/** Normalize Oxlint JSON diagnostics into checkout-independent anti-slop findings. */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const RULE_CODE = /^anti-slop\(([^)]+)\)$/u;

interface RawSpan {
  line?: number;
  column?: number;
}

interface RawDiagnostic {
  message?: unknown;
  code?: unknown;
  severity?: unknown;
  filename?: unknown;
  labels?: Array<{ span?: RawSpan }>;
}

interface RawPayload {
  diagnostics?: RawDiagnostic[];
}

export interface AntiSlopFinding {
  fingerprint: string;
  ruleId: string;
  file: string;
  diagnostic: string;
  context: string;
  severity: 'error' | 'warning';
  line: number;
  column: number;
}

export interface FindingGroup extends AntiSlopFinding {
  count: number;
}

const normalizeText = (value: string): string => value.trim().replace(/\s+/gu, ' ');

function ruleId(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const match = RULE_CODE.exec(code);
  return match?.[1] ? `anti-slop/${match[1]}` : null;
}

function repositoryFile(cwd: string, filename: unknown): { absolute: string; relative: string } {
  if (typeof filename !== 'string' || !filename) throw new Error('diagnostic has no filename');
  const absolute = resolve(cwd, filename);
  const rel = relative(cwd, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`diagnostic path escapes repository: ${filename}`);
  }
  return { absolute, relative: rel.split(sep).join('/') };
}

function sourceContext(path: string, line: number): string {
  const lines = readFileSync(path, 'utf8').replace(/\r\n?/gu, '\n').split('\n');
  return normalizeText(lines[Math.max(0, line - 1)] ?? '');
}

function fingerprintFor(parts: {
  ruleId: string;
  file: string;
  diagnostic: string;
  context: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([parts.ruleId, parts.file, parts.diagnostic, parts.context]))
    .digest('hex');
}

/** Parse only namespaced anti-slop diagnostics; other Oxlint rules remain outside this gate. */
export function parseAntiSlopFindings(cwd: string, json: string): AntiSlopFinding[] {
  let payload: RawPayload;
  try {
    payload = JSON.parse(json) as RawPayload;
  } catch (error: unknown) {
    throw new Error(
      `Oxlint did not return JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(payload.diagnostics)) throw new Error('Oxlint JSON has no diagnostics array');
  const findings: AntiSlopFinding[] = [];
  for (const diagnostic of payload.diagnostics) {
    const id = ruleId(diagnostic.code);
    if (!id) continue;
    const location = repositoryFile(cwd, diagnostic.filename);
    const span = diagnostic.labels?.[0]?.span;
    const line = typeof span?.line === 'number' && span.line > 0 ? span.line : 1;
    const column = typeof span?.column === 'number' && span.column > 0 ? span.column : 1;
    const message =
      typeof diagnostic.message === 'string' ? normalizeText(diagnostic.message) : 'diagnostic';
    const context = sourceContext(location.absolute, line);
    const stable = { ruleId: id, file: location.relative, diagnostic: message, context };
    findings.push({
      ...stable,
      fingerprint: fingerprintFor(stable),
      severity: diagnostic.severity === 'warning' ? 'warning' : 'error',
      line,
      column,
    });
  }
  return findings.sort(
    (a, b) => a.fingerprint.localeCompare(b.fingerprint) || a.line - b.line || a.column - b.column,
  );
}

/** Group indistinguishable repeated diagnostics so an added copy still exceeds baseline debt. */
export function groupFindings(findings: readonly AntiSlopFinding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const finding of findings) {
    const current = groups.get(finding.fingerprint);
    if (!current) {
      groups.set(finding.fingerprint, { ...finding, count: 1 });
      continue;
    }
    current.count += 1;
    if (finding.severity === 'error') current.severity = 'error';
  }
  return [...groups.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}
