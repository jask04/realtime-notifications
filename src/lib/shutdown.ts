import { logger } from './logger.js';

export interface Shutdownable {
  /** Human label used in logs — e.g. "http", "workers", "redis". */
  name: string;
  /** Cleanup function. Should resolve once the resource is fully closed. */
  close: () => Promise<void>;
}

export interface ShutdownOptions {
  /**
   * Hard ceiling on how long shutdown is allowed to take. After this elapses
   * we exit non-zero so a stuck close (a hung DB connection, a deadlocked
   * worker) doesn't keep a pod alive forever and block a redeploy. Default
   * 30s — long enough for in-flight HTTP requests and BullMQ jobs to drain,
   * short enough that an orchestrator like Kubernetes won't SIGKILL us first.
   */
  timeoutMs?: number;
}

/**
 * Close every target in order. Errors are logged and swallowed so a single
 * misbehaving close doesn't skip downstream cleanup.
 *
 * Returns the names of any targets whose close threw, so callers (or tests)
 * can detect partial failures without parsing logs.
 */
export async function closeAllInOrder(
  targets: Shutdownable[],
): Promise<string[]> {
  const failed: string[] = [];
  for (const target of targets) {
    try {
      logger.info({ target: target.name }, 'closing');
      await target.close();
    } catch (err) {
      // Keep going — closing redis shouldn't be skipped because closing
      // the queue threw. The process is exiting either way.
      logger.error({ err, target: target.name }, 'close failed');
      failed.push(target.name);
    }
  }
  return failed;
}

/**
 * Install SIGTERM/SIGINT handlers that close the given resources in order,
 * then `process.exit`. Targets close sequentially, not in parallel — order
 * matters: stop accepting new traffic before draining workers, drain
 * workers before closing the queue connection, and so on.
 *
 * Also wires `uncaughtException` and `unhandledRejection` handlers. These
 * are bugs by definition (some promise was rejected that no one was
 * listening to) — log as much context as we can and crash. Letting the
 * process keep running in an undefined state is worse than restarting.
 */
export function installGracefulShutdown(
  targets: Shutdownable[],
  options: ShutdownOptions = {},
): void {
  const timeoutMs = options.timeoutMs ?? 30_000;
  let shuttingDown = false;

  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      logger.warn({ signal }, 'shutdown already in progress, ignoring signal');
      return;
    }
    shuttingDown = true;

    logger.info({ signal, timeoutMs }, 'shutdown initiated');
    const forceExit = setTimeout(() => {
      logger.error(
        { timeoutMs },
        'shutdown exceeded timeout, forcing exit',
      );
      process.exit(1);
    }, timeoutMs);
    // unref so the timer alone doesn't keep the event loop alive while
    // the close calls themselves work through the loop.
    forceExit.unref();

    await closeAllInOrder(targets);

    clearTimeout(forceExit);
    logger.info('shutdown complete');
    process.exit(exitCode);
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection');
    void shutdown('unhandledRejection', 1);
  });
}
