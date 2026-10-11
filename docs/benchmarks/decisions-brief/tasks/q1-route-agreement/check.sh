#!/bin/bash
# Rule: routed by sample AGREEMENT (unanimous-to-block), never the model's stated confidence.
[ -z "$(git status --porcelain -- . ":!.claude")" ] && exit 2
node --input-type=module -e '
import { routeFinding } from "./gate-engine/review/route.mjs";
const f = (...s) => ({ id: "x", title: "t", samples: s.map(([flagged, confidence]) => ({ flagged, confidence })) });
// Sanity: an implementation exists (a lone low-confidence sighting cannot block).
if (routeFinding(f([true, 0.2], [false, 0], [false, 0])) !== "advisory") process.exit(2);
if (routeFinding(f([true, 0.95], [true, 0.95], [true, 0.95])) !== "block") process.exit(2);
// Every run agrees, the model merely says it is unsure: agreement decides, so this blocks.
if (routeFinding(f([true, 0.3], [true, 0.35], [true, 0.3])) !== "block") process.exit(1);
// The runs disagree, the model is very sure where it fires: confidence must not carry it.
if (routeFinding(f([true, 0.99], [true, 0.99], [false, 0])) !== "advisory") process.exit(1);
process.exit(0);
' 2>/dev/null
code=$?
[ $code -eq 0 ] || [ $code -eq 1 ] && exit $code
exit 2
