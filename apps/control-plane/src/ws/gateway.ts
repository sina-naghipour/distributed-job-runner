import { WebSocket, WebSocketServer, RawData } from 'ws';
import {
  AgentToControlMessage,
  ControlToAgentMessage,
  JobExecutionRequest,
  Logger,
} from '@djr/shared';
import { MemoryJobStore } from '../store/memory.js';

export class AgentGateway {
  private activeSockets = new Map<string, WebSocket>();
  private logger = new Logger({ service: 'agent-gateway' });

  constructor(
    private wss: WebSocketServer,
    private store: MemoryJobStore
  ) {
    this.init();
  }

  private init(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      let registeredAgentId: string | null = null;
      this.logger.info('New incoming Agent WebSocket connection');

      ws.on('message', (data: RawData) => {
        try {
          const msg = JSON.parse(data.toString('utf-8')) as AgentToControlMessage;
          registeredAgentId = this.handleAgentMessage(ws, msg, registeredAgentId);
        } catch (err: unknown) {
          const error = err as Error;
          this.logger.error('Failed to parse agent message', { error: error.message });
        }
      });

      ws.on('close', () => {
        if (registeredAgentId) {
          this.logger.warn(`Agent ${registeredAgentId} disconnected`);
          this.activeSockets.delete(registeredAgentId);
          this.store.removeAgent(registeredAgentId);
        }
      });

      ws.on('error', (err) => {
        this.logger.error('Agent socket error', { error: err.message, agentId: registeredAgentId || undefined });
      });
    });
  }

  private handleAgentMessage(
    ws: WebSocket,
    msg: AgentToControlMessage,
    currentAgentId: string | null
  ): string | null {
    switch (msg.type) {
      case 'AGENT_HELLO': {
        const { agentId, version, dockerVersion } = msg.payload;
        this.activeSockets.set(agentId, ws);
        this.store.registerAgent({
          agentId,
          version,
          dockerVersion,
          connectedAt: new Date().toISOString(),
          lastHeartbeatAt: new Date().toISOString(),
          activeJobCount: 0,
        });

        this.logger.info(`Agent registered successfully: ${agentId}`, { agentId, version, dockerVersion });

        const ack: ControlToAgentMessage = {
          type: 'CONTROL_HELLO_ACK',
          payload: {
            agentId,
            heartbeatIntervalMs: 10000,
          },
        };
        ws.send(JSON.stringify(ack));
        return agentId;
      }

      case 'AGENT_HEARTBEAT': {
        const { agentId, activeJobCount } = msg.payload;
        this.store.updateAgentHeartbeat(agentId, activeJobCount);
        return agentId;
      }

      case 'JOB_STATE_UPDATE': {
        const { jobId, state } = msg.payload;
        this.logger.info(`Job state transition: ${jobId} -> ${state}`, { jobId, state });
        this.store.updateJobState(jobId, state);
        return currentAgentId;
      }

      case 'JOB_LOG_CHUNK': {
        this.store.appendLogChunk(msg.payload);
        return currentAgentId;
      }

      case 'JOB_COMPLETED': {
        const { jobId, result } = msg.payload;
        this.logger.info(`Job completed: ${jobId} with exitCode ${result.exitCode}`, {
          jobId,
          exitCode: result.exitCode,
        });
        this.store.updateJobResult(jobId, result);
        return currentAgentId;
      }

      default:
        return currentAgentId;
    }
  }

  dispatchJob(req: JobExecutionRequest): boolean {
    const ws = this.activeSockets.get(req.targetAgentId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(`Cannot dispatch job ${req.jobId}: Agent ${req.targetAgentId} is not connected`, {
        jobId: req.jobId,
        targetAgentId: req.targetAgentId,
      });
      return false;
    }

    const msg: ControlToAgentMessage = {
      type: 'DISPATCH_JOB',
      payload: req,
    };

    ws.send(JSON.stringify(msg));
    this.store.updateJobState(req.jobId, 'DISPATCHED');
    this.logger.info(`Job ${req.jobId} dispatched to Agent ${req.targetAgentId}`, {
      jobId: req.jobId,
      targetAgentId: req.targetAgentId,
    });
    return true;
  }

  isAgentConnected(agentId: string): boolean {
    const ws = this.activeSockets.get(agentId);
    return !!ws && ws.readyState === WebSocket.OPEN;
  }
}
