import type { ExtraGate } from './command-gates.mts';

// The parsed `parseOpts` shape. `extra` is always present (built up in the loop); the rest
// appear only when their flag was passed.
export interface ParsedOpts {
  extra: ExtraGate[];
  hookPath?: string;
  scope?: string;
  structure?: string;
  only?: string[];
}

export function parseOpts(argv: string[]): ParsedOpts {
  const opts: ParsedOpts = { extra: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--hook' && argv[i + 1]) opts.hookPath = argv[++i];
    else if (argv[i] === '--scope' && argv[i + 1]) opts.scope = argv[++i];
    else if (argv[i] === '--structure' && argv[i + 1]) opts.structure = argv[++i];
    else if (argv[i] === '--only' && argv[i + 1]) {
      opts.only = argv[++i]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (argv[i] === '--extra' && argv[i + 1]) {
      const v = argv[++i];
      const eq = v.indexOf('=');
      // A malformed --extra (no `=`) must BLOCK, not vanish: an unparseable gate spec means the
      // hook intended a gate that will never run — fail closed like every other unexpected shape.
      opts.extra.push(eq > 0 ? { label: v.slice(0, eq), cmd: v.slice(eq + 1) } : { label: v });
    }
  }
  return opts;
}
