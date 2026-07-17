import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parsePlanCritiqueResponse } from "./contract.mjs";
import { persistBinding, repositoryContext, resolveEligibleBinding } from "./evidence-bindings.mjs";
import { buildCommitProjection, evidenceRoot, makeRecord, persistImmutableJson, persistRecord, pruneExpiredTranscriptBlobs, readRecord, sha256Text, writeContentBlob, } from "./evidence-store.mjs";
const CRITIQUE_AGENT_RE = /feature[-_ ]critique|plan[-_ ]critique/;
const CAPTURE_ENTRY_RE = /[/\\]capture\.(?:mts|mjs)$/;
const textField = (input, ...keys) => {
    for (const key of keys) {
        const value = input[key];
        if (typeof value === 'string' && value.length > 0)
            return value;
    }
    return null;
};
function workId(provider, input) {
    const explicit = process.env.DEVKIT_WORK_ID;
    if (explicit)
        return sha256Text(`explicit:${explicit}`);
    const source = textField(input, 'turn_id', 'session_id', 'conversation_id', 'generation_id') ?? 'unknown';
    return sha256Text(`${provider}:${source}`);
}
function lastMessage(provider, input) {
    if (provider === 'cursor')
        return textField(input, 'last_assistant_message', 'summary', 'result');
    return textField(input, 'last_assistant_message');
}
function isCritiqueAgent(input, raw) {
    const identity = [
        textField(input, 'agent_type'),
        textField(input, 'agent_name'),
        textField(input, 'task_name'),
        textField(input, 'task'),
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    if (CRITIQUE_AGENT_RE.test(identity))
        return true;
    if (!raw)
        return false;
    if (raw.includes('"kind"') && raw.includes('plan_critique'))
        return true;
    try {
        const parsed = JSON.parse(raw);
        return parsed?.kind === 'plan_critique';
    }
    catch {
        return false;
    }
}
function recordFiles() {
    const dir = join(evidenceRoot(), 'records');
    if (!existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => join(dir, name));
}
function lineageFor(work) {
    const records = recordFiles()
        .flatMap((path) => {
        try {
            const id = basename(path, '.json');
            const record = readRecord(id);
            return record?.workId === work ? [record] : [];
        }
        catch {
            return [];
        }
    })
        .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    const parent = records.at(-1) ?? null;
    return { parentCritiqueId: parent?.critiqueId ?? null, pass: (parent?.lineage.pass ?? 0) + 1 };
}
function transcriptEvidence(input) {
    if (process.env.DEVKIT_PLAN_CRITIQUE_CAPTURE_TRANSCRIPTS !== '1') {
        return { blob: null, expiresAt: null };
    }
    const path = textField(input, 'agent_transcript_path', 'transcript_path');
    if (!path)
        return { blob: null, expiresAt: null };
    try {
        const daysRaw = Number.parseInt(process.env.DEVKIT_PLAN_CRITIQUE_TRANSCRIPT_RETENTION_DAYS ?? '7', 10);
        const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 90) : 7;
        const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
        return { blob: writeContentBlob(readFileSync(path, 'utf8'), 'transcript'), expiresAt };
    }
    catch {
        return { blob: null, expiresAt: null };
    }
}
export function captureSubagentStop(provider, input, cwd = textField(input, 'cwd') ?? process.cwd()) {
    if (process.env.DEVKIT_NO_TELEMETRY === '1')
        return { status: 'skipped', reason: 'telemetry_disabled' };
    pruneExpiredTranscriptBlobs();
    const raw = lastMessage(provider, input);
    if (!isCritiqueAgent(input, raw))
        return { status: 'skipped', reason: 'not_plan_critique' };
    if (!raw)
        return { status: 'skipped', reason: 'missing_final_message' };
    try {
        const context = repositoryContext(cwd);
        const work = workId(provider, input);
        const contract = parsePlanCritiqueResponse(raw);
        const lineage = lineageFor(work);
        const transcript = transcriptEvidence(input);
        const record = makeRecord({
            contract,
            context,
            workId: work,
            provider,
            model: textField(input, 'model'),
            prompt: textField(input, 'prompt', 'task'),
            completedAt: textField(input, 'completed_at'),
            parentCritiqueId: lineage.parentCritiqueId,
            pass: lineage.pass,
            transcriptBlob: transcript.blob,
            transcriptExpiresAt: transcript.expiresAt,
        });
        persistRecord(record);
        persistBinding(context, record);
        return {
            status: 'captured',
            reason: record.contract.eligibilityReason,
            critiqueId: record.critiqueId,
            eligible: record.contract.eligible,
        };
    }
    catch (error) {
        return {
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}
export function observePlanStop(provider, input, cwd = textField(input, 'cwd') ?? process.cwd()) {
    if (process.env.DEVKIT_NO_TELEMETRY === '1')
        return { status: 'skipped', reason: 'telemetry_disabled' };
    if (provider === 'cursor') {
        const observationId = randomUUID();
        try {
            persistImmutableJson(`observations/${observationId}.json`, {
                schemaVersion: 1,
                kind: 'provider_capability_observation',
                observationId,
                provider,
                capability: 'current_composer_mode_at_stop',
                availability: 'unavailable',
                observedAt: new Date().toISOString(),
                reason: 'composer_mode_capability_unavailable',
            });
            return {
                status: 'skipped',
                reason: 'composer_mode_capability_unavailable',
                observationId,
            };
        }
        catch {
            return { status: 'skipped', reason: 'composer_mode_capability_unavailable' };
        }
    }
    if (textField(input, 'permission_mode') !== 'plan')
        return { status: 'skipped', reason: 'not_plan_mode' };
    try {
        const context = repositoryContext(cwd);
        const work = workId(provider, input);
        const resolution = resolveEligibleBinding(cwd, work);
        const latest = resolution.record;
        const finalPlan = lastMessage(provider, input);
        const observationId = randomUUID();
        persistImmutableJson(`observations/${observationId}.json`, {
            schemaVersion: 1,
            kind: 'plan_stop_observation',
            observationId,
            workId: work,
            provider,
            repositoryFingerprint: context.repositoryFingerprint,
            branch: context.branch,
            head: context.head,
            observedAt: new Date().toISOString(),
            critiqueId: latest?.critiqueId ?? null,
            status: latest ? 'linked' : 'skipped',
            reason: latest ? 'matched_eligible_binding' : resolution.reason,
            finalPlanHash: finalPlan ? sha256Text(finalPlan) : null,
            finalPlanBlob: finalPlan ? writeContentBlob(finalPlan, 'plan') : null,
        });
        return {
            status: 'observed',
            reason: latest ? 'linked' : resolution.reason,
            observationId,
            critiqueId: latest?.critiqueId,
        };
    }
    catch (error) {
        return {
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}
/** Shadow-only commit observation. The projection is recorded, never added to reviewer input. */
export function observeCommitProjection(cwd = process.cwd()) {
    if (process.env.DEVKIT_NO_TELEMETRY === '1')
        return { status: 'skipped', reason: 'telemetry_disabled' };
    try {
        const explicitWork = process.env.DEVKIT_WORK_ID
            ? sha256Text(`explicit:${process.env.DEVKIT_WORK_ID}`)
            : undefined;
        const resolution = resolveEligibleBinding(cwd, explicitWork);
        const observationId = randomUUID();
        persistImmutableJson(`commit-projections/${observationId}.json`, {
            schemaVersion: 1,
            kind: 'plan_critique_commit_projection_observation',
            observationId,
            observedAt: new Date().toISOString(),
            status: resolution.status,
            reason: resolution.reason,
            candidates: resolution.candidates,
            critiqueId: resolution.record?.critiqueId ?? null,
            projection: resolution.record?.sanitizedProjection
                ? buildCommitProjection(resolution.record.sanitizedProjection)
                : null,
        });
        return {
            status: 'observed',
            reason: resolution.reason,
            observationId,
            critiqueId: resolution.record?.critiqueId,
        };
    }
    catch (error) {
        return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
}
// Internal hook entry point. This is intentionally not exported as a devkit command: generated
// commit hooks invoke the shipped module by path and always ignore its exit status.
if (CAPTURE_ENTRY_RE.test(process.argv[1] ?? '') && process.argv[2] === 'commit-projection') {
    observeCommitProjection(process.cwd());
}
