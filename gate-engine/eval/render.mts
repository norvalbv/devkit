import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { activeEvents, latestRecordedEvent } from './history.mts';
import type { RepositorySource } from './source.mts';
import { suiteHashes } from './source.mts';
import type {
  BenchmarkCatalog,
  BenchmarkEvent,
  BenchmarkSuite,
  EvidenceMode,
  Freshness,
  MetricObservation,
} from './types.mts';

const ROOT_START = '<!-- benchmark-dashboard:start -->';
const ROOT_END = '<!-- benchmark-dashboard:end -->';
const DETAIL_START = '<!-- benchmark-details:start -->';
const DETAIL_END = '<!-- benchmark-details:end -->';

interface SuiteView {
  suite: BenchmarkSuite;
  event?: BenchmarkEvent;
  evidence: EvidenceMode;
  freshness: Freshness;
}

export function latestEvents(events: BenchmarkEvent[]): Map<string, BenchmarkEvent> {
  const latest = new Map<string, BenchmarkEvent>();
  for (const event of activeEvents(events)) {
    const prior = latest.get(event.suiteId);
    const acceptedOutranksPrior = event.evidence === 'accepted' && prior?.evidence !== 'accepted';
    const sameTierIsNewer =
      prior &&
      (prior.evidence === 'accepted') === (event.evidence === 'accepted') &&
      latestRecordedEvent([prior, event])?.id === event.id;
    if (!prior || acceptedOutranksPrior || sameTierIsNewer) latest.set(event.suiteId, event);
  }
  return latest;
}

function sameHashes(a: BenchmarkEvent['hashes'], b: ReturnType<typeof suiteHashes>): boolean {
  return Boolean(
    a &&
      a.implementation === b.implementation &&
      a.corpus === b.corpus &&
      a.scorer === b.scorer &&
      a.runner === b.runner,
  );
}

function suiteViews(
  catalog: BenchmarkCatalog,
  events: BenchmarkEvent[],
  source: RepositorySource,
): SuiteView[] {
  const latest = latestEvents(events);
  return catalog.suites.map((suite) => {
    const event = latest.get(suite.id);
    const evidence =
      event?.evidence ??
      catalog.subjects.find(
        (subject) => subject.suiteIds.includes(suite.id) && subject.evidence !== 'none',
      )?.evidence ??
      'none';
    let freshness: Freshness = 'unknown';
    if (event?.hashes)
      freshness = sameHashes(event.hashes, suiteHashes(source, suite.hashes)) ? 'current' : 'stale';
    return { suite, event, evidence, freshness };
  });
}

function formatMetric(metric: MetricObservation): string {
  if (metric.unit === 'count')
    return Number.isInteger(metric.value) ? String(metric.value) : metric.value.toFixed(1);
  if (metric.numerator !== undefined && metric.denominator !== undefined) {
    return `${metric.numerator}/${metric.denominator} (${(metric.value * 100).toFixed(1)}%)`;
  }
  if (metric.unit === 'ratio') return `${(metric.value * 100).toFixed(1)}%`;
  return Number.isInteger(metric.value) ? String(metric.value) : metric.value.toFixed(3);
}

function headline(event?: BenchmarkEvent): string {
  if (!event || event.metrics.length === 0) return 'No accepted local checkpoint';
  return event.metrics
    .slice(0, 2)
    .map((metric) => `${metric.label}: ${formatMetric(metric)}`)
    .join(' · ');
}

function svgHeadline(event?: BenchmarkEvent): string {
  const value = headline(event);
  const limit = 46;
  return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;
}

const ASSESSMENT_MARK: Record<string, string> = {
  improved: '↑ improved',
  regressed: '↓ regressed',
  flat: '→ flat',
  mixed: '↕ mixed',
  unknown: '? unknown',
};

function markdownCell(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;')
    .replaceAll(/\r?\n/g, ' ');
}

