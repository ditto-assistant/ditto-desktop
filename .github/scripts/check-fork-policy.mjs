import * as NodeFSP from "node:fs/promises";

const forbiddenWorkflows = [
  ".github/workflows/deploy-relay.yml",
  ".github/workflows/mobile-eas-preview.yml",
  ".github/workflows/mobile-eas-production.yml",
  ".github/workflows/release.yml",
  ".github/workflows/web-preview.yml",
];

const requiredWorkflows = [
  ".github/workflows/ci.yml",
  ".github/workflows/desktop-macos-preview.yml",
  ".github/workflows/curated-upstream-sync.yml",
];

const exists = async (path) => {
  try {
    await NodeFSP.access(path);
    return true;
  } catch {
    return false;
  }
};

const violations = [];

for (const path of forbiddenWorkflows) {
  if (await exists(path)) {
    violations.push(`${path} must not exist in the Ditto Desktop fork`);
  }
}

for (const path of requiredWorkflows) {
  if (!(await exists(path))) {
    violations.push(`${path} is required in the Ditto Desktop fork`);
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Ditto Desktop fork workflow policy is satisfied.");
}
