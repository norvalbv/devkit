import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeLoggedOut,
  codexLoggedOut,
  JUDGE_AUTH_CHECK,
  judgeAuthResult,
  type ProbeExec,
  type ProbeOutput,
} from '../lib/doctor/judge-auth.mts';

const ENV_KEYS = [
  'GUARD_REVIEW_MODEL',
  'GUARD_REVIEW_ESCALATION_MODEL',
  'GUARD_CORRECTNESS_MODEL',
  'GUARD_CODEX_BIN',
] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const out = (stdout: string, status = 0, stderr = ''): ProbeOutput => ({ status, stdout, stderr });
const codexTrio = {
  review: {
    model: 'gpt-5.6-terra@high',
    escalationModel: 'gpt-5.6-sol',
    correctnessModel: 'gpt-5.6-sol',
  },
};
const claudeTrio = {
  review: { model: 'haiku', escalationModel: 'opus', correctnessModel: 'sonnet' },
};

const exec =
  (byBin: Record<string, ProbeOutput | null>): ProbeExec =>
  (bin) =>
    byBin[bin] ?? null;

const CLAUDE_IN = out('{ "loggedIn": true, "authMethod": "claude.ai" }');
const CLAUDE_OUT = out('{ "loggedIn": false }');
const CODEX_IN = out('Logged in using ChatGPT');
const CODEX_OUT = out('Not logged in');

describe('positive-evidence probes', () => {
  it('claude: only a parsed loggedIn:false is a finding', () => {
    expect(claudeLoggedOut(exec({ claude: CLAUDE_OUT }))).toBe(true);
    expect(claudeLoggedOut(exec({ claude: CLAUDE_IN }))).toBe(false);
    expect(claudeLoggedOut(exec({ claude: out('not json at all') }))).toBe(false);
    expect(claudeLoggedOut(exec({ claude: out('{"loggedIn":"false"}') }))).toBe(false);
    // Prefixed warnings make the whole output unparseable — unknown, never logged-out.
    expect(claudeLoggedOut(exec({ claude: out('warning: stale cache\n{"loggedIn":false}') }))).toBe(
      false,
    );
    expect(claudeLoggedOut(exec({ claude: null }))).toBe(false); // ENOENT / timeout
  });

  it('codex: only a literal not-logged-in line is a finding, stderr included', () => {
    expect(codexLoggedOut(exec({ codex: CODEX_OUT }))).toBe(true);
    expect(codexLoggedOut(exec({ codex: out('', 1, 'Not logged in') }))).toBe(true);
    expect(codexLoggedOut(exec({ codex: CODEX_IN }))).toBe(false);
    expect(codexLoggedOut(exec({ codex: out('usage: codex login', 2) }))).toBe(false);
    // A mid-sentence mention in diagnostics is not status evidence — the signal is a whole line.
    expect(
      codexLoggedOut(exec({ codex: out('error: not logged in token refresh, see hint') })),
    ).toBe(false);
    expect(codexLoggedOut(exec({ codex: null }))).toBe(false);
  });

  it('codex probe honors GUARD_CODEX_BIN', () => {
    process.env.GUARD_CODEX_BIN = '/opt/custom/codex';
    expect(codexLoggedOut(exec({ '/opt/custom/codex': CODEX_OUT }))).toBe(true);
  });
});

describe('judgeAuthResult', () => {
  it('silent when every reachable runtime is logged in', () => {
    expect(judgeAuthResult(codexTrio, exec({ codex: CODEX_IN, claude: CLAUDE_IN }))).toBeNull();
  });

  it('a logged-out claude is a finding even on an all-codex trio — completeness is claude-pinned', () => {
    const r = judgeAuthResult(codexTrio, exec({ codex: CODEX_IN, claude: CLAUDE_OUT }));
    expect(r?.name).toBe(JUDGE_AUTH_CHECK);
    expect(r?.status).toBe('DRIFT');
    expect(r?.advisory).toBe(true); // reported, never gates the exit
    expect(r?.detail).toContain('claude');
  });

  it('codex auth is only probed when a resolved model routes there', () => {
    const r = judgeAuthResult(claudeTrio, exec({ codex: CODEX_OUT, claude: CLAUDE_IN }));
    expect(r).toBeNull();
  });

  it('both dark → one row naming both, remedies for each', () => {
    const r = judgeAuthResult(codexTrio, exec({ codex: CODEX_OUT, claude: CLAUDE_OUT }));
    expect(r?.detail).toContain('codex + claude');
    expect(r?.remediation).toContain('codex login');
    expect(r?.remediation).toContain('claude');
  });

  it('env model overrides steer the probe set', () => {
    process.env.GUARD_REVIEW_MODEL = 'gpt-5.6-terra@high';
    const r = judgeAuthResult(claudeTrio, exec({ codex: CODEX_OUT, claude: CLAUDE_IN }));
    expect(r?.detail).toContain('codex');
  });
});
