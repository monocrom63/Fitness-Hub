import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

const cache = join(process.cwd(), "node_modules", ".cache");
await mkdir(cache, { recursive: true });
const directory = await mkdtemp(join(cache, "bookings-test-"));
try {
  for (const entryPoint of ["course-bookings", "member-link", "member-notifications"]) {
    const output = join(directory, `${entryPoint}.test.cjs`);
    await build({
      entryPoints: [`test/${entryPoint}.test.ts`],
      outfile: output,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "cjs",
    });
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--test", output], { stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    if (exitCode !== 0) process.exitCode = exitCode;
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}