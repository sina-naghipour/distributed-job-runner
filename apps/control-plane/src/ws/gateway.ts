import { WebSocket, WebSocketServer, RawData } from 'ws';
import {
  AgentToControlMessage,
  ControlToAgentMessage,
  JobExecutionRequest,
  Logger,
} from '@djr/shared';
import { MemoryJobStore } from '../store/memory.js';
import { OfflineJobQueue } from '../queue/offline-queue.js';
import { LogStreamBroadcaster } from '../logs/stream-broadcaster.js';
import { LogArtifactManager } from '../logs/artifact-manager.js';

/**
 * AgentGateway coordinates bidirectional WebSocket communication between
 * the Control Plane and remote Agents operating behind NATs/firewalls.
 *
 * Key duties:
 * - Manages agent socket pools indexed by `agentId`.
 * - Handles registration handshakes (`AGENT_HELLO`) and heartbeats (`AGENT_HEARTBEAT`).
 * - Dispatches jobs (`DISPATCH_JOB`) directly over the established socket.
 * - Integrates with `OfflineJobQueue` to auto-dispatch jobs queued while agent was disconnected.
 * - Broadcasts real-time live logs via `LogStreamBroadcaster` (SSE).
 * - Persists durable final log artifacts via `LogArtifactManager`.
 */
export class AgentGateway {
  private activeSockets = new Map<string, WebSocket>();
  private logger = new Logger({ service: 'agent-gateway' });

  /**
   * Initializes the gateway and attaches event listeners to the WebSocketServer.
   *
   * @param wss - WebSocketServer instance mounted on HTTP server path `/ws/agent`
   * @param store - In-memory or database job store
   * @param offlineQueue - Queue managing jobs for offline agents
   * @param broadcaster - Live log stream manager
   * @param artifactManager - Final log persistence manager
   */
  constructor(
    private wss: WebSocketServer,
    private store: MemoryJobStore,
    private offlineQueue: OfflineJobQueue,
    private broadcaster: LogStreamBroadcaster,
    private artifactManager: LogArtifactManager
  ) {
    this.init();
  }

  /**
   * Attaches connection listeners to accept incoming agent reverse connections.
   */
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

  /**
   * Processes typed incoming messages from an agent.
   *
   * @param ws - Active agent WebSocket instance
   * @param msg - AgentToControlMessage union
   * @param currentAgentId - Current registered agent ID for this socket session
   * @returns Updated agentId
   */
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

        // Auto-drain pending jobs queued while this agent was offline
        const queuedJobs = this.offlineQueue.drain(agentId);
        if (queuedJobs.length > 0) {
          this.logger.info(`Auto-dispatching ${queuedJobs.length} queued jobs to reconnected agent ${agentId}`, {
            agentId,
            count: queuedJobs.length,
          });
          for (const req of queuedJobs) {
            this.dispatchJob(req);
          }
        }

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
        // Relay live chunk to all active SSE subscribers
        this.broadcaster.broadcastChunk(msg.payload);
        return currentAgentId;
      }

      case 'JOB_COMPLETED': {
        const { jobId, result } = msg.payload;
        this.logger.info(`Job completed: ${jobId} with exitCode ${result.exitCode}`, {
          jobId,
          exitCode: result.exitCode,
        });
        this.store.updateJobResult(jobId, result);

        // Notify and close live SSE viewers
        this.broadcaster.broadcastComplete(jobId, result.exitCode);

        // Asynchronously persist final log artifact to disk
        const jobRecord = this.store.getJob(jobId);
        if (jobRecord) {
          this.artifactManager.saveFinalLog(jobId, jobRecord.logs).catch((err) => {
            this.logger.error(`Failed to write final log artifact for ${jobId}`, { error: err.message });
          });
        }

        return currentAgentId;
      }

      default:
        return currentAgentId;
    }
  }

  /**
   * Dispatches a job execution request to the targeted agent's WebSocket connection.
   *
   * @param req - Job execution request payload
   * @returns `true` if successfully dispatched over active socket; `false` if agent is offline.
   */
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

  /**
   * Checks whether an agent is currently connected and ready to accept jobs.
   *
   * @param agentId - Unique agent identifier
   */
  isAgentConnected(agentId: string): boolean {
    const ws = this.activeSockets.get(agentId);
    return !!ws && ws.readyState === WebSocket.OPEN;
  }
}
