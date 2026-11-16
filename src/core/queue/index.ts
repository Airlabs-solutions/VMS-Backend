import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";

export interface QueueJob<T = Record<string, unknown>> {
  id: string;
  name: string;
  data: T;
  attempts: number;
  maxRetries: number;
  createdAt: number;
}

export type QueueHandler<T = Record<string, unknown>> = (job: QueueJob<T>) => Promise<void>;

interface QueueOptions {
  concurrency?: number;
  maxRetries?: number;
}

class QueueEngine extends EventEmitter {
  private readonly queues = new Map<string, Array<QueueJob<any>>>();
  private readonly handlers = new Map<string, QueueHandler<any>>();
  private readonly running = new Map<string, number>();
  private readonly options = new Map<string, QueueOptions>();
  private isDraining = false;

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  registerHandler<T = Record<string, unknown>>(queueName: string, handler: QueueHandler<T>, options?: QueueOptions) {
    this.handlers.set(queueName, handler);
    this.options.set(queueName, {
      concurrency: options?.concurrency ?? env.QUEUE_CONCURRENCY,
      maxRetries: options?.maxRetries ?? 3,
    });
    if (!this.queues.has(queueName)) {
      this.queues.set(queueName, []);
      this.running.set(queueName, 0);
    }
  }

  async add<T = Record<string, unknown>>(queueName: string, name: string, data: T, maxRetries = 3): Promise<string> {
    if (this.isDraining) {
      logger.warn({ queueName, name }, "Queue is draining, rejected job submission");
      throw new Error("Queue is draining");
    }

    if (!this.queues.has(queueName)) {
      this.queues.set(queueName, []);
      this.running.set(queueName, 0);
    }

    const job: QueueJob<T> = {
      id: `${queueName}-${randomUUID()}`,
      name,
      data,
      attempts: 0,
      maxRetries,
      createdAt: Date.now(),
    };

    this.queues.get(queueName)!.push(job);
    setImmediate(() => this.processNext(queueName));
    return job.id;
  }

  private async processNext(queueName: string) {
    if (this.isDraining) return;

    const queue = this.queues.get(queueName);
    const handler = this.handlers.get(queueName);
    if (!queue || !handler || queue.length === 0) return;

    const currentRunning = this.running.get(queueName) ?? 0;
    const concurrency = this.options.get(queueName)?.concurrency ?? env.QUEUE_CONCURRENCY;

    if (currentRunning >= concurrency) return;

    const job = queue.shift();
    if (!job) return;

    this.running.set(queueName, currentRunning + 1);

    (async () => {
      try {
        job.attempts += 1;
        await handler(job);
        this.emit("completed", { queueName, jobId: job.id, name: job.name });
      } catch (error) {
        logger.error(
          {
            queueName,
            jobId: job.id,
            name: job.name,
            attempt: job.attempts,
            error: error instanceof Error ? error.message : "Unknown error",
          },
          "Queue job execution failed",
        );

        if (job.attempts < job.maxRetries) {
          const delay = Math.pow(2, job.attempts) * 1000;
          setTimeout(() => {
            queue.push(job);
            this.processNext(queueName);
          }, delay);
        } else {
          this.emit("failed", { queueName, jobId: job.id, name: job.name, error });
        }
      } finally {
        const remaining = (this.running.get(queueName) ?? 1) - 1;
        this.running.set(queueName, Math.max(0, remaining));
        setImmediate(() => this.processNext(queueName));
      }
    })();
  }

  async drain(timeoutMs = 15000): Promise<void> {
    this.isDraining = true;
    logger.info("Draining queue processing...");

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      let activeCount = 0;
      for (const count of this.running.values()) {
        activeCount += count;
      }
      if (activeCount === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  getStats(): Record<string, { waiting: number; running: number }> {
    const stats: Record<string, { waiting: number; running: number }> = {};
    for (const [name, queue] of this.queues.entries()) {
      stats[name] = {
        waiting: queue.length,
        running: this.running.get(name) ?? 0,
      };
    }
    return stats;
  }
}

export const queueService = new QueueEngine();
