import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

// Native TS loading cannot resolve the mixed workspace package formats.
// Run each suite in its own process so their pool cleanup stays independent.
const cache = join(process.cwd(), "node_modules", ".cache");
await mkdir(cache, { recursive: true });
const directory = await mkdtemp(join(cache, "invitations-test-"));

try {
  await build({
    entryPoints: ["test/member-invitations.test.ts", "test/team-invitations.test.ts"],
    outdir: directory,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
  });
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--test",
      join(directory, "member-invitations.test.cjs"),
      join(directory, "team-invitations.test.cjs"),
    ], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await rm(directory, { recursive: true, force: true });
}
