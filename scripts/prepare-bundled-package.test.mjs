import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  materializePublishManifest,
  readWorkspacePackageVersions,
} from "./prepare-bundled-package.mjs";

const serverPackage = {
  name: "@paperclipai/server",
  version: "0.3.1",
  dependencies: {
    "@paperclipai/plugin-sdk": "workspace:*",
    "@paperclipai/shared": "workspace:^",
    express: "^5.0.0",
  },
};

test("workspace references resolve to each dependency's own version", () => {
  const versions = new Map([
    ["@paperclipai/plugin-sdk", "1.0.0"],
    ["@paperclipai/shared", "0.3.1"],
  ]);
  assert.deepEqual(materializePublishManifest(serverPackage, versions).dependencies, {
    "@paperclipai/plugin-sdk": "1.0.0",
    "@paperclipai/shared": "^0.3.1",
    express: "^5.0.0",
  });
});

test("without workspace versions, references keep the release-wide package version", () => {
  assert.equal(
    materializePublishManifest(serverPackage).dependencies["@paperclipai/plugin-sdk"],
    "0.3.1",
  );
});

test("reads workspace versions from the release package manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-workspace-versions-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "packages", "sdk"), { recursive: true });
    writeFileSync(
      join(root, "scripts", "release-package-manifest.json"),
      JSON.stringify([{ dir: "packages/sdk", name: "@paperclipai/plugin-sdk" }]),
    );
    writeFileSync(
      join(root, "packages", "sdk", "package.json"),
      JSON.stringify({ name: "@paperclipai/plugin-sdk", version: "1.0.0" }),
    );
    assert.deepEqual(
      readWorkspacePackageVersions(root),
      new Map([["@paperclipai/plugin-sdk", "1.0.0"]]),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the repository's server package references its workspace dependencies' real versions", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const server = JSON.parse(readFileSync(join(repoRoot, "server", "package.json"), "utf8"));
  const versions = readWorkspacePackageVersions(repoRoot);
  const published = materializePublishManifest(server, versions);
  for (const [name, specifier] of Object.entries(server.dependencies)) {
    if (!specifier.startsWith("workspace:") || !versions.has(name)) continue;
    assert.equal(published.dependencies[name], versions.get(name), name);
  }
});
