import { readFileSync } from 'node:fs';

/**
 * The extra gates a repo declares in guard.config.json as `extraGates`, a label-to-command map.
 *
 * @returns {{ label: string, argv: string[] }[]}
 */
export function loadExtraGates(configPath = 'guard.config.json') {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  return Object.entries(config.extraGates ?? {}).map(([label, command]) =>
    typeof command === 'string' && command.trim()
      ? { label, argv: command.trim().split(/\s+/) }
      : { label, argv: [], unrunnable: 'command must be a string' },
  );
}
