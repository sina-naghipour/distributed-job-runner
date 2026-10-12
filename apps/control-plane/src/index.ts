import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import swaggerUi from 'swagger-ui-express';
import { Logger } from '@djr/shared';
import { MemoryJobStore } from './store/memory.js';
import { AgentGateway } from './ws/gateway.js';
import { OfflineJobQueue } from './queue/offline-queue.js';
import { LogStreamBroadcaster } from './logs/stream-broadcaster.js';
import { LogArtifactManager } from './logs/artifact-manager.js';
import { createJobRouter } from './api/routes.js';
import { swaggerSpec } from './api/openapi.js';

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
const logger = new Logger({ service: 'control-plane' });

const app = express();
app.use(express.json());

// Swagger API Documentation
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws/agent' });

const store = new MemoryJobStore();
const offlineQueue = new OfflineJobQueue((jobId, agentId) => {
  logger.warn(`Job ${jobId} timed out in queue for agent ${agentId}`);
  store.updateJobState(jobId, 'TIMED_OUT');
  store.updateJobResult(jobId, {
    jobId,
    exitCode: 124,
    error: `Job timed out while waiting for agent ${agentId} to come online`,
  });
});

const broadcaster = new LogStreamBroadcaster();
const artifactManager = new LogArtifactManager();

const gateway = new AgentGateway(wss, store, offlineQueue, broadcaster, artifactManager);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Mount Job API
app.use('/api', createJobRouter(store, gateway, offlineQueue, broadcaster, artifactManager));

httpServer.listen(port, () => {
  logger.info(`Control Plane HTTP & WS server listening on port ${port}`);
  logger.info(`REST API available at: http://localhost:${port}/api`);
  logger.info(`Agent Gateway available at: ws://localhost:${port}/ws/agent`);
});

process.on('SIGINT', () => {
  logger.info('Shutting down Control Plane...');
  httpServer.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  logger.info('Shutting down Control Plane...');
  httpServer.close(() => process.exit(0));
});
