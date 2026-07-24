export interface PeriodicTask {
  readonly name: string;
  readonly intervalMs: number;
  run(): Promise<void>;
}

export interface WorkerLoggerPort {
  info(event: string, fields: Readonly<Record<string, string | number>>): void;
  error(event: string, fields: Readonly<Record<string, string | number>>): void;
}

export interface WorkerDelayPort {
  sleep(durationMs: number, signal: AbortSignal): Promise<void>;
}

export const SYSTEM_WORKER_DELAY: WorkerDelayPort = Object.freeze({
  sleep: async (durationMs: number, signal: AbortSignal) => {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, durationMs);
      timeout.unref();
      signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
  },
});

export class PeriodicWorker {
  public constructor(
    private readonly tasks: readonly PeriodicTask[],
    private readonly logger: WorkerLoggerPort,
    private readonly delay: WorkerDelayPort = SYSTEM_WORKER_DELAY,
  ) {
    if (tasks.length === 0) throw new RangeError("periodic worker requires at least one task");
    for (const task of tasks) {
      if (!Number.isSafeInteger(task.intervalMs) || task.intervalMs < 1_000) {
        throw new RangeError(`task ${task.name} interval must be at least one second`);
      }
    }
  }

  public async run(signal: AbortSignal): Promise<void> {
    await Promise.all(this.tasks.map((task) => this.runTask(task, signal)));
  }

  private async runTask(task: PeriodicTask, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const startedAt = Date.now();
      try {
        await task.run();
        this.logger.info("periodic_task_completed", { task: task.name, durationMs: Date.now() - startedAt });
      } catch (error) {
        this.logger.error("periodic_task_failed", {
          task: task.name,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : "unknown error",
        });
      }
      await this.delay.sleep(task.intervalMs, signal);
    }
  }
}
