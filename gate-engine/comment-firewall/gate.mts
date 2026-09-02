import { detectChangedComments } from './detect.mts';
import type { CommentFinding, DetectionResult } from './types.mts';

interface FirewallDeps {
  detect: (cwd: string) => DetectionResult;
}

const defaults: FirewallDeps = { detect: detectChangedComments };

function findingLocation(finding: CommentFinding): string {
  return `${finding.path}:${finding.startLine}${
    finding.endLine === finding.startLine ? '' : `-${finding.endLine}`
  }`;
}

function printFinding(finding: CommentFinding): void {
  const summary = finding.comment.replace(/\s+/g, ' ').slice(0, 140);
  console.error(`  • [${finding.id}] ${findingLocation(finding)} — ${summary}`);
}

/** The first line is the collector's classification key; keep it byte-stable. */
function printBlock(findings: CommentFinding[]): void {
  console.error(
    `guard-comments: ${findings.length} added/modified comment paragraph${findings.length === 1 ? '' : 's'} need a decision.`,
  );
  for (const finding of findings) printFinding(finding);
  console.error(
    '\nEach paragraph is over the 2-line budget. Shorten it to at most 2 lines, or move the information',
  );
  console.error('into code, types, a test name/assertion, or a decision record (guard-decisions).');
  console.error('There is no rationale or waiver.');
}

/** Exit contract: 0 clean, 1 over budget, 4 unreadable evidence or unsupported language. */
export function runCommentFirewall(
  cwd = process.cwd(),
  injected: Partial<FirewallDeps> = {},
): 0 | 1 | 4 {
  const deps = { ...defaults, ...injected };
  let detection: DetectionResult;
  try {
    detection = deps.detect(cwd);
  } catch (cause) {
    console.error(
      `guard-comments: comment evidence unreadable — ${cause instanceof Error ? cause.message : cause}`,
    );
    return 4;
  }
  if (detection.unsupported.length > 0) {
    console.error('guard-comments: configured staged source uses unsupported comment syntax:');
    for (const item of detection.unsupported) {
      console.error(`  • .${item.extension || '(none)'} — ${item.path}`);
    }
    console.error(
      'Add an explicit lexer adapter or exclude that extension from sourceExtensions; no regex fallback was used.',
    );
    return 4;
  }
  if (detection.findings.length === 0) return 0;
  printBlock(detection.findings);
  return 1;
}
