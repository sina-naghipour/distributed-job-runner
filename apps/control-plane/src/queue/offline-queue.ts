import { JobExecutionRequest, Logger } from '@djr/shared';

/**
 * QueuedJob wraps a JobExecutionRequest with queue management metadata.
 */
export interface QueuedJob {
  /** Job request specification */
  request: JobExecutionRequest;
  /** ISO timestamp when the job entered the offline queue */
  enqueuedAt: string;
  /** Optional timer reference for expiration while awaiting agent connection */
  timeoutTimer?: NodeJS.Timeout;
}

/**
 * Callback invoked when a queued job exceeds its timeout before the agent connects.
 */
export type JobQueueTimeoutCallback = (jobId: string, agentId: string) => void;

/**
 * OfflineJobQueue buffers jobs submitted for agents that are temporarily disconnected or offline.
 *
 * Guarantees:
 * - Jobs are preserved per agent in FIFO arrival order.
 * - Enforces job execution timeout watchdogs even while awaiting agent arrival.
 * - Provides draining capability (`drain()`) when an agent establishes connection.
 */
export class OfflineJobQueue {
  private queues = new Map<string, QueuedJob[]>(); // agentId -> QueuedJob[]
  private logger = new Logger({ service: 'offline-queue' });

  constructor(private onTimeout?: JobQueueTimeoutCallback) {}

  /**
   * Enqueues a job for an offline agent.
   *
   * Sets up an expiration timer matching `timeoutMs`. If the agent does not connect
   * before `timeoutMs` expires, the job transitions to TIMED_OUT and is removed from the queue.
   *
   * @param req - Job execution request payload
   */
  enqueue(req: JobExecutionRequest): void {
    const { targetAgentId, jobId, timeoutMs = 60000 } = req;
    const agentQueue = this.queues.get(targetAgentId) || [];

    let timeoutTimer: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        this.logger.warn(`Queued job ${jobId} expired before agent ${targetAgentId} came online`, {
          jobId,
          targetAgentId,
        });
        this.removeJob(jobId, targetAgentId);
        this.onTimeout?.(jobId, targetAgentId);
      }, timeoutMs);
    }

    const queuedJob: QueuedJob = {
      request: req,
      enqueuedAt: new Date().toISOString(),
      timeoutTimer,
    };

    agentQueue.push(queuedJob);
    this.queues.set(targetAgentId, agentQueue);

    this.logger.info(`Job ${jobId} buffered in offline queue for Agent ${targetAgentId}. Queue depth: ${agentQueue.length}`, {
      jobId,
      targetAgentId,
      queueDepth: agentQueue.length,
    });
  }

  /**
   * Drains and returns all queued jobs for a given agent in FIFO order upon reconnect.
   *
   * Clears queue timers so that the agent's supervisor can take over execution timeout monitoring.
   *
   * @param agentId - Unique identifier of the newly connected agent
   * @returns Array of JobExecutionRequests to dispatch
   */
  drain(agentId: string): JobExecutionRequest[] {
    const queue = this.queues.get(agentId);
    if (!queue || queue.length === 0) {
      return [];
    }

    this.logger.info(`Draining ${queue.length} pending jobs for reconnected Agent ${agentId}`, {
      agentId,
      count: queue.length,
    });

    const jobsToDispatch: JobExecutionRequest[] = [];
    for (const item of queue) {
      if (item.timeoutTimer) {
        clearTimeout(item.timeoutTimer);
      }
      jobsToDispatch.push(item.request);
    }

    this.queues.delete(agentId);
    return jobsToDispatch;
  }

  /**
   * Removes a specific job from an agent's queue.
   *
   * @param jobId - Unique job identifier
   * @param agentId - Unique agent identifier
   */
  removeJob(jobId: string, agentId: string): boolean {
    const queue = this.queues.get(agentId);
    if (!queue) return false;

    const index = queue.findIndex((j) => j.request.jobId === jobId);
    if (index === -1) return false;

    const [removed] = queue.splice(index, 1);
    if (removed.timeoutTimer) {
      clearTimeout(removed.timeoutTimer);
    }

    if (queue.length === 0) {
      this.queues.delete(agentId);
    }
    return true;
  }

  /**
   * Returns current pending job count for an agent.
   *
   * @param agentId - Target agent identifier
   */
  getQueueLength(agentId: string): number {
    return this.queues.get(agentId)?.length || 0;
  }

  /**
   * Returns queue statistics across all agents.
   */
  getStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const [agentId, queue] of this.queues.entries()) {
      stats[agentId] = queue.length;
    }
    return stats;
  }
}
