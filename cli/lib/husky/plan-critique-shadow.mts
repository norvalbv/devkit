/**
 * Shadow-only commit observation for plan-critique evidence. It never enters reviewer prompts,
 * blocks a commit, or writes into the working tree. Package and self-host runtimes are tried;
 * standalone/global installs without either simply skip.
 */
export const PLAN_CRITIQUE_SHADOW_FRAGMENT = `# devkit:plan-critique-shadow
for __dk_pc in \
  node_modules/@norvalbv/devkit/dist/gate-engine/critique/capture.mjs \
  gate-engine/critique/capture.mts; do
    if [ -f "$__dk_pc" ]; then
        node "$__dk_pc" commit-projection >/dev/null 2>&1 || true
        break
    fi
done
unset __dk_pc
# /devkit:plan-critique-shadow`;
