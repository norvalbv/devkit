// The ui-evidence task item in a PR body: an unticked checkbox the screenshot reminder leaves on the
// PR. Ship never ticks or removes it, because devkit cannot verify screenshots; the author ticks it.
export const UI_ITEM_BEGIN = '<!-- devkit:ui-evidence:begin -->';
export const UI_ITEM_END = '<!-- devkit:ui-evidence:end -->';
// Whole marker lines only, the same shape as the evidence block's.
const ITEM =
  /^<!-- devkit:ui-evidence:begin -->\r?\n[\s\S]*?\n<!-- devkit:ui-evidence:end -->(?=\r?$)/m;

export const renderUiItem = (detail: string): string =>
  [
    UI_ITEM_BEGIN,
    `- [ ] 📸 ${detail.replace(/\s+/g, ' ').trim().replaceAll('<', '&lt;')}`,
    UI_ITEM_END,
  ].join('\n');

/**
 * The caller's own item wins (it may be ticked), then the PR's current one, then a new one when the
 * reminder fired. Never removed: a re-ship judges only its own paths, so silence there resolves nothing.
 */
export function withUiItem(body: string, currentBody: string, detail: string | null): string {
  if (ITEM.test(body)) return body;
  const item = ITEM.exec(currentBody)?.[0] ?? (detail ? renderUiItem(detail) : null);
  if (!item) return body;
  const text = body.trimEnd();
  return text ? `${text}\n\n${item}\n` : `${item}\n`;
}
