import { readFileSync } from 'node:fs';

/**
 * The extra gates a repo declares in guard.config.json as `extraGates`, a label-to-command map.
 *
 * @returns {{ label: string, argv: string[] }[]}
 */
export function loadExtraGates(configPath = 'guard.config.json') {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  return Object.entries(config.extraGates ?? {})
    .filter(([, command]) => typeof command === 'string')
    .map(([label, command]) => ({ label, argv: command.split(/\s+/) }));
}
