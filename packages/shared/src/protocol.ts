export type JobState =
  | 'PENDING'
  | 'DISPATCHED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'CANCELLED';

export interface JobExecutionRequest {
  jobId: string;
  targetAgentId: string;
  image: string;
  command?: string[];
  script?: string;
  timeoutMs?: number;
  idempotencyKey?: string;
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface JobResult {
  jobId: string;
  exitCode: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface LogChunk {
  jobId: string;
  stream: 'stdout' | 'stderr';
  chunk: string;
  timestamp: string;
  sequence: number;
}

export type AgentToControlMessage =
  | {
      type: 'AGENT_HELLO';
      payload: {
        agentId: string;
        version: string;
        dockerVersion?: string;
        labels?: Record<string, string>;
      };
    }
  | {
      type: 'AGENT_HEARTBEAT';
      payload: {
        agentId: string;
        timestamp: string;
        activeJobCount: number;
      };
    }
  | {
      type: 'JOB_STATE_UPDATE';
      payload: {
        jobId: string;
        agentId: string;
        state: JobState;
        timestamp: string;
        reason?: string;
      };
    }
  | {
      type: 'JOB_LOG_CHUNK';
      payload: LogChunk;
    }
  | {
      type: 'JOB_COMPLETED';
      payload: {
        jobId: string;
        agentId: string;
        result: JobResult;
      };
    };

export type ControlToAgentMessage =
  | {
      type: 'CONTROL_HELLO_ACK';
      payload: {
        agentId: string;
        heartbeatIntervalMs: number;
      };
    }
  | {
      type: 'DISPATCH_JOB';
      payload: JobExecutionRequest;
    }
  | {
      type: 'CANCEL_JOB';
      payload: {
        jobId: string;
        reason?: string;
      };
    };
