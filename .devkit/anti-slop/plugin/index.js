const activePlugin = (await import("./index.devkit-active.js")).default;
const nativeOnly = process.env.DEVKIT_INTERNAL_ANTI_SLOP_MODE === "native-only";
const plugin = nativeOnly
  ? {
      ...activePlugin,
      rules: Object.fromEntries(
        Object.entries(activePlugin.rules).map(([name, rule]) => [
          name,
          { ...rule, createOnce() { return {}; } },
        ]),
      ),
    }
  : activePlugin;

export default plugin;
