# Piece 4 — Validate on frink-primitives (component-lib shape)

> The cross-shape proof. Piece 3 showed the engine governs devkit's own domain-gated `.mjs` trees;
> this validates the OTHER end of the spectrum — a flat `.tsx` PascalCase component library — on a
> REAL repo (`../frink-primitives`), read-only (the repo is not mutated). Together they show one
> engine spans both shapes, neither of which frink's six hardcoded walkers could express.

## The target

`frink-primitives/src/` is a flat component library: 17 PascalCase `.tsx` files (`Alert.tsx`,
`Button.tsx`, …) + `cn.ts` (className helper) + `index.ts` (barrel). No subfolders, no `lib/`, no
import walls. `sourceExtensions: ['ts','tsx']`.

## The grammar (one flat tree)

```jsonc
{
  "name": "primitives",
  "root": "src",
  "sourceExtensions": ["ts", "tsx"],
  "entryAllowlist": ["index.ts", "cn.ts"],
  "grammar": { "files": ["index.ts", "cn.ts", "{pascal}", "{test}"] },
  // walls: []  (no import walls → the import-wall generator early-returns)
}
```

`{pascal}` = a PascalCased component file; `cn.ts`/`index.ts` are literal allowances; `{test}` covers
colocated tests. No `folders`/`recurse`/`domainGate` — the flat shape needs none. This is precisely
the case the six hand-written electron walkers cannot represent (they all assume
`components`/`features`/`hooks`/`lib` dispatch).

## Validation (read-only on the real repo + a tmp copy for the negative case)

| Check | Result |
|-------|--------|
| `walkTree` on the REAL `frink-primitives/src` | **0 violators** — the flat grammar governs it cleanly (clean baseline) |
| misplaced `badName.tsx` (camelCase) + loose `helpers.ts` (tmp copy) | **both flagged** — only PascalCase `.tsx` + the two literals + tests are allowed |
| `generateImportWallBaseline` with `walls: []` | **`[]`** — empty-walls early-return, no eslint scan |
| `compileToEslint` shape | `structureRoot=src`, `pascal=^[A-Z][A-Za-z0-9]*\.(ts\|tsx)$`, root children `index.ts,cn.ts,{pascal},{test}` |

The misplaced-file proof was run on a TEMP copy mirroring the shape (the real frink-primitives was not
modified). The flat-component-lib case is also pinned permanently in
`cli/__tests__/structure-walk.test.mjs`.

## Schema gaps found

**None.** The existing schema (flat `grammar.files` with `{pascal}`/`{camel}`/`{test}` + literal
allowances) expresses the component-lib shape with no new fields. No fold-back to Piece 1 needed.

## Adoption note (for when the user wires it into frink-primitives)

Add the tree above to a `guard.config.json` `structure` block in frink-primitives, generate the
baseline (`[]`), emit the eslint shim, and wire `lint:structure`. The repo already ships its own
`eslint-rules/` — reconcile with those or run the structure rule alongside. NOT done here (no mutation
of that repo without the user's go-ahead).
