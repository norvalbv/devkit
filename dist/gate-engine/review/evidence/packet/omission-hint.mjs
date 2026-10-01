// sc-2305: ONE predicate for a shell-less judge (checklist-less, claude runtime), shared by the
// packet's Read hint and its one-time cache salt so the two can never drift apart.
import { isCodexModel } from '../../../judge/codex/result.mjs';
import { readFileHint } from '../../diff-evidence.mjs';
import { hasChecklist } from '../../reviewers.mjs';
export function judgeLacksShell(reviewer, model) {
    return !hasChecklist(reviewer) && !isCodexModel(model);
}
/** Options for buildCappedDiffEvidence: the Read hint for a shell-less judge, else the default. */
export function omissionHintFor(reviewer, model) {
    return judgeLacksShell(reviewer, model) ? { hint: readFileHint } : {};
}
/** Cache-salt suffix for the same judges — '' for everyone the hint change never touched. */
export function omissionHintSalt(reviewer, model) {
    return judgeLacksShell(reviewer, model) ? '\0omitted-read-hint-v1' : '';
}
