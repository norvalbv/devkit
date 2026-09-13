import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairConsistency } from '../../../../gate-engine/review/eval/reviewers/stats.mts';
import { groupByPair } from '../../../../gate-engine/review/eval/reviewers/corpus/twins.mts';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const protocol = read('freeze/protocol.json');
const result = read('baseline.json');
const verdicts = read('baseline-verdicts.json');
const publication = read('publication.json');
assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, 'baseline.json'))).digest('hex'), publication.publicResultSha256);
const sections = Object.values(result.sections).filter(s => s.executionHash === protocol.baseline.executionHash);
assert.equal(sections.length, 1);
const section = sections[0];
assert.equal(section.gateHash, protocol.baseline.gateHash);
assert.equal(section.corpusHash, protocol.corpus.nativeHash);
assert.equal(section.model, protocol.condition.model);
assert.equal(section.cascade, false);
assert.equal(section.chunkLoc, protocol.condition.cap);
assert.deepEqual(section.lensGroups, protocol.condition.groups);
assert.equal(verdicts.executionHash, section.executionHash);
assert.equal(Object.keys(section.rows).length, 285);
assert.equal(Object.keys(verdicts.rows).length, 285);
const rows = protocol.rows.map((meta, index) => {
  const row = section.rows[meta.id], verdict = verdicts.rows[meta.id];
  assert.equal(row.rowHash, meta.rowHash);
  assert.equal(row.behaviorHash, meta.behaviorHash);
  assert.equal(verdict.rowHash, meta.rowHash);
  assert.equal(row.expected, meta.expected);
  assert.equal(row.execution.complete, true);
  assert.equal(row.okFirst, verdict.firstVerdict === meta.expected);
  assert.equal(row.finalStatus, verdict.finalStatus);
  assert.equal(row.okFinal, row.finalStatus.toUpperCase() === meta.expected);
  return { ...meta, index, ...row, firstVerdict: verdict.firstVerdict };
});
function metrics(selected, field) {
  const scored = selected.map(row => ({ ...row, okFirst: row[field] }));
  const tally = label => ({ k: selected.filter(row => row.expected === label && row[field]).length, n: selected.filter(row => row.expected === label).length });
  const families = groupByPair(scored);
  const repairs = pairConsistency(scored);
  assert.equal(repairs.malformedGroups, 0);
  return { rows: selected.length, bugLabelFlags: tally('FAIL'), cleanLabelAcceptance: tally('PASS'), repairConsistency: repairs, wholeFamilyAgreement: { k: [...families.values()].filter(group => group.every(row => row.okFirst)).length, n: families.size } };
}
const scopes = { all: rows, original: rows.slice(0, 146), additions: rows.slice(146), development: rows.filter(row => row.partition === 'development'), reserved: rows.filter(row => row.partition === 'reserved') };
const summary = {
  schemaVersion: 1,
  interpretation: 'Completed frozen baseline: label agreement, not factual precision. Initial reviewer verdicts and final gate decisions after charter post-processing are separate. The historical 13.9% label-noise reference remains applicable.',
  executionHash: section.executionHash,
  eventId: publication.eventId,
  scopes: Object.fromEntries(Object.entries(scopes).map(([name, selected]) => [name, { initial: metrics(selected, 'okFirst'), finalGate: metrics(selected, 'okFinal') }])),
  initialFinalDisagreements: rows.filter(row => row.firstVerdict !== row.finalStatus.toUpperCase()).map(row => ({ id: row.id, expected: row.expected, firstVerdict: row.firstVerdict, finalStatus: row.finalStatus })),
};
assert.deepEqual(summary.scopes.all.initial.bugLabelFlags, section.metrics.firstFailRecall);
assert.deepEqual(summary.scopes.all.initial.cleanLabelAcceptance, section.metrics.firstCleanPass);
assert.deepEqual(summary.scopes.all.initial.repairConsistency, section.metrics.pairConsistency);
fs.writeFileSync(path.join(root, 'baseline-summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
