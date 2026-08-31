# External-record anti-slop extensions

Devkit adds two rules to its composed anti-slop plugin for operations on values that can be proven,
from syntax and local scope, to originate at `JSON.parse`. They are Devkit-owned extensions rather
than changes to the 15 byte-pinned upstream rules.

Both extensions default to **error**, like the 15 upstream rules. A repository can still lower or
disable either rule in the Oxlint config that extends Devkit's managed base:

```json
{
  "extends": ["./.devkit/oxc/oxlint.base.json"],
  "rules": {
    "anti-slop/no-unsafe-external-record-access": "warn",
    "anti-slop/no-unsafe-external-record-enumeration": "off"
  }
}
```

Fresh adoption remains explicit: run `devkit anti-slop create [paths...]` before the first check.
For an already-adopted repository, `devkit upgrade` adds existing findings only for rule IDs newly
activated by the refreshed managed manifest/config; all prior rule entries and counts remain
shrink-only. Any earlier `init` or `doctor --fix` capability refresh preserves that activation
evidence in a retry marker for the next upgrade. `devkit oxc lint` loads anti-slop as no-ops so
ordinary native lint does not bypass that baseline; `devkit anti-slop check` activates these
implementations and applies the debt record.

| Rule                                    | Reports                                                                                                                                                                    | Accepted local proof                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `no-unsafe-external-record-access`      | Dynamic keys and prototype-sensitive literal keys such as `constructor`, `prototype`, and `toString` on a direct, member, or stable-`const` alias of a `JSON.parse` result | `Object.hasOwn(files, key)` controls the same access through a branch, short circuit, or terminating rejection guard          |
| `no-unsafe-external-record-enumeration` | `Object.entries(value)` or `Object.keys(value)` where `value` has a locally provable JSON origin                                                                           | A non-null object proof (`Object(value) === value`, or `typeof value === "object" && value !== null`) plus an array rejection |

```js
const payload = JSON.parse(body);

payload[key]; // fail: a dynamic key can resolve an inherited member
payload['constructor']; // fail: a known Object.prototype member
payload['map']; // fail: JSON.parse may have returned an array
payload['https://example.com/profile']; // pass: a fixed, non-prototype key

if (Object.hasOwn(payload, key)) payload[key]; // pass

Object.entries(payload); // fail: JSON.parse can return a primitive or array
if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
  Object.entries(payload); // pass
}
```

The access proof must still hold at the read: a call, property getter, assignment, update, or `delete`
between `Object.hasOwn` and the computed access invalidates it.
Repeated member syntax is not identity proof because a getter or proxy can return a different value;
capture a JSON-derived member in a stable `const`, then guard and access that binding.

The access rule can also inspect all parameters typed `Record<string, …>` when explicitly configured:

```json
{
  "anti-slop/no-unsafe-external-record-access": ["error", { "includeRecordParameters": true }]
}
```

That option is broader because a syntax-only rule cannot prove which callers supplied external data.
It remains opt-in even after the rule itself is enabled.

These rules deliberately do not infer provenance across function calls or validate primitive fields
such as booleans. The access rule keeps non-literal keys conservative but does not require an own-key
proof for fixed literals outside prototype names reachable from JSON values and the standard
pollution path. Calls with a reviver (including spread arguments) and opted-in `Record` parameters
keep the stricter all-computed-key proof because they can produce custom prototypes. Broader
guarantees require explicit boundary validation or a type-aware rule.
