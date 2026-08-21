#!/usr/bin/env node
// Build the publishable npm artifact: one bundled JS entry plus the photon
// wasm it loads from its own directory at runtime.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

run("bun", [
  "build",
  "src/main.ts",
  "--target=node",
  "--outfile=dist/va-agent.js",
  '--banner=#!/usr/bin/env node',
  `--define=__VA_AGENT_VERSION__=${JSON.stringify(version)}`,
]);
run("node", ["scripts/copy-assets.mjs"]);

console.log(`built @vibearound/agent ${version}`);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
