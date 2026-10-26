/** The QA-capture section of the evidence block: what `devkit machine run` recorded, the apt part of
 * it uploaded to GitHub through `gh --attach`, and why anything else was left out. */
import { type EvidenceEntry, shotFile } from '../../machine/manifest.mts';
import { details, sectionBegin, sectionEnd, sectionOf, withSection } from './block.mts';

export const QA_BEGIN = sectionBegin('qa');
export const QA_END = sectionEnd('qa');
const ATTACHMENT = /https:\/\/github\.com\/user-attachments\/assets\/[A-Za-z0-9-]+/;
const SHA_CELL = /· sha `([0-9a-f]{12})` ·/;

const MB = 1024 * 1024;
/** GitHub's free-plan video limit is 10 MB and its image limit 10 MB; the margin covers rounding. */
export const VIDEO_CAP = 9 * MB;
const IMAGE_CAP = 10 * MB;
const MAX_FILES = 6;
const MAX_SHOTS = 4;

export interface MediaPlan {
  picks: EvidenceEntry[];
  notes: string[];
}

/** Why a passing capture may not go to this PR, or null when it may. */
export type Ineligible = (entry: EvidenceEntry) => string | null;

export const shortSha = (entry: EvidenceEntry): string => entry.sha256.slice(0, 12);

const megabytes = (bytes: number): string => (bytes / MB).toFixed(1);

/** The flows behind `entries` (in order) that `why` rules out, each with its first reason. */
function ruledOut(entries: EvidenceEntry[], why: Ineligible): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of entries) {
    const reason = entry.passed ? why(entry) : 'the flow failed';
    if (reason && !out.has(entry.flow)) out.set(entry.flow, reason);
  }
  return out;
}

function sizeNote(entry: EvidenceEntry): string | null {
  const cap = entry.kind === 'video' ? VIDEO_CAP : IMAGE_CAP;
  return entry.bytes > cap
    ? `${megabytes(entry.bytes)} MB is over the ${megabytes(cap)} MB limit`
    : null;
}

/** One flow's apt captures: its video and final screenshot, or, with no video, up to 4 screenshots. */
function flowPicks(flow: EvidenceEntry[]): EvidenceEntry[] {
  const video = flow.find((entry) => entry.kind === 'video');
  if (!video) return flow.filter((entry) => entry.kind === 'screenshot').slice(0, MAX_SHOTS);
  return [video, ...flow.filter((entry) => entry.file === shotFile(video.flow, 'final'))];
}

/** The apt set: each eligible flow's video and final screenshot, else up to 4 of its screenshots.
 * A failed or ineligible flow is never uploaded; a UI change with nothing to show says so. */
export function planMedia(
  entries: EvidenceEntry[],
  why: Ineligible,
  uiReason: string | null,
): MediaPlan {
  const out = ruledOut(entries, why);
  const notes = [...out].map(([flow, reason]) => `\`${flow}\`: not uploaded, ${reason}`);
  const usable = entries.filter((entry) => !out.has(entry.flow));
  const flows = [...new Set(usable.map((entry) => entry.flow))];
  const wanted = flows.flatMap((flow) => flowPicks(usable.filter((entry) => entry.flow === flow)));
  const fits = wanted.filter((entry) => sizeNote(entry) === null);
  for (const entry of wanted.filter((e) => sizeNote(e) !== null))
    notes.push(`\`${entry.file}\`: not uploaded, ${sizeNote(entry)}`);
  for (const entry of fits.slice(MAX_FILES))
    notes.push(`\`${entry.file}\`: not uploaded, over ${MAX_FILES} files`);
  if (fits.length === 0 && entries.length === 0 && uiReason)
    notes.push(
      `UI changed (${uiReason}); no QA capture recorded: run \`devkit machine up\`, \`devkit machine run <flow>\`, then \`devkit machine attach <this PR>\``,
    );
  return { picks: fits.slice(0, MAX_FILES), notes };
}

function provenanceLine(entry: EvidenceEntry): string {
  const head = `HEAD \`${entry.sourceHead.slice(0, 12)}\`${entry.dirty ? ' + uncommitted changes' : ''}`;
  const size = `${Math.max(1, Math.round(entry.bytes / 1024))} KB`;
  return `**${entry.flow}** · ${entry.kind} · ${size} · sha \`${shortSha(entry)}\` · ran the code this PR ships · ${head} · flow passed`;
}

/** An uploaded video is a bare URL on its own line, the form gh writes and GitHub plays inline; an
 * image, or a file gh has yet to upload, is markdown image syntax gh can rewrite in place. */
const mediaLine = (entry: EvidenceEntry, ref: string): string =>
  entry.kind === 'video' && ATTACHMENT.test(ref) ? ref : `![${entry.flow} ${entry.kind}](${ref})`;

/** The section; `refs` maps a short sha to its uploaded URL, or to the local path gh will upload. */
export function renderQaSection(plan: MediaPlan, refs: ReadonlyMap<string, string>): string {
  const shown = plan.picks.filter((entry) => refs.has(shortSha(entry)));
  const media = shown.flatMap((entry) => [
    provenanceLine(entry),
    '',
    mediaLine(entry, refs.get(shortSha(entry)) ?? ''),
    '',
  ]);
  return [
    QA_BEGIN,
    ...details(qaSummary(shown), [
      ...media,
      ...plan.notes.map((note) => `- ${note}`),
      ...(plan.notes.length ? [''] : []),
      "<sub>Recorded by `devkit machine run` on the agent's own machine: a captured run, not proof of causality.</sub>",
    ]),
    QA_END,
  ].join('\n');
}

/** The section's collapsed line: what it attached, or that it attached nothing (its notes say why). */
function qaSummary(shown: EvidenceEntry[]): string {
  if (!shown.length) return '⚠️ <b>QA capture</b> · nothing attached';
  const flows = new Set(shown.map((entry) => entry.flow)).size;
  const kinds = [...new Set(shown.map((entry) => entry.kind))].join(' + ');
  return `🎬 <b>QA capture</b> · ${flows} flow${flows === 1 ? '' : 's'} passed · ${kinds}`;
}

export const qaSectionOf = (body: string): string | null => sectionOf('qa', body);

/** Every uploaded capture in `body`, by short sha: the line after a sha cell is its media line. */
export function uploadedMedia(body: string): Map<string, string> {
  const lines = (qaSectionOf(body) ?? '').split('\n');
  const found = new Map<string, string>();
  lines.forEach((line, index) => {
    const sha = SHA_CELL.exec(line)?.[1];
    const media = lines.slice(index + 1).find((next) => next.trim() !== '');
    const url = media ? ATTACHMENT.exec(media)?.[0] : undefined;
    if (sha && url) found.set(sha, url);
  });
  return found;
}

export const withQaSection = (body: string, section: string): string =>
  withSection('qa', body, section);
