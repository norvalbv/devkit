import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function runImportWallFixture(cwd) {
  cwd = realpathSync(cwd);
  const require = createRequire(join(cwd, "package.json"));
  const [{ ESLint }, { createIndependentModules, projectStructurePlugin }] = await Promise.all([
    import(pathToFileURL(require.resolve("eslint")).href),
    import(pathToFileURL(require.resolve("eslint-plugin-project-structure")).href),
  ]);
  const eslint = new ESLint({
    cwd,
    overrideConfigFile: true,
    baseConfig: [
      {
        files: ["src/**/*.js"],
        plugins: { "project-structure": projectStructurePlugin },
        rules: {
          "project-structure/independent-modules": [
            "error",
            createIndependentModules({
              debugMode: true,
              modules: [
                {
                  name: "feature-a",
                  pattern: "src/feature-a/**",
                  allowImportsFrom: ["src/feature-a/**"],
                },
                {
                  name: "feature-b",
                  pattern: "src/feature-b/**",
                  allowImportsFrom: ["src/feature-b/**"],
                },
              ],
            }),
          ],
        },
      },
    ],
  });
  const results = await eslint.lintFiles(["src"]);
  const diagnostics = results.flatMap((result) =>
    result.messages
      .filter((message) => message.ruleId === "project-structure/independent-modules")
      .map((message) => ({ filePath: result.filePath, message: message.message })),
  );
  return { code: diagnostics.length > 0 ? 1 : 0, diagnostics };
}
