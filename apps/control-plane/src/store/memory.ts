import { JobExecutionRequest, JobResult, JobState, LogChunk } from '@djr/shared';

export interface JobRecord {
  request: JobExecutionRequest;
  state: JobState;
  result?: JobResult;
  logs: LogChunk[];
  createdAt: string;
  updatedAt: string;
}

export interface ConnectedAgent {
  agentId: string;
  version: string;
  dockerVersion?: string;
  connectedAt: string;
  lastHeartbeatAt: string;
  activeJobCount: number;
}

export class MemoryJobStore {
  private jobs = new Map<string, JobRecord>();
  private idempotencyMap = new Map<string, string>(); // idempotencyKey -> jobId
  private agents = new Map<string, ConnectedAgent>();

  // Jobs
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

  getJob(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  findJobByIdempotencyKey(key: string): JobRecord | undefined {
    const jobId = this.idempotencyMap.get(key);
    if (!jobId) return undefined;
    return this.jobs.get(jobId);
  }

  updateJobState(jobId: string, state: JobState): JobRecord | undefined {
    const record = this.jobs.get(jobId);
    if (!record) return undefined;
    record.state = state;
    record.updatedAt = new Date().toISOString();
    return record;
  }

  updateJobResult(jobId: string, result: JobResult): JobRecord | undefined {
    const record = this.jobs.get(jobId);
    if (!record) return undefined;
    record.result = result;
    record.updatedAt = new Date().toISOString();
    return record;
  }

  appendLogChunk(logChunk: LogChunk): void {
    const record = this.jobs.get(logChunk.jobId);
    if (record) {
      record.logs.push(logChunk);
    }
  }

  listJobs(): JobRecord[] {
    return Array.from(this.jobs.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  // Agents
  registerAgent(agent: ConnectedAgent): void {
    this.agents.set(agent.agentId, agent);
  }

  updateAgentHeartbeat(agentId: string, activeJobCount: number): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.lastHeartbeatAt = new Date().toISOString();
      agent.activeJobCount = activeJobCount;
    }
  }

  removeAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  getAgent(agentId: string): ConnectedAgent | undefined {
    return this.agents.get(agentId);
  }

  listAgents(): ConnectedAgent[] {
    return Array.from(this.agents.values());
  }
}
