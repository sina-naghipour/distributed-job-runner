import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { JobExecutionRequest, Logger } from '@djr/shared';
import { MemoryJobStore } from '../store/memory.js';
import { AgentGateway } from '../ws/gateway.js';
import { OfflineJobQueue } from '../queue/offline-queue.js';
import { LogStreamBroadcaster } from '../logs/stream-broadcaster.js';
import { LogArtifactManager } from '../logs/artifact-manager.js';

/**
 * Creates and configures the Express router for Job and Agent management.
 *
 * Endpoints:
 * - `POST /jobs`          : Submit a new asynchronous job (idempotent if idempotencyKey supplied).
 * - `GET  /jobs/:id`      : Retrieve job status, state machine phase, and exit results.
 * - `GET  /jobs/:id/logs` : Retrieve captured stdout/stderr log stream (from memory or durable artifact).
 * - `GET  /jobs/:id/logs/stream` : Live Server-Sent Events (SSE) log stream for real-time observation.
 * - `GET  /jobs`          : List all jobs.
 * - `GET  /agents`        : List all connected agents and heartbeat statistics.
 * - `GET  /queue`         : View offline queues per agent.
 *
 * @param store - Job storage instance
 * @param gateway - Agent communication gateway
 * @param queue - Offline job queue
 * @param broadcaster - Live log stream manager
 * @param artifactManager - Final log artifact manager
 */
export function createJobRouter(
  store: MemoryJobStore,
  gateway: AgentGateway,
  queue: OfflineJobQueue,
  broadcaster: LogStreamBroadcaster,
  artifactManager: LogArtifactManager
): Router {
  const router = Router();
  const logger = new Logger({ service: 'job-api' });

  // 1. Submit a Job
  router.post('/jobs', (req, res) => {
    const {
      targetAgentId,
      image,
      command,
      script,
      timeoutMs,
      idempotencyKey,
      env,
      metadata,
    } = req.body;

    if (!targetAgentId || !image) {
      return res.status(400).json({
        error: 'targetAgentId and image are required fields',
      });
    }

    if (!command && !script) {
      return res.status(400).json({
        error: 'Either command (array) or script (string) must be provided',
      });
    }

    // Check idempotencyKey to prevent duplicate work
    if (idempotencyKey) {
      const existing = store.findJobByIdempotencyKey(idempotencyKey);
      if (existing) {
        logger.info(`Idempotent request returning existing Job ${existing.request.jobId}`, {
          jobId: existing.request.jobId,
          idempotencyKey,
        });
        return res.status(200).json({
          jobId: existing.request.jobId,
          state: existing.state,
          idempotentReplay: true,
        });
      }
    }

    const jobId = `job-${uuidv4().substring(0, 8)}`;
    const jobRequest: JobExecutionRequest = {
      jobId,
      targetAgentId,
      image,
      command,
      script,
      timeoutMs: timeoutMs || 60000,
      idempotencyKey,
      env,
      metadata,
    };

    const record = store.createJob(jobRequest);
    logger.info(`Job ${jobId} accepted`, { jobId, targetAgentId, image });

    // Attempt immediate dispatch if agent is connected
    const dispatched = gateway.dispatchJob(jobRequest);
    if (!dispatched) {
      logger.warn(`Agent ${targetAgentId} is offline. Buffering Job ${jobId} in OfflineJobQueue`, {
        jobId,
        targetAgentId,
      });
      queue.enqueue(jobRequest);
    }

    // Asynchronous acceptance: return 202 Accepted with jobId immediately
    return res.status(202).json({
      jobId,
      state: store.getJob(jobId)?.state || record.state,
      targetAgentId,
      message: dispatched
        ? 'Dispatched to agent'
        : `Agent ${targetAgentId} is currently offline. Job queued and will execute automatically upon reconnect.`,
    });
  });

  // 2. Get Job Status & Result
  router.get('/jobs/:id', (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: `Job ${req.params.id} not found` });
    }
    return res.json({
      jobId: job.request.jobId,
      state: job.state,
      targetAgentId: job.request.targetAgentId,
      image: job.request.image,
      result: job.result || null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  });

  // 3. Get Job Logs (checks memory store and durable file artifact fallback)
  router.get('/jobs/:id/logs', async (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) {
      // Check if preserved on disk as a final artifact
      const artifact = await artifactManager.readFinalLog(req.params.id);
      if (artifact !== null) {
        return res.json({
          jobId: req.params.id,
          source: 'artifact',
          logs: artifact,
        });
      }
      return res.status(404).json({ error: `Job ${req.params.id} not found` });
    }

    const fullLog = job.logs
      .sort((a, b) => a.sequence - b.sequence)
      .map((l) => l.chunk)
      .join('');

    return res.json({
      jobId: job.request.jobId,
      state: job.state,
      logCount: job.logs.length,
      logs: fullLog,
      rawChunks: job.logs,
    });
  });

  // 3b. Live SSE Log Stream
  router.get('/jobs/:id/logs/stream', (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: `Job ${req.params.id} not found` });
    }

    broadcaster.subscribe(req.params.id, res, job.logs);
  });

  // 4. List all Jobs
  router.get('/jobs', (_req, res) => {
    const jobs = store.listJobs().map((j) => ({
      jobId: j.request.jobId,
      state: j.state,
      targetAgentId: j.request.targetAgentId,
      image: j.request.image,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
    }));
    return res.json({ jobs });
  });

  // 5. List Connected Agents
  router.get('/agents', (_req, res) => {
    return res.json({ agents: store.listAgents() });
  });

  // 6. View Offline Queue Status
  router.get('/queue', (_req, res) => {
    return res.json({ queues: queue.getStats() });
  });

  return router;
}
