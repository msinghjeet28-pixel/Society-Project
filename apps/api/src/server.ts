import { buildApp } from "./app.ts";
import { closePool } from "./db.ts";

const app = await buildApp();

// Render provides PORT and expects the service to bind 0.0.0.0.
const port = Number(process.env["PORT"] ?? 3000);

try {
  await app.listen({ port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void (async () => {
      app.log.info({ signal }, "shutting down");
      await app.close();
      await closePool();
      process.exit(0);
    })();
  });
}
