import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

const cache = join(process.cwd(), "node_modules", ".cache");
await mkdir(cache, { recursive: true });
const directory = await mkdtemp(join(cache, "pulse-test-"));

try {
  await build({
    entryPoints: ["src/routes/pulse.test.ts", "test/pulse.test.ts"],
    outbase: ".",
    outdir: directory,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
  });

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", join(directory, "src/routes/pulse.test.cjs"), join(directory, "test/pulse.test.cjs")], {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await rm(directory, { recursive: true, force: true });
}