import { readFileSync, writeFileSync } from 'node:fs';
import { type MoveContext, rewriteSource, type SourceRewrite } from './rewrite-plan.mts';

const BOM = '\uFEFF';

/** Rewrite the file at `diskPath` (pre-move `virtualPath`) from the bytes it holds now; the
 * read-to-write window is unguarded by design, see the move-rewrites decision. */
export function rewriteFile(
  diskPath: string,
  virtualPath: string,
  ctx: MoveContext,
): SourceRewrite {
  const raw = readFileSync(diskPath, 'utf8');
  const bom = raw.startsWith(BOM);
  const result = rewriteSource(bom ? raw.slice(1) : raw, virtualPath, ctx);
  if (result.text != null) writeFileSync(diskPath, (bom ? BOM : '') + result.text);
  return result;
}
