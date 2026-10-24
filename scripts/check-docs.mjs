import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Public READMEs and technical guides are paired by language.
// CHANGELOG.md is bilingual in a single versioned file.
const pairs = [
  ["README.md", "README.en.md"],
  ["docs/development/ARCHITECTURE.zh-CN.md", "docs/development/ARCHITECTURE.en.md"],
  ["docs/development/CONTRIBUTING.zh-CN.md", "docs/development/CONTRIBUTING.en.md"],
  ["docs/development/DEPLOYMENT.zh-CN.md", "docs/development/DEPLOYMENT.en.md"],
  ["docs/development/API.zh-CN.md", "docs/development/API.en.md"],
];

const required = [
  "AGENTS.md",
  "CHANGELOG.md",
  "docs/development/RELEASE.md",
  "scripts/release-notes.mjs",
  ".github/workflows/ci.yml",
  ".github/workflows/verify.yml",
  ".github/workflows/deploy.yml",
  ".github/workflows/publish.yml",
];

let failures = 0;

for (const file of required) {
  if (!existsSync(resolve(file))) {
    console.error("Missing engineering file:", file);
    failures += 1;
  }
}

for (const [left, right] of pairs) {
  if (!existsSync(resolve(left)) || !existsSync(resolve(right))) {
    console.error("Missing bilingual documentation pair:", left, right);
    failures += 1;
    continue;
  }
  const levels = (file) =>
    [...readFileSync(resolve(file), "utf8").matchAll(/^(#{1,6})\s+.+$/gm)]
      .map((match) => match[1].length);
  const a = levels(left);
  const b = levels(right);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    console.error("Heading hierarchy differs:", left, right, a, b);
    failures += 1;
  } else {
    console.log("docs pair ok:", left, right);
  }
}

for (const file of ["CHANGELOG.md"]) {
  if (!existsSync(resolve(file))) continue;
  const content = readFileSync(resolve(file), "utf8");
  if (!content.includes("### 简体中文") || !content.includes("### English")) {
    console.error("Missing Chinese/English section:", file);
    failures += 1;
  } else {
    console.log("bilingual release content ok:", file);
  }
}

if (failures) process.exitCode = 1;
