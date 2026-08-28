import { selectReviewFiles } from '../../../skills/_devkit/review-roots.mjs';
import { sourceMatchers } from '../../config.mjs';
const RE_PROSE_FILE = /\.(md|mdx|markdown|txt)$/i;
const PROSE_FILTERED_DOMAINS = new Set(['backend', 'frontend']);
const UNION_ROOT_DOMAINS = new Set(['all', 'conventions']);
/** The deduped union of every declared review root. */
export function declaredRoots(cfg) {
    return [...new Set([...cfg.scanRoots, ...cfg.review.backendRoots, ...cfg.review.frontendRoots])];
}
/** The config roots that trigger a reviewer's domain. */
export function rootsFor(reviewer, cfg) {
    const directRoots = new Map([
        ['backend', cfg.review.backendRoots],
        ['frontend', cfg.review.frontendRoots],
    ]);
    const direct = directRoots.get(reviewer.domain);
    if (direct !== undefined)
        return direct;
    if (UNION_ROOT_DOMAINS.has(reviewer.domain))
        return declaredRoots(cfg);
    return cfg.scanRoots;
}
export function underRoot(file, root) {
    const normalizedRoot = root.endsWith('/') ? root.slice(0, -1) : root;
    if (normalizedRoot === '.')
        return true;
    return file === normalizedRoot || file.startsWith(`${normalizedRoot}/`);
}
function scopedReviewFiles(stagedFiles, cfg) {
    return selectReviewFiles(stagedFiles, {
        paths: cfg.review.paths,
        roots: declaredRoots(cfg),
        sourceExtensions: cfg.sourceExtensions,
    });
}
function filesUnderReviewerRoots(reviewer, files, cfg, configuredScope) {
    if (configuredScope && UNION_ROOT_DOMAINS.has(reviewer.domain))
        return files;
    const roots = rootsFor(reviewer, cfg);
    return files.filter((file) => roots.some((root) => underRoot(file, root)));
}
function withoutProse(reviewer, files) {
    if (!PROSE_FILTERED_DOMAINS.has(reviewer.domain))
        return files;
    return files.filter((file) => !RE_PROSE_FILE.test(file));
}
function sourceFiles(files, cfg) {
    const { isSource } = sourceMatchers(cfg.sourceExtensions);
    return files.filter((file) => isSource(file.split('/').pop() ?? ''));
}
function initialReviewFiles(stagedFiles, cfg) {
    if (cfg.review.paths === undefined)
        return stagedFiles;
    return scopedReviewFiles(stagedFiles, cfg);
}
function allReviewerFiles(files, stagedFiles, cfg) {
    if (cfg.review.paths !== undefined)
        return files;
    return scopedReviewFiles(stagedFiles, cfg);
}
function codeReviewerFiles(reviewer, files, cfg) {
    if (reviewer.domain !== 'code')
        return files;
    return sourceFiles(files, cfg);
}
function reviewerFiles(reviewer, stagedFiles, cfg) {
    const configuredScope = cfg.review.paths !== undefined;
    const files = initialReviewFiles(stagedFiles, cfg);
    if (reviewer.domain === 'all')
        return allReviewerFiles(files, stagedFiles, cfg);
    const domainFiles = withoutProse(reviewer, filesUnderReviewerRoots(reviewer, files, cfg, configuredScope));
    return codeReviewerFiles(reviewer, domainFiles, cfg);
}
/** Union each reviewer's staged and HEAD selection so a config change cannot self-exempt. */
export function reviewerFilesAcrossPolicies(reviewer, stagedFiles, cfg, baselineCfg) {
    const selected = new Set(reviewerFiles(reviewer, stagedFiles, cfg));
    for (const file of baselineCfg ? reviewerFiles(reviewer, stagedFiles, baselineCfg) : [])
        selected.add(file);
    return stagedFiles.filter((file) => selected.has(file));
}
