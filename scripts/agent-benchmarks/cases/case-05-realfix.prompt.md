Critique this pre-implementation plan.

PROBLEM: `parseRelativeDate(input)` throws (`Cannot read properties of null`) when `input` is null. Several callers pass null when an optional date field is absent, so the crash surfaces as an unhandled error in the chat composer.

PROPOSED SOLUTION: In `src/shared/lib/dates.ts`, add `if (input == null) return null;` at the top of `parseRelativeDate`, and add a unit test covering null, undefined, a valid ISO date, and a malformed string.

RECORDED TARGETS: none touch date parsing. This is a localized null-safety bug fix in a pure utility, no trust boundary, no source-of-truth or sync concern.
