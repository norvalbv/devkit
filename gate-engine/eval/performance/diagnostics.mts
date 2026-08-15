import { isAbsolute, relative, resolve } from 'node:path';
import { canonicalJson } from '../history.mts';
import type { AnalyzerKind, AnalyzerResult, NormalizedDiagnostic } from './model.mts';
import { digest } from './model.mts';

type Json = Record<string, unknown>;
const PATH_SEPARATOR = /[\\/]/;

function record(value: unknown): value is Json {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).join('');
  if (record(value)) return text(value.content ?? value.text ?? value.message ?? '');
  return value == null ? '' : String(value);
}

function normalizeMessage(value: unknown, fixtureRoot: string): string {
  return text(value).replaceAll(fixtureRoot, '<fixture>').replace(/\s+/g, ' ').trim();
}

function normalizePath(value: unknown, fixtureRoot: string, processCwd: string): string {
  if (typeof value !== 'string' || !value) return '<unknown>';
  const absolute = isAbsolute(value) ? resolve(value) : resolve(processCwd, value);
  const rel = relative(fixtureRoot, absolute).replaceAll('\\', '/');
  return rel === '..' || rel.startsWith('../')
    ? `<external>/${value.split(PATH_SEPARATOR).at(-1)}`
    : rel;
}

function sorted(diagnostics: NormalizedDiagnostic[]): NormalizedDiagnostic[] {
  return diagnostics.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}

function jsonLine(stdout: string): unknown {
  const candidates = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') || line.startsWith('['));
  if (candidates.length === 0) throw new Error('Analyzer expected JSON on stdout');
  return JSON.parse(candidates.at(-1) as string) as unknown;
}

function biome(stdout: string, fixtureRoot: string, processCwd: string): AnalyzerResult {
  const parsed = jsonLine(stdout);
  if (!record(parsed) || !Array.isArray(parsed.diagnostics))
    throw new Error('Biome JSON output is missing diagnostics[]');
  const diagnostics = parsed.diagnostics.map((value): NormalizedDiagnostic => {
    const item = record(value) ? value : {};
    const location = record(item.location) ? item.location : {};
    const position = record(location.start) ? location.start : location;
    const pathValue = record(location.path) ? location.path.file : location.path;
    return {
      semanticRuleId: text(item.category || 'biome'),
      relativePath: normalizePath(pathValue, fixtureRoot, processCwd),
      line: Number(position.line ?? 0),
      column: Number(position.column ?? 0),
      severity: text(item.severity || 'unknown'),
      normalizedMessage: normalizeMessage(item.description ?? item.message, fixtureRoot),
    };
  });
  return { diagnostics: sorted(diagnostics) };
}

function eslint(stdout: string, fixtureRoot: string, processCwd: string): AnalyzerResult {
  const parsed = jsonLine(stdout);
  if (!Array.isArray(parsed)) throw new Error('ESLint JSON output must be an array');
  const diagnostics: NormalizedDiagnostic[] = [];
  const files: string[] = [];
  for (const rawFile of parsed) {
    if (!record(rawFile)) continue;
    const relativePath = normalizePath(rawFile.filePath, fixtureRoot, processCwd);
    files.push(relativePath);
    if (!Array.isArray(rawFile.messages)) continue;
    for (const rawMessage of rawFile.messages) {
      const message = record(rawMessage) ? rawMessage : {};
      diagnostics.push({
        semanticRuleId: text(message.ruleId ?? (message.fatal ? 'eslint/fatal' : 'eslint')),
        relativePath,
        line: Number(message.line ?? 0),
        column: Number(message.column ?? 0),
        severity:
          Number(message.severity) === 2
            ? 'error'
            : Number(message.severity) === 1
              ? 'warning'
              : 'info',
        normalizedMessage: normalizeMessage(message.message, fixtureRoot),
      });
    }
  }
  return { diagnostics: sorted(diagnostics), reportedProcessedFiles: files.sort() };
}

const TSC_DIAGNOSTIC = /^(.*?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;

function tsc(
  stdout: string,
  stderr: string,
  fixtureRoot: string,
  processCwd: string,
): AnalyzerResult {
  const diagnostics: NormalizedDiagnostic[] = [];
  for (const line of `${stdout}\n${stderr}`.split('\n')) {
    const match = TSC_DIAGNOSTIC.exec(line.trim());
    if (!match) continue;
    diagnostics.push({
      semanticRuleId: match[5] as string,
      relativePath: normalizePath(match[1], fixtureRoot, processCwd),
      line: Number(match[2]),
      column: Number(match[3]),
      severity: match[4] as string,
      normalizedMessage: normalizeMessage(match[6], fixtureRoot),
    });
  }
  return { diagnostics: sorted(diagnostics) };
}

export function analyzeDiagnostics(
  kind: AnalyzerKind,
  stdout: string,
  stderr: string,
  fixtureRoot: string,
  processCwd = fixtureRoot,
): AnalyzerResult {
  if (kind === 'none') return { diagnostics: [] };
  if (kind === 'biome-json') return biome(stdout, fixtureRoot, processCwd);
  if (kind === 'eslint-json') return eslint(stdout, fixtureRoot, processCwd);
  return tsc(stdout, stderr, fixtureRoot, processCwd);
}

export function diagnosticDigest(diagnostics: NormalizedDiagnostic[]): string {
  return digest(canonicalJson(diagnostics));
}
