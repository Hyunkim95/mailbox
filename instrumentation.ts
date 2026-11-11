declare global {
  var mailboxWorkerTimer: ReturnType<typeof setInterval> | undefined;
}
export async function register() {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.MAILBOX_RUN_WORKER !== "1" ||
    globalThis.mailboxWorkerTimer
  )
    return;
  const { appService } = await import("./src/runtime");
  const { merchantRuntime } = await import("./src/merchant-runtime");
  let running = false;
  globalThis.mailboxWorkerTimer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      merchantRuntime().settleDue();
      const service = appService();
      for (const row of service.store.db
        .prepare("SELECT DISTINCT owner FROM wallets")
        .all()) {
        try {
          await service.sync(row.owner as string);
        } catch (error) {
          console.error(
            "Mailbox background retry pending:",
            error instanceof Error ? error.name : "unknown",
          );
        }
      }
    } finally {
      running = false;
    }
  }, 15_000);
  globalThis.mailboxWorkerTimer.unref();
}
