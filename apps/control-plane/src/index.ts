import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Logger } from '@djr/shared';
import { MemoryJobStore } from './store/memory.js';
import { AgentGateway } from './ws/gateway.js';
import { createJobRouter } from './api/routes.js';

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
const logger = new Logger({ service: 'control-plane' });

const app = express();
app.use(express.json());

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws/agent' });

const store = new MemoryJobStore();
const gateway = new AgentGateway(wss, store);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Mount Job API
app.use('/api', createJobRouter(store, gateway));

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
