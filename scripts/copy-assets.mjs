import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(
  root,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "node_modules",
  "@silvia-odwyer",
  "photon-node",
  "photon_rs_bg.wasm",
);
const output = join(root, "dist", "photon_rs_bg.wasm");

await mkdir(dirname(output), { recursive: true });
await copyFile(source, output);
