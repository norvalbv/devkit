/** Typed parsing of the installed devkit components and review profile. */
import { isAbsolute } from 'node:path';
import { DEFAULT_REVIEW_DECISIONS_DIR, GUARD_IDS, normalizeReviewProfile, normalizeSelection, REVIEWABLE_GUARD_IDS, } from "../../components.mjs";
import { reviewGuardIssues } from "../../install/review-profile.mjs";
import { normalizeSafeReviewRelativePath } from "./runtime-paths.mjs";
export const REVIEW_SETUP_DOCTOR = "run 'devkit doctor --fix'.";
function fail(message) {
    throw new Error(`devkit review: ${message}`);
}
function objectValue(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return fail(`${label} must be a JSON object — ${REVIEW_SETUP_DOCTOR}`);
    }
    return value;
}
function booleanField(value, label) {
    if (value !== undefined && typeof value !== 'boolean')
        fail(`${label} must be a boolean — ${REVIEW_SETUP_DOCTOR}`);
    return value;
}
function stringField(value, label) {
    if (value !== undefined && typeof value !== 'string')
        fail(`${label} must be a string — ${REVIEW_SETUP_DOCTOR}`);
    if (typeof value === 'string' && value.includes('\0'))
        fail(`${label} contains a NUL byte — ${REVIEW_SETUP_DOCTOR}`);
    return value;
}
function stringArray(value, label) {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
        return fail(`${label} must be an array of strings — ${REVIEW_SETUP_DOCTOR}`);
    }
    if (value.some((entry) => entry.includes('\0')) || new Set(value).size !== value.length) {
        return fail(`${label} contains an invalid or duplicate value — ${REVIEW_SETUP_DOCTOR}`);
    }
    return value;
}
function parseConfigJson(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw.toString('utf8'));
    }
    catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return fail(`could not parse .devkit/config.json (${message}) — ${REVIEW_SETUP_DOCTOR}`);
    }
    return objectValue(parsed, '.devkit/config.json');
}
function parseOverlayMode(config) {
    const overlay = booleanField(config.overlay, '.devkit/config.json overlay') === true;
    const standalone = booleanField(config.standalone, '.devkit/config.json standalone') === true;
    if (overlay && standalone)
        fail(`.devkit/config.json cannot enable overlay and standalone — ${REVIEW_SETUP_DOCTOR}`);
    const origHooksPath = stringField(config.origHooksPath, '.devkit/config.json origHooksPath');
    if (origHooksPath && isAbsolute(origHooksPath))
        fail(`.devkit/config.json origHooksPath must be repository-relative — ${REVIEW_SETUP_DOCTOR}`);
    return overlay;
}
function parseInstalledSelection(config) {
    const components = config.components === undefined
        ? {}
        : objectValue(config.components, '.devkit/config.json components');
    const recordedGuards = components.guards === undefined
        ? undefined
        : stringArray(components.guards, '.devkit/config.json components.guards');
    const recordedHusky = booleanField(components.husky, '.devkit/config.json components.husky');
    const unknownInstalled = (recordedGuards ?? []).filter((guard) => !GUARD_IDS.includes(guard));
    if (unknownInstalled.length)
        fail(`components.guards contains unknown guards: ${unknownInstalled.join(', ')} — ${REVIEW_SETUP_DOCTOR}`);
    const selection = normalizeSelection({
        ...components,
        ...(recordedGuards === undefined ? {} : { guards: recordedGuards }),
        ...(recordedHusky === undefined ? {} : { husky: recordedHusky }),
    });
    if (!selection.husky)
        fail(`review requires the installed Husky component — ${REVIEW_SETUP_DOCTOR}`);
    return selection;
}
function parseRequestedGuards(settings, installed) {
    const requested = settings.guards === undefined
        ? installed.filter((guard) => REVIEWABLE_GUARD_IDS.includes(guard))
        : stringArray(settings.guards, '.devkit/config.json review.guards');
    const { invalid } = reviewGuardIssues(requested, installed);
    if (invalid.length)
        fail(`review.guards contains unknown or uninstalled guards: ${invalid.join(', ')} — run 'devkit init --review'.`);
    return requested;
}
function parseReviewProfile(config, installed) {
    const settings = config.review === undefined ? {} : objectValue(config.review, '.devkit/config.json review');
    const enabled = booleanField(settings.enabled, '.devkit/config.json review.enabled') ?? true;
    if (!enabled)
        fail("disabled by .devkit/config.json — run 'devkit init --review'.");
    const requested = parseRequestedGuards(settings, installed);
    const decisionsDir = stringField(settings.decisionsDir, '.devkit/config.json review.decisionsDir');
    if (decisionsDir !== undefined && !decisionsDir.trim()) {
        fail(`.devkit/config.json review.decisionsDir must not be empty — ${REVIEW_SETUP_DOCTOR}`);
    }
    const normalizedDecisionsDir = decisionsDir === undefined
        ? DEFAULT_REVIEW_DECISIONS_DIR
        : normalizeSafeReviewRelativePath(decisionsDir);
    if (normalizedDecisionsDir === null)
        fail(`.devkit/config.json review.decisionsDir must be repository-relative — ${REVIEW_SETUP_DOCTOR}`);
    return normalizeReviewProfile({ enabled, guards: requested, decisionsDir: normalizedDecisionsDir }, installed, { enabledDefault: true });
}
export function parseReviewSetupProfile(raw) {
    const config = parseConfigJson(raw);
    const installed = parseInstalledSelection(config).guards;
    return {
        raw: config,
        overlay: parseOverlayMode(config),
        profile: parseReviewProfile(config, installed),
    };
}
