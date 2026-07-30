/**
 * GUARDRAIL — boot every deployable with the real runtime.
 *
 * The lint rules catch the syntax we already know breaks Node's type stripping.
 * This catches the rest: it starts each entrypoint the way Render starts it and
 * waits for a healthy response. Vitest's esbuild is more permissive than Node's
 * stripper, so a green test suite is not evidence that the process starts.
 *
 * Runs in CI after the tests, and it is the last thing worth running locally
 * before a push.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

interface Target {
  name: string;
  entry: string;
  port: number;
  healthPath: string;
}

const TARGETS: Target[] = [
  { name: "api", entry: "apps/api/src/server.ts", port: 4801, healthPath: "/health" },
];

const BOOT_TIMEOUT_MS = 20_000;

let failures = 0;

for (const target of TARGETS) {
  process.stdout.write(`booting ${target.name} … `);

  const child = spawn(process.execPath, ["--experimental-strip-types", target.entry], {
    env: { ...process.env, PORT: String(target.port), LOG_LEVEL: "warn" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr.on("data", (c: Buffer) => (output += c.toString()));

  const started = Date.now();
  let healthy = false;
  let exited: number | null = null;

  child.on("exit", (code) => (exited = code ?? 0));

  while (Date.now() - started < BOOT_TIMEOUT_MS && !healthy && exited === null) {
    await sleep(300);
    try {
      const res = await fetch(`http://127.0.0.1:${target.port}${target.healthPath}`);
      if (res.ok) healthy = true;
    } catch {
      // not listening yet
    }
  }

  child.kill("SIGTERM");
  await sleep(200);
  if (child.exitCode === null) child.kill("SIGKILL");

  if (healthy) {
    console.log(`ok (${Date.now() - started}ms)`);
  } else {
    failures++;
    console.log("FAILED");
    console.error(
      `  ${target.entry} did not become healthy.\n` +
        `  This is the gap Vitest cannot see: esbuild compiles syntax that Node's\n` +
        `  type stripping refuses. Output follows.\n`,
    );
    console.error(
      output
        .split("\n")
        .filter((l) => !l.includes("ExperimentalWarning") && !l.includes("trace-warnings"))
        .slice(0, 25)
        .map((l) => `  │ ${l}`)
        .join("\n"),
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} of ${TARGETS.length} entrypoint(s) failed to boot`);
  process.exit(1);
}

console.log(`all ${TARGETS.length} entrypoint(s) boot cleanly under node --experimental-strip-types`);
