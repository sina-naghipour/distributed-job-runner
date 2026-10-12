import 'dotenv/config';
import { AgentSupervisor } from './supervisor/agent.js';

const agentId = process.env.AGENT_ID || `agent-${Math.random().toString(36).substring(2, 7)}`;
const serverWsUrl = process.env.CONTROL_PLANE_WS_URL || 'ws://control-plane:4000/ws/agent';
const heartbeatIntervalMs = process.env.HEARTBEAT_INTERVAL_MS
  ? parseInt(process.env.HEARTBEAT_INTERVAL_MS, 10)
  : 10000;

const supervisor = new AgentSupervisor({
  agentId,
  serverWsUrl,
  heartbeatIntervalMs,
});

async function main() {
  try {
    await supervisor.start();
  } catch (err) {
    console.error('Fatal agent startup error:', err);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  await supervisor.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await supervisor.stop();
  process.exit(0);
});

main();
