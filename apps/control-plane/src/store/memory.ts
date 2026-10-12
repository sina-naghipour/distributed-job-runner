import { JobExecutionRequest, JobResult, JobState, LogChunk } from '@djr/shared';

/**
 * Internal record stored in memory representing a Job and its lifecycle.
 */
export interface JobRecord {
  /** The original execution request submitted by the client */
  request: JobExecutionRequest;
  /** Current state of the job within the state machine */
  state: JobState;
  /** Final execution result (exit code, duration, timestamps) once completed */
  result?: JobResult;
  /** Ordered list of stdout and stderr log chunks received from the agent */
  logs: LogChunk[];
  /** ISO timestamp when the job was accepted */
  createdAt: string;
  /** ISO timestamp when the job state was last modified */
  updatedAt: string;
}

/**
 * Metadata tracked for each connected Agent instance.
 */
export interface ConnectedAgent {
  /** Unique agent ID */
  agentId: string;
  /** Agent software version */
  version: string;
  /** Docker daemon version reported by the agent */
  dockerVersion?: string;
  /** ISO timestamp of connection establishment */
  connectedAt: string;
  /** ISO timestamp of the last received heartbeat ping */
  lastHeartbeatAt: string;
  /** Number of active containers concurrently executing on this agent */
  activeJobCount: number;
}

/**
 * MemoryJobStore manages the in-memory state of jobs, agent registrations, and idempotency mappings.
 *
 * (Designed to be swapped with PostgreSQL or Redis in subsequent stages).
 */
export class MemoryJobStore {
  private jobs = new Map<string, JobRecord>();
  private idempotencyMap = new Map<string, string>(); // idempotencyKey -> jobId
  private agents = new Map<string, ConnectedAgent>();

  /**
   * Creates and registers a new Job in `PENDING` state.
   *
   * @param req - Job execution request payload
   * @returns Newly created JobRecord
   */
  createJob(req: JobExecutionRequest): JobRecord {
    const now = new Date().toISOString();
    const record: JobRecord = {
      request: req,
      state: 'PENDING',
      logs: [],
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(req.jobId, record);
    if (req.idempotencyKey) {
      this.idempotencyMap.set(req.idempotencyKey, req.jobId);
    }
    return record;
  }

  /**
   * Retrieves a job record by its unique identifier.
   *
   * @param jobId - Unique job ID
   */
  getJob(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Looks up a previously processed job using an idempotency key.
   *
   * @param key - Client-provided idempotency key
   */
  findJobByIdempotencyKey(key: string): JobRecord | undefined {
    const jobId = this.idempotencyMap.get(key);
    if (!jobId) return undefined;
    return this.jobs.get(jobId);
  }

  /**
   * Updates the state machine state of an existing job.
   *
   * @param jobId - Unique job ID
   * @param state - New JobState (e.g., 'DISPATCHED', 'RUNNING', 'SUCCEEDED')
   */
  updateJobState(jobId: string, state: JobState): JobRecord | undefined {
    const record = this.jobs.get(jobId);
    if (!record) return undefined;
    record.state = state;
    record.updatedAt = new Date().toISOString();
    return record;
  }

  /**
   * Attaches final execution results to a job.
   *
   * @param jobId - Unique job ID
   * @param result - Summary metrics (exitCode, durationMs, errors)
   */
  updateJobResult(jobId: string, result: JobResult): JobRecord | undefined {
    const record = this.jobs.get(jobId);
    if (!record) return undefined;
    record.result = result;
    record.updatedAt = new Date().toISOString();
    return record;
  }

  /**
   * Appends an incoming log chunk to a job's log history.
   *
   * @param logChunk - Stream chunk with sequence number and timestamp
   */
  appendLogChunk(logChunk: LogChunk): void {
    const record = this.jobs.get(logChunk.jobId);
    if (record) {
      record.logs.push(logChunk);
    }
  }

  /**
   * Returns all jobs sorted by creation date descending.
   */
  listJobs(): JobRecord[] {
    return Array.from(this.jobs.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  /**
   * Registers a newly connected agent or updates its connection record.
   *
   * @param agent - ConnectedAgent metadata
   */
  registerAgent(agent: ConnectedAgent): void {
    this.agents.set(agent.agentId, agent);
  }

  /**
   * Updates an agent's heartbeat timestamp and active job count.
   *
   * @param agentId - Unique agent identifier
   * @param activeJobCount - Current number of running containers on the agent
   */
  updateAgentHeartbeat(agentId: string, activeJobCount: number): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.lastHeartbeatAt = new Date().toISOString();
      agent.activeJobCount = activeJobCount;
    }
  }

  /**
   * Removes an agent from active tracking upon disconnect.
   *
   * @param agentId - Unique agent identifier
   */
  removeAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  /**
   * Retrieves an agent record by ID.
   *
   * @param agentId - Unique agent identifier
   */
  getAgent(agentId: string): ConnectedAgent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Returns an array of all currently active agents.
   */
  listAgents(): ConnectedAgent[] {
    return Array.from(this.agents.values());
  }
}
