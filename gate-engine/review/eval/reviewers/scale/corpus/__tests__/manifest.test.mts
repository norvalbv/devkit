import { describe, expect, it } from 'vitest';
import { manifestHash, parseManifest } from '../manifest.mts';

const hash = 'a'.repeat(64);
function manifest() {
  const entry = {
    id: 'case-001',
    family: 'family-001',
    incidentSha256: hash,
    exposure: 'exposed-development',
    role: 'bug',
    variantOf: null,
    targetLens: 'state-transitions',
    qualification: 'unresolved',
    source: {
      repoAlias: 'repo-001',
      baseSha: 'b'.repeat(40),
      diffSha256: hash,
      provenanceSha256: hash,
    },
    evidence: { requirementSha256: null, controlSha256: null, assessmentSha256: null },
    spans: [
      { file: 'src/task.ts', side: 'post', start: 1, end: 2, fileSha256: hash, spanSha256: hash },
    ],
  };
  return {
    version: 1,
    mode: 'zero-judge-source-census',
    entries: [entry],
    selectedFamilies: ['family-001'],
  };
}

describe('source census manifest', () => {
  it('retains uncertainty and changes identity when qualification evidence changes', () => {
    const input = manifest();
    const first = parseManifest(JSON.stringify(input));
    input.entries[0].evidence.controlSha256 = 'c'.repeat(64);
    expect(manifestHash(parseManifest(JSON.stringify(input)))).not.toBe(manifestHash(first));
    expect(first.entries[0].qualification).toBe('unresolved');
  });
  it('rejects duplicate cases, missing variant targets and source-incident bridges', () => {
    const input = manifest();
    input.entries.push(structuredClone(input.entries[0]));
    expect(() => parseManifest(JSON.stringify(input))).toThrow('DUPLICATE_CASE');
    input.entries[1].id = 'case-002';
    input.entries[1].variantOf = 'case-003';
    expect(() => parseManifest(JSON.stringify(input))).toThrow('INVALID_VARIANT');
    input.entries[1].variantOf = null;
    input.entries[1].family = 'family-002';
    expect(() => parseManifest(JSON.stringify(input))).toThrow('INCIDENT_BRIDGE');
  });
  it('checks excluded universe members before selection and prevents split leakage', () => {
    const input = manifest();
    input.entries.push({
      ...structuredClone(input.entries[0]),
      id: 'case-002',
      exposure: 'reserved',
    });
    expect(() => parseManifest(JSON.stringify(input))).toThrow('EXPOSURE_SPLIT');
    input.entries[1].family = 'family-002';
    input.entries[1].variantOf = 'case-001';
    input.entries[1].role = 'repair';
    expect(() => parseManifest(JSON.stringify(input))).toThrow('FAMILY_BRIDGE');
  });
  it('does not qualify a repair from empty receipts or an unresolved sibling', () => {
    const input = manifest();
    input.entries[0].qualification = 'qualified-pair';
    expect(() => parseManifest(JSON.stringify(input))).toThrow('MISSING_QUALIFICATION_EVIDENCE');
    input.entries[0].evidence = {
      requirementSha256: hash,
      controlSha256: hash,
      assessmentSha256: hash,
    };
    expect(() => parseManifest(JSON.stringify(input))).toThrow('INCOMPLETE_QUALIFIED_FAMILY');
    input.entries.push({
      ...structuredClone(input.entries[0]),
      id: 'case-002',
      role: 'repair',
      variantOf: 'case-001',
    });
    expect(parseManifest(JSON.stringify(input)).entries).toHaveLength(2);
    input.entries[1].qualification = 'unresolved';
    expect(() => parseManifest(JSON.stringify(input))).toThrow('INCOMPLETE_QUALIFIED_FAMILY');
    input.entries[1].role = 'bug';
    expect(() => parseManifest(JSON.stringify(input))).toThrow('INVALID_VARIANT');
  });
  it('binds a qualified repair to its bug incident, repository and requirement', () => {
    const input = manifest();
    input.entries[0].qualification = 'qualified-pair';
    input.entries[0].evidence = {
      requirementSha256: hash,
      controlSha256: hash,
      assessmentSha256: hash,
    };
    input.entries.push({
      ...structuredClone(input.entries[0]),
      id: 'case-002',
      role: 'repair',
      variantOf: 'case-001',
    });
    const repair = structuredClone(input.entries[1]);
    for (const change of [
      { incidentSha256: 'd'.repeat(64) },
      { source: { ...repair.source, repoAlias: 'repo-002' } },
      { targetLens: 'writer-reader-contracts' },
      { evidence: { ...repair.evidence, requirementSha256: 'd'.repeat(64) } },
    ]) {
      input.entries[1] = { ...repair, ...change };
      expect(() => parseManifest(JSON.stringify(input))).toThrow('REPAIR_TARGET_MISMATCH');
    }
    input.entries[1] = repair;
    input.entries.push({ ...structuredClone(input.entries[0]), id: 'case-003' });
    expect(() => parseManifest(JSON.stringify(input))).toThrow('INCOMPLETE_QUALIFIED_FAMILY');
  });
  it('rejects unsafe paths, arbitrary aliases, unknown fields and invalid selection', () => {
    const input = manifest();
    input.entries[0].spans[0].file = '../private.ts';
    expect(() => parseManifest(JSON.stringify(input))).toThrow('INVALID_MANIFEST');
    input.entries[0].spans[0].file = 'src/task.ts';
    input.entries[0].source.repoAlias = 'private project name';
    expect(() => parseManifest(JSON.stringify(input))).toThrow('INVALID_MANIFEST');
    input.entries[0].source.repoAlias = 'repo-001';
    expect(() => parseManifest(JSON.stringify({ ...input, privateClaim: 'secret' }))).toThrow(
      'INVALID_MANIFEST',
    );
    input.selectedFamilies = ['family-999'];
    expect(() => parseManifest(JSON.stringify(input))).toThrow('INVALID_SELECTION');
  });
});
