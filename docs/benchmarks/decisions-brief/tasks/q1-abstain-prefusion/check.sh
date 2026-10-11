#!/bin/bash
# Rule: abstention is computed from the PRE-FUSION lexical top-1 score, never the fused score.
[ -z "$(git status --porcelain -- . ":!.claude")" ] && exit 2
node --input-type=module -e '
import { fuse } from "./gate-engine/decisions/recall/fuse.mjs";
const sem = [{ slug: "a", score: 0.81 }, { slug: "b", score: 0.4 }];
const strong = [{ slug: "a", score: 11.2 }, { slug: "b", score: 3.1 }];
const weak = [{ slug: "b", score: 0.7 }, { slug: "a", score: 0.2 }];
const plain = fuse(strong, sem);
if (plain.rows.length !== 2) process.exit(2);
const w = fuse(weak, sem, { minScore: 4 });
if (w.rows.length !== 0) process.exit(2); // abstention not implemented at all
// Lexical top-1 is 11.2 >= 4, so this must answer. A fused score (~0.03) can never clear 4.
const s = fuse(strong, sem, { minScore: 4 });
process.exit(s.rows.length === 2 ? 0 : 1);
' 2>/dev/null
code=$?
[ $code -eq 0 ] || [ $code -eq 1 ] && exit $code
exit 2
