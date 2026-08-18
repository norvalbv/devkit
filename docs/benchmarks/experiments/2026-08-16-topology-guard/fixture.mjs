import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const write = (root, relativePath, contents = "") => {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
};

const CONFIG = {
  scanRoots: ["src"],
  sourceExtensions: ["ts", "tsx"],
  structure: {
    trees: [
      {
        name: "topology",
        root: "src",
        sourceExtensions: ["ts", "tsx"],
        ignoredDirs: ["ignored"],
        grammar: {
          files: ["index.ts"],
          recurse: "component",
          rules: {
            component: {
              folderName: "{pascal_dir}",
              enforceExistence: "index.ts",
              files: [
                "index.ts",
                "{pascal_tsx}",
                "{css}",
                "template.html",
                "logo.svg",
                "notes.weird",
              ],
            },
          },
        },
      },
    ],
    walls: [],
  },
};

export const CASES = Object.freeze([
  { id: "clean", expectedViolation: false },
  { id: "placement", expectedViolation: true },
  { id: "required-sibling", expectedViolation: true },
  { id: "naming", expectedViolation: true },
  { id: "css", expectedViolation: true },
  { id: "html", expectedViolation: true },
  { id: "asset", expectedViolation: true },
  { id: "arbitrary-extension", expectedViolation: true },
  { id: "empty-directory", expectedViolation: true },
  { id: "ignored-directory", expectedViolation: false },
  { id: "generated-baseline", expectedViolation: false },
  { id: "permanent-exemption", expectedViolation: false },
]);

function addCase(root, caseId) {
  switch (caseId) {
    case "clean":
      return;
    case "placement":
      write(root, "src/loose.ts", "export const loose = true;\n");
      return;
    case "required-sibling":
      write(root, "src/Missing/Missing.tsx", "export const Missing = () => null;\n");
      return;
    case "naming":
      write(root, "src/bad-name/index.ts", "export {};\n");
      return;
    case "css":
      write(root, "src/global.css", ":root { color: red; }\n");
      return;
    case "html":
      write(root, "src/index.html", "<main>fixture</main>\n");
      return;
    case "asset":
      write(root, "src/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
      return;
    case "arbitrary-extension":
      write(root, "src/blob.unregistered", "fixture\n");
      return;
    case "empty-directory":
      mkdirSync(join(root, "src", "empty-directory"), { recursive: true });
      return;
    case "ignored-directory":
      write(root, "src/ignored/not-valid.ts", "export const ignored = true;\n");
      return;
    case "generated-baseline":
      write(root, "src/legacy.ts", "export const legacy = true;\n");
      return;
    case "permanent-exemption":
      write(root, "src/permanent.ts", "export const permanent = true;\n");
      return;
    default:
      throw new Error(`unknown fixture case: ${caseId}`);
  }
}

export function createFixture(root, { caseId = "clean", componentCount = 80 } = {}) {
  write(root, "guard.config.json", `${JSON.stringify(CONFIG, null, 2)}\n`);
  write(
    root,
    "eslint/baselines/topology.mjs",
    `export const topologyStructureBaseline = ${
      caseId === "generated-baseline" ? '["legacy.ts"]' : "[]"
    };\n`,
  );
  write(
    root,
    "eslint/baselines/exempt.mjs",
    `export const structureExempt = { topology: ${
      caseId === "permanent-exemption" ? '["permanent.ts"]' : "[]"
    } };\n`,
  );
  write(root, "src/index.ts", "export {};\n");

  for (let index = 0; index < componentCount; index += 1) {
    const name = `Component${String(index).padStart(3, "0")}`;
    write(root, `src/${name}/index.ts`, "export {};\n");
    write(root, `src/${name}/${name}.tsx`, `export const ${name} = () => null;\n`);
    write(root, `src/${name}/styles.css`, `.${name} {}\n`);
    write(root, `src/${name}/template.html`, `<div class="${name}"></div>\n`);
    write(root, `src/${name}/logo.svg`, '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
    write(root, `src/${name}/notes.weird`, "arbitrary extension fixture\n");
  }

  addCase(root, caseId);
}
