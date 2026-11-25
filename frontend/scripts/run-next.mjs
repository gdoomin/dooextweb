import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Start Next from the physical directory when Windows Documents is a junction.
const root = fs.realpathSync.native(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => { process.exitCode = code ?? 1; });
