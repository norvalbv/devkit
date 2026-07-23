import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const EXCLUDE_HEADER = '# devkit overlay (local-only) — not committed';
const AGENT_ASSET_RE = /^\.(?:claude|cursor)\/(?:skills|agents|hooks)(?:\/|\.json$)/;
const CLAUDE_LOCAL_SETTINGS_RE = /^\.claude\/settings\.local\.json$/;
const AGENT_MANIFEST_RE = /^\.devkit\/(?:skills|agents|agent-hooks)-manifest\.json$/;
const isManagedAgentPath = (line) => AGENT_ASSET_RE.test(line) || CLAUDE_LOCAL_SETTINGS_RE.test(line) || AGENT_MANIFEST_RE.test(line);
/** Exact-reconcile Devkit's agent paths after its local-only exclude marker. */
export function addToGitExclude(gitRoot, relPaths, dryRun) {
    const infoDir = join(gitRoot, '.git', 'info');
    const file = join(infoDir, 'exclude');
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const lines = existing.split('\n');
    const desired = new Set(relPaths);
    const headerAt = lines.indexOf(EXCLUDE_HEADER);
    const kept = lines.filter((line, index) => !(headerAt !== -1 && index > headerAt && isManagedAgentPath(line) && !desired.has(line)));
    const pruned = kept.length !== lines.length;
    const missing = relPaths.filter((path) => !kept.includes(path));
    if (!missing.length && !pruned) {
        console.log('  • .git/info/exclude already covers devkit files');
        return;
    }
    if (dryRun) {
        console.log(`  [dry-run] reconcile .git/info/exclude${missing.length ? `: add ${missing.join(', ')}` : ''}`);
        return;
    }
    const reconciled = kept.join('\n');
    const header = reconciled.includes(EXCLUDE_HEADER) ? '' : `\n${EXCLUDE_HEADER}\n`;
    const separator = reconciled && !reconciled.endsWith('\n') ? '\n' : '';
    mkdirSync(infoDir, { recursive: true });
    writeFileSync(file, `${reconciled}${separator}${header}${missing.join('\n')}${missing.length ? '\n' : ''}`);
    console.log('  ✓ reconciled local agent paths in .git/info/exclude');
}
