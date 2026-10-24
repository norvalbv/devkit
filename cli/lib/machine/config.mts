/** The consumer's `machine` recipe in guard.config.json: how a slot seeds, starts and reaches its app. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CONFIG_FILENAME } from '../../../gate-engine/config.mts';

const argv = z.array(z.string().min(1)).min(1);

const machineSchema = z.strictObject({
  /** light: a headless browser slot on this Mac; full: a desktop computer per agent in a container. */
  mode: z.enum(['light', 'full']).default('light'),
  command: argv.optional(),
  seed: argv.optional(),
  env: z
    .undefined({
      error:
        'guard.config.json may be committed, so it holds no env: set app variables in the argv (["env", "K={data}/x", "next", "dev"]) and keep secrets in your own environment',
    })
    .optional(),
});
export type MachineConfig = z.infer<typeof machineSchema>;

const fileSchema = z.object({ machine: z.unknown().optional() });

/** The recipe at `root`; an absent file or key is an empty recipe, a malformed one throws. */
export function readMachineConfig(root: string): MachineConfig {
  const file = join(root, CONFIG_FILENAME);
  const raw = existsSync(file) ? fileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : {};
  const recipe = machineSchema.safeParse(raw.machine ?? {});
  if (!recipe.success) throw new Error(`${file} "machine": ${z.prettifyError(recipe.error)}`);
  return recipe.data;
}

/** What a recipe value may name about its own slot. */
export interface SlotVars {
  port: number;
  data: string;
  profile: string;
  slot: number;
}

/** `{port}`, `{data}`, `{profile}` and `{slot}` in a recipe value become this slot's own. */
export function expand(value: string, vars: SlotVars): string {
  return value
    .replaceAll('{port}', String(vars.port))
    .replaceAll('{data}', vars.data)
    .replaceAll('{profile}', vars.profile)
    .replaceAll('{slot}', String(vars.slot));
}

/** devkit's names for the slot, which every process in it sees. The recipe has no env of its own:
 * guard.config.json may be committed, so an app's env goes in its argv (`env K=V …`). */
export function slotEnv(vars: SlotVars) {
  return {
    PORT: String(vars.port),
    DEVKIT_MACHINE_SLOT: String(vars.slot),
    DEVKIT_MACHINE_URL: `http://127.0.0.1:${vars.port}`,
    DEVKIT_MACHINE_DATA: vars.data,
    DEVKIT_MACHINE_PROFILE: vars.profile,
  };
}
