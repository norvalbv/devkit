import { createHash } from 'node:crypto';
import {
  buildCappedDiffEvidence,
  capNamedSegments,
  measureDiffEvidenceCap,
} from '../../diff-evidence.mts';
import { chunkDiffText } from '../../lens/chunk.mts';
import {
  CONTEXT_MODE,
  relatedFileOrder,
  type ContextSource,
  type SourceSegment,
} from './source.mts';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
const TOTAL_CHARACTERS = 60_000;
const SUPPORT_CHARACTERS = 24_000;
const SEGMENT_CHARACTERS = 8_000;

export interface EvidenceReceipt {
  mode: string;
  base: string;
  staged: string;
  semanticHash: string;
  payloadHash: string;
  ownedBytesShown: number;
  supportBytesShown: number;
  supportCharactersShown: number;
  supportOmitted: number;
  supportTruncated: number;
  inputBytes: number;
  sizingUnit: 'utf8-source-evidence-bytes';
  renderingUnit: 'utf16-characters';
}
export interface EvidencePacket {
  ownedDiff: string;
  input: string;
  instructions: string;
  receipt: EvidenceReceipt;
  /** Private coordinate receipts; source bytes must agree with the actual stdin slice. */
  support: readonly (SourceSegment & { shownCharacters: number; inputOffset: number })[];
}
export interface PreparedContext {
  source: ContextSource;
  bytesByPath: Map<string, number>;
  order: string[];
}

/** One packet per owned file set, retained on the selection through every cascade/recovery path. */
export function buildEvidencePacket(
  source: ContextSource,
  owned: string[],
  ownedDiff: string,
): EvidencePacket {
  const recover = (label: string): string =>
    `inspect the captured diff with git diff ${source.base} ${source.staged} -- ${quote(label)}`;
  const instructions =
    `Evidence mode: ${CONTEXT_MODE}. Own only the listed changed files/hunks. Supporting source and the whole-selection inventory aid investigation; they do not expand ownership.\n` +
    'A cross-file failure is eligible when an owned change introduces or activates it. Investigate counterparties needed to establish or reject that failure.\n' +
    `The authoritative snapshot is base ${source.base}, staged tree ${source.staged}. Recover changes with git diff ${source.base} ${source.staged} -- <quoted-path>; recover source with git show '<tree>:<path>' using those exact trees.\n` +
    'Do not substitute live git diff --cached or worktree Read for captured program source: either can include a later repair. This snapshot rule overrides source-recovery advice in the brief. Read remains appropriate for the reviewer skill/checklist instructions.\n' +
    'Automatic context contains Git enclosing-function hunks and direct relative ES-module imports, including reverse links only among selected changed files. It is not a complete caller/reader graph. Missing, unsupported, omitted or truncated supporting context is neither a defect nor evidence of safety.\n';
  const inventory =
    `OWNED CHANGED FILES:\n${owned.map((f) => JSON.stringify(f)).join('\n')}\n` +
    `WHOLE-SELECTION FILE INVENTORY (orientation only):\n${source.files.map((f) => JSON.stringify(f)).join('\n')}\n`;
  const seen = new Set<string>();
  const segments = owned
    .flatMap((file) => source.segments.get(file) ?? [])
    .filter((s) => {
      if (s.side === 'function-diff' && s.content === chunkDiffText(ownedDiff, [s.path]))
        return false;
      const id = `${s.side}:${s.path}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((s) => ({
      source: s,
      label: `${s.side} ${JSON.stringify(s.path)}`,
      // Blob excerpts always start at line 1; expanded diffs retain both sides' hunk coordinates.
      content: `\nSOURCE ${s.side} ${JSON.stringify(s.path)} (${s.side === 'function-diff' ? 'unified hunk coordinates' : 'from line 1'}; sha256 ${hash(s.content)}):\n${s.content}\n`,
    }));
  // Owned source gets precisely the control cap first. Support never displaces it, even when a
  // large raw diff's per-file cap leaves apparent spare room after rendering.
  const supportCap = Math.min(SUPPORT_CHARACTERS, Math.max(0, TOTAL_CHARACTERS - ownedDiff.length));
  const capped = capNamedSegments(segments, {
    totalCap: supportCap,
    segmentCap: SEGMENT_CHARACTERS,
    omittedListMax: 40,
    hint: () => 'recover from the captured trees if needed for an owned-change hypothesis',
    omittedFooterHint: '',
  });
  const notes = [
    ...new Set(
      owned.flatMap((f) => (source.notes.get(f) ?? []).map((n) => `${JSON.stringify(f)}: ${n}`)),
    ),
  ];
  const supporting =
    `\nSUPPORTING CONTEXT (bounded; not additional owned changes):\n${capped.kept.join('')}\n${capped.omitted.join('\n')}\n` +
    `DISCOVERY LIMITS:\n${notes.length ? notes.join('\n') : 'No preparation failures recorded; discovery is still limited to the relationships described in the prompt.'}\n`;
  const body = buildCappedDiffEvidence(ownedDiff, inventory, recover);
  const provenance = `CAPTURED TREES: base=${source.base} staged=${source.staged}\n`;
  const input = `${provenance}${body}${supporting}`;
  // Exclude tree IDs: an unrelated staged edit must not invalidate this task. Source identities,
  // raw owned bytes, support contents and discovery limits all deliberately participate.
  const semanticHash = hash(JSON.stringify([CONTEXT_MODE, inventory, ownedDiff, supporting]));
  let remaining = supportCap;
  let characters = 0;
  let offset =
    provenance.length +
    body.length +
    '\nSUPPORTING CONTEXT (bounded; not additional owned changes):\n'.length;
  let keptIndex = 0;
  const support: EvidencePacket['support'][number][] = [];
  for (const s of segments) {
    const used = Math.min(s.content.length, SEGMENT_CHARACTERS, remaining);
    characters += used;
    remaining -= used;
    const headerLength = s.content.length - s.source.content.length - 1;
    support.push(
      Object.freeze({
        ...s.source,
        shownCharacters: Math.max(0, Math.min(s.source.content.length, used - headerLength)),
        inputOffset: offset + headerLength,
      }),
    );
    if (used > 0) offset += capped.kept[keptIndex++].length;
  }
  return Object.freeze({
    ownedDiff,
    input,
    instructions,
    support: Object.freeze(support),
    receipt: Object.freeze({
      mode: CONTEXT_MODE,
      base: source.base,
      staged: source.staged,
      semanticHash,
      payloadHash: hash(input + instructions),
      ownedBytesShown: measureDiffEvidenceCap(ownedDiff).evidence_bytes_shown,
      supportBytesShown: capped.shownBytes,
      supportCharactersShown: characters,
      supportOmitted: capped.omitted.length,
      supportTruncated: capped.truncated,
      inputBytes: Buffer.byteLength(input, 'utf8'),
      sizingUnit: 'utf8-source-evidence-bytes',
      renderingUnit: 'utf16-characters',
    }),
  });
}

/** Pack using per-file bounded source bytes; shared support may deduplicate in the final packet. */
export function prepareContext(source: ContextSource, diff: string): PreparedContext {
  const bytesByPath = new Map(
    source.files.map((file) => {
      const packet = buildEvidencePacket(source, [file], chunkDiffText(diff, [file]));
      return [file, packet.receipt.ownedBytesShown + packet.receipt.supportBytesShown] as const;
    }),
  );
  return { source, bytesByPath, order: relatedFileOrder(source) };
}
