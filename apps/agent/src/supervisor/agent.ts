import WebSocket from 'ws';
import {
  AgentToControlMessage,
  ControlToAgentMessage,
  JobExecutionRequest,
  JobResult,
  Logger,
} from '@djr/shared';
import { DockerRunner } from '../docker/runner.js';

export interface AgentConfig {
  agentId: string;
  serverWsUrl: string;
  heartbeatIntervalMs?: number;
}

export class AgentSupervisor {
  private ws: WebSocket | null = null;
  private logger: Logger;
  private dockerRunner: DockerRunner;
  private isRunning = false;
  private activeJobs = new Map<string, Promise<void>>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sequenceCounter = 0;

  constructor(private config: AgentConfig) {
    this.logger = new Logger({ agentId: config.agentId, service: 'agent-supervisor' });
    this.dockerRunner = new DockerRunner(config.agentId);
  }

  async start(): Promise<void> {
    this.isRunning = true;
    this.logger.info(`Starting Agent supervisor [${this.config.agentId}]...`);

    const dockerVersion = await this.dockerRunner.verifyDockerConnection();
    this.logger.info(`Verified Docker Engine version: ${dockerVersion}`);

    this.connect();
  }

  private connect(): void {
    if (!this.isRunning) return;

    this.logger.info(`Connecting outbound to Control Plane at ${this.config.serverWsUrl}...`);
    this.ws = new WebSocket(this.config.serverWsUrl);

    this.ws.on('open', () => {
      this.logger.info('Connected to Control Plane Gateway via WebSocket');
      this.sendHello();
      this.startHeartbeat();
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString('utf-8')) as ControlToAgentMessage;
        this.handleServerMessage(msg);
      } catch (err: unknown) {
        const error = err as Error;
        this.logger.error('Failed to parse message from control plane', { error: error.message });
      }
    });

    this.ws.on('close', (code, reason) => {
      this.logger.warn(`Disconnected from Control Plane (code: ${code}, reason: ${reason.toString()}). Reconnecting in 3s...`);
      this.stopHeartbeat();
      if (this.isRunning) {
        setTimeout(() => this.connect(), 3000);
      }
    });

    this.ws.on('error', (err) => {
      this.logger.error('WebSocket connection error', { error: err.message });
    });
  }

  private sendMessage(msg: AgentToControlMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.logger.warn('Cannot send message, WebSocket not connected', { msgType: msg.type });
    }
  }

  private sendHello(): void {
    this.sendMessage({
      type: 'AGENT_HELLO',
      payload: {
        agentId: this.config.agentId,
        version: '1.0.0',
      },
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.config.heartbeatIntervalMs || 10000;
    this.heartbeatTimer = setInterval(() => {
      this.sendMessage({
        type: 'AGENT_HEARTBEAT',
        payload: {
          agentId: this.config.agentId,
          timestamp: new Date().toISOString(),
          activeJobCount: this.activeJobs.size,
        },
      });
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async handleServerMessage(msg: ControlToAgentMessage): Promise<void> {
    switch (msg.type) {
      case 'CONTROL_HELLO_ACK':
        this.logger.info('Control Plane acknowledged registration', msg.payload);
        break;

      case 'DISPATCH_JOB':
        this.logger.info(`Received Job Dispatch request for Job ${msg.payload.jobId}`, {
          jobId: msg.payload.jobId,
          image: msg.payload.image,
        });
        this.executeJob(msg.payload);
        break;

      case 'CANCEL_JOB':
        this.logger.warn(`Received cancellation request for Job ${msg.payload.jobId}`, {
          jobId: msg.payload.jobId,
        });
        // Stage 4 will expand container interruption
        break;

      default:
        this.logger.warn('Unknown message type received', { msg });
    }
  }

  private async executeJob(req: JobExecutionRequest): Promise<void> {
    const { jobId } = req;
    const startedAt = new Date().toISOString();

    // Notify state transition: RUNNING
    this.sendMessage({
      type: 'JOB_STATE_UPDATE',
      payload: {
        jobId,
        agentId: this.config.agentId,
        state: 'RUNNING',
        timestamp: startedAt,
      },
    });

    const jobPromise = (async () => {
      try {
        const result = await this.dockerRunner.runJobContainer({
          jobId,
          agentId: this.config.agentId,
          image: req.image,
          command: req.command,
          script: req.script,
          env: req.env,
          timeoutMs: req.timeoutMs,
          onLogChunk: (chunk, stream) => {
            this.sequenceCounter++;
            this.sendMessage({
              type: 'JOB_LOG_CHUNK',
              payload: {
                jobId,
                stream,
                chunk,
                timestamp: new Date().toISOString(),
                sequence: this.sequenceCounter,
              },
            });
          },
        });

        const completedAt = new Date().toISOString();
        const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

        const isSuccess = result.exitCode === 0 && !result.timedOut;
        const finalState = result.timedOut ? 'TIMED_OUT' : isSuccess ? 'SUCCEEDED' : 'FAILED';

        // Notify final state transition
        this.sendMessage({
          type: 'JOB_STATE_UPDATE',
          payload: {
            jobId,
            agentId: this.config.agentId,
            state: finalState,
            timestamp: completedAt,
            reason: result.error,
          },
        });

        // Send execution summary result
        const jobResult: JobResult = {
          jobId,
          exitCode: result.exitCode,
          error: result.error,
          startedAt,
          completedAt,
          durationMs,
        };

        this.sendMessage({
          type: 'JOB_COMPLETED',
          payload: {
            jobId,
            agentId: this.config.agentId,
            result: jobResult,
          },
        });
      } catch (err: unknown) {
        const error = err as Error;
        const completedAt = new Date().toISOString();
        this.sendMessage({
          type: 'JOB_STATE_UPDATE',
          payload: {
            jobId,
            agentId: this.config.agentId,
            state: 'FAILED',
            timestamp: completedAt,
            reason: error.message,
          },
        });

        this.sendMessage({
          type: 'JOB_COMPLETED',
          payload: {
            jobId,
            agentId: this.config.agentId,
            result: {
              jobId,
              exitCode: 1,
              error: error.message,
              startedAt,
              completedAt,
            },
          },
        });
      } finally {
        this.activeJobs.delete(jobId);
      }
    })();

    this.activeJobs.set(jobId, jobPromise);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
    }
  }
}
