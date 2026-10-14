import { describe, expect, it } from 'vitest';
import { carryEvidenceBlock, EVIDENCE_BEGIN, EVIDENCE_END } from './block.mts';
import { renderUiItem, UI_ITEM_BEGIN, UI_ITEM_END, withUiItem } from './ui-item.mts';

const DETAIL = 'Add before and after screenshots — UI paths changed: src/Card.tsx';
const ticked = (item: string) => item.replace('- [ ]', '- [x]');

describe('ui-evidence PR-body item', () => {
  it('adds an unticked item when the reminder fired and the PR has none', () => {
    const body = withUiItem('Fixes the card.\n', '', DETAIL);
    expect(body).toBe(`Fixes the card.\n\n${renderUiItem(DETAIL)}\n`);
    expect(body).toContain(`${UI_ITEM_BEGIN}\n- [ ] 📸 ${DETAIL}\n${UI_ITEM_END}`);
  });

  it('adds nothing when the reminder stayed quiet and the PR has no item', () => {
    expect(withUiItem('Fixes the API.', '', null)).toBe('Fixes the API.');
  });

  it("keeps the PR's ticked item over a quiet re-ship's replacement body", () => {
    const current = `old body\n\n${ticked(renderUiItem(DETAIL))}\n`;
    const body = withUiItem('new body', current, null);
    expect(body).toBe(`new body\n\n${ticked(renderUiItem(DETAIL))}\n`);
  });

  it("keeps the PR's item rather than a newer reminder's text, so a tick is never reset", () => {
    const current = ticked(renderUiItem(DETAIL));
    const body = withUiItem(
      'new body',
      current,
      'Add screenshots — UI paths changed: src/Other.tsx',
    );
    expect(body).toContain('- [x] 📸');
    expect(body.split(UI_ITEM_BEGIN)).toHaveLength(2);
  });

  it("the caller's own item wins and is never duplicated", () => {
    const caller = `mine\n\n${ticked(renderUiItem(DETAIL))}`;
    expect(withUiItem(caller, renderUiItem(DETAIL), DETAIL)).toBe(caller);
  });

  it('flattens the detail to one line and escapes markup', () => {
    expect(renderUiItem('a\n  <b>c</b>')).toContain('- [ ] 📸 a &lt;b>c&lt;/b>\n');
  });

  it('a marker quoted inside a line is not an item', () => {
    const caller = `see ${UI_ITEM_BEGIN} x ${UI_ITEM_END}`;
    expect(withUiItem(caller, '', DETAIL)).toContain(`\n\n${renderUiItem(DETAIL)}\n`);
  });

  it('sits beside the evidence block without either replacing the other', () => {
    const evidence = `${EVIDENCE_BEGIN}\nverdict\n${EVIDENCE_END}`;
    const current = `old\n\n${evidence}\n\n${renderUiItem(DETAIL)}\n`;
    const body = withUiItem(carryEvidenceBlock('new', current), current, null);
    expect(body).toContain(evidence);
    expect(body).toContain(renderUiItem(DETAIL));
    expect(body.startsWith('new')).toBe(true);
  });
});
