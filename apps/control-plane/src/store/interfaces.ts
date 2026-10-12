import { JobExecutionRequest, JobResult, JobState, LogChunk } from '@djr/shared';

/**
 * Interface segregation for Job repository.
 */
export interface IJobRepository {
  createJob(req: JobExecutionRequest): JobRecord;
  getJob(jobId: string): JobRecord | undefined;
  findJobByIdempotencyKey(key: string): JobRecord | undefined;
  updateJobState(jobId: string, state: JobState): JobRecord | undefined;
  updateJobResult(jobId: string, result: JobResult): JobRecord | undefined;
  appendLogChunk(logChunk: LogChunk): void;
  listJobs(): JobRecord[];
}

/**
 * Interface segregation for Agent registry.
 */
export interface IAgentRegistry {
  registerAgent(agent: ConnectedAgent): void;
  updateAgentHeartbeat(agentId: string, activeJobCount: number): void;
  removeAgent(agentId: string): void;
  getAgent(agentId: string): ConnectedAgent | undefined;
  listAgents(): ConnectedAgent[];
}

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