function suiteTable(views: SuiteView[]): string {
  const rows = views.map(({ suite, event, evidence, freshness }) => {
    const change = event?.changeType ?? '—';
    const assessment = event ? ASSESSMENT_MARK[event.assessment] : '? unknown';
    return `| ${markdownCell(suite.label)} | ${suite.lifecycle} | ${evidence} | ${freshness} | ${change} | ${assessment} | ${markdownCell(headline(event))} |`;
  });
  return [
    '| Suite | Lifecycle | Evidence | Freshness | Change | Assessment | Latest evidence |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function agentTable(catalog: BenchmarkCatalog): string {
  const rows = catalog.subjects
    .filter((subject) => subject.kind === 'agent')
    .map(
      (subject) =>
        `| ${markdownCell(subject.label)} | ${subject.lifecycle} | ${subject.evidence} | ${subject.suiteIds.length ? subject.suiteIds.map(markdownCell).join(', ') : '—'} |`,
    );
  return [
    '| Shipped agent | Lifecycle | Evidence mode | Suite(s) |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function allSubjectsTable(catalog: BenchmarkCatalog): string {
  return [
    '| Subject | Kind | Lifecycle | Evidence | Suite(s) |',
    '| --- | --- | --- | --- | --- |',
    ...catalog.subjects.map(
      (subject) =>
        `| ${markdownCell(subject.label)} | ${subject.kind} | ${subject.lifecycle} | ${subject.evidence} | ${subject.suiteIds.length ? subject.suiteIds.map(markdownCell).join(', ') : '—'} |`,
    ),
  ].join('\n');
}

function auditTable(events: BenchmarkEvent[]): string {
  const audit = activeEvents(events).filter((event) => event.provenance.tier !== 'accepted');
  if (audit.length === 0) return '_No lower-provenance audit observations._';
  return [
    '| Date | Suite | Provenance | Change | Assessment | Finding |',
    '| --- | --- | --- | --- | --- | --- |',
    ...audit.map(
      (event) =>
        `| ${event.recordedAt.slice(0, 10)} | ${markdownCell(event.suiteId)} | ${event.provenance.tier} | ${event.changeType} | ${event.assessment} | ${markdownCell(event.note)} |`,
    ),
  ].join('\n');
}

function rootBlock(catalog: BenchmarkCatalog, views: SuiteView[]): string {
  const accepted = views.filter((view) => view.event?.evidence === 'accepted').length;
  const current = views.filter((view) => view.freshness === 'current').length;
  const unbenchmarked = catalog.subjects.filter(
    (subject) => subject.kind === 'agent' && subject.evidence === 'none',
  ).length;
  return `${ROOT_START}
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/benchmarks/assets/dashboard-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/benchmarks/assets/dashboard-light.svg">
  <img alt="Benchmark evidence dashboard. Equivalent detailed tables follow: ${accepted} suites have accepted checkpoints, ${current} are current, and ${unbenchmarked} shipped agents have no benchmark evidence." src="docs/benchmarks/assets/dashboard-light.svg">
</picture>

The tracker separates lifecycle, evidence provenance, freshness, change type, and assessment. A stale score remains visible but is never presented as current. Current history is too sparse and heterogeneous to support exponential-growth or diminishing-return claims; the honest classification is **insufficient comparable evidence**.

${suiteTable(views)}

### Shipped-agent coverage

${agentTable(catalog)}

[Methodology, immutable checkpoints, full subject inventory, and provenance audit](docs/benchmarks/README.md)
${ROOT_END}`;
}

function detailBlock(
  catalog: BenchmarkCatalog,
  events: BenchmarkEvent[],
  views: SuiteView[],
): string {
  return `${DETAIL_START}
## Current suite dashboard

${suiteTable(views)}

## Complete subject inventory

${allSubjectsTable(catalog)}

## Provenance-tiered historical audit

Observations below are useful context but are excluded from ordinary accepted trend lines. Reported prose and aggregate-only local evidence cannot become accepted retroactively without a sanitized checkpoint.

${auditTable(events)}

## Growth interpretation

No curve shape is classified in v1. Comparable adjacent checkpoints may show marginal per-metric deltas, but there is no defensible effort axis and too little homogeneous history to claim exponential growth or diminishing returns. Status: **insufficient comparable evidence**.
${DETAIL_END}`;
}

export function replaceMarker(content: string, start: string, end: string, block: string): string {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex)
    throw new Error(`Missing generated markers ${start} … ${end}`);
  return `${content.slice(0, startIndex)}${block}${content.slice(endIndex + end.length)}`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function status(view: SuiteView): {
  mark: string;
  label: string;
  tone: 'good' | 'warn' | 'bad' | 'info';
} {
  if (!view.event && view.evidence === 'external-required')
    return { mark: '·', label: 'external', tone: 'info' };
  if (!view.event && view.evidence === 'evidence-only')
    return { mark: '·', label: 'evidence-only', tone: 'info' };
  if (!view.event) return { mark: '?', label: 'missing', tone: 'bad' };
  if (view.freshness === 'stale' && view.event.lifecycle === 'no-ship')
    return { mark: '!×', label: 'stale no-ship', tone: 'warn' };
  if (view.freshness === 'stale') return { mark: '!', label: 'stale', tone: 'warn' };
  if (view.event.lifecycle === 'no-ship') return { mark: '×', label: 'no ship', tone: 'info' };
  if (view.event.evidence === 'accepted') return { mark: '✓', label: 'accepted', tone: 'good' };
  return { mark: '·', label: view.event.evidence, tone: 'info' };
}

function svg(theme: 'light' | 'dark', views: SuiteView[], catalog: BenchmarkCatalog): string {
  const dark = theme === 'dark';
  const colors = dark
    ? {
        bg: '#0D1117',
        panel: '#161B22',
        text: '#F0F6FC',
        muted: '#B7C3D0',
        border: '#52606D',
        good: '#66D98B',
        warn: '#FFD166',
        bad: '#FF8B8B',
        info: '#79C0FF',
      }
    : {
        bg: '#FFFFFF',
        panel: '#F6F8FA',
        text: '#172033',
        muted: '#42526E',
        border: '#8C99A6',
        good: '#146B3A',
        warn: '#7A4D00',
        bad: '#A61B1B',
        info: '#0B5CAD',
      };
  const height = 168 + views.length * 38;
  const accepted = views.filter((view) => view.event?.evidence === 'accepted').length;
  const gaps = catalog.subjects.filter(
    (subject) => subject.kind === 'agent' && subject.evidence === 'none',
  ).length;
  const rows = views.map((view, index) => {
    const y = 150 + index * 38;
    const currentStatus = status(view);
    return `<g transform="translate(32 ${y})"><text class="suite" y="0">${escapeXml(view.suite.label)}</text><text class="status ${currentStatus.tone}" x="300" y="0">${currentStatus.mark} ${escapeXml(currentStatus.label)}</text><text class="metric" x="470" y="0">${escapeXml(svgHeadline(view.event))}</text></g>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}" role="img" aria-labelledby="title desc">
<title id="title">devkit benchmark evidence dashboard</title>
<desc id="desc">${accepted} suites have accepted evidence. ${gaps} shipped agents have no benchmark evidence. Rows use symbols and words as well as color. Full equivalent tables are in the README.</desc>
<style>
  .title{font:700 26px ui-sans-serif,system-ui;fill:${colors.text}} .summary{font:600 15px ui-sans-serif,system-ui;fill:${colors.muted}}
  .suite{font:600 15px ui-sans-serif,system-ui;fill:${colors.text}} .metric{font:14px ui-sans-serif,system-ui;fill:${colors.muted}}
  .status{font:700 14px ui-sans-serif,system-ui}.good{fill:${colors.good}}.warn{fill:${colors.warn}}.bad{fill:${colors.bad}}.info{fill:${colors.info}}
</style>
<rect width="1200" height="${height}" rx="18" fill="${colors.bg}"/><rect x="16" y="16" width="1168" height="${height - 32}" rx="12" fill="${colors.panel}" stroke="${colors.border}"/>
<text class="title" x="32" y="52">Benchmark evidence, not benchmark vibes</text>
<text class="summary" x="32" y="82">${accepted} accepted suites · ${gaps} shipped-agent evidence gaps · growth curve: insufficient evidence</text>
<text class="summary" x="32" y="112">✓ accepted   ! stale   × no-ship   ? missing — status never relies on color alone</text>
${rows.join('\n')}
</svg>\n`;
}

export function generatedOutputs(
  source: RepositorySource,
  catalog: BenchmarkCatalog,
  events: BenchmarkEvent[],
): Record<string, string> {
  const views = suiteViews(catalog, events, source);
  const root = source.read('README.md');
  const detail = source.read('docs/benchmarks/README.md');
  if (root === null || detail === null) throw new Error('README marker files are missing');
  return {
    'README.md': replaceMarker(root, ROOT_START, ROOT_END, rootBlock(catalog, views)),
    'docs/benchmarks/README.md': replaceMarker(
      detail,
      DETAIL_START,
      DETAIL_END,
      detailBlock(catalog, events, views),
    ),
    'docs/benchmarks/assets/dashboard-light.svg': svg('light', views, catalog),
    'docs/benchmarks/assets/dashboard-dark.svg': svg('dark', views, catalog),
  };
}

export function writeGeneratedOutputs(cwd: string, outputs: Record<string, string>): void {
  for (const [path, content] of Object.entries(outputs)) {
    const absolute = join(cwd, path);
    mkdirSync(dirname(absolute), { recursive: true });
    const temporary = `${absolute}.tmp-${process.pid}`;
    writeFileSync(temporary, content, { flag: 'wx' });
    renameSync(temporary, absolute);
  }
}
