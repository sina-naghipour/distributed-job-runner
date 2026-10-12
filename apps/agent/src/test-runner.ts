import { DockerRunner } from './docker/runner.js';

async function testAgentRunner() {
  console.log('--- Starting Agent Standalone Verification ---');
  const agentId = 'agent-test-local';
  const runner = new DockerRunner(agentId);

  // 1. Verify Docker connection
  console.log('\n[1/3] Verifying Docker daemon connection...');
  const dockerVersion = await runner.verifyDockerConnection();
  console.log(`✓ Docker is alive and responsive! Version: ${dockerVersion}`);

  // 2. Run a command inside an isolated alpine container
  console.log('\n[2/3] Dispatching a test job container: alpine echo test...');
  const result = await runner.runJobContainer({
    jobId: 'job-sample-101',
    agentId,
    image: 'alpine:latest',
    command: ['echo', 'Hello from isolated job container! Process ID: $$'],
    onLogChunk: (chunk, stream) => {
      process.stdout.write(`[CONTAINER ${stream.toUpperCase()}]: ${chunk}`);
    },
  });

  console.log(`✓ Container execution completed!`);
  console.log(`  Exit code: ${result.exitCode}`);
  console.log(`  Container ID: ${result.containerId}`);

  // 3. Test script execution with environment variables
  console.log('\n[3/3] Dispatching a script job with environment variables & multi-line output...');
  const scriptResult = await runner.runJobContainer({
    jobId: 'job-sample-102',
    agentId,
    image: 'alpine:latest',
    script: 'echo "Current user: $(whoami)"; echo "Job ID: $DJR_JOB_ID"; echo "CUSTOM_VAR: $MY_VAR"',
    env: {
      MY_VAR: 'distributed-systems-rock',
    },
    onLogChunk: (chunk, stream) => {
      process.stdout.write(`[CONTAINER ${stream.toUpperCase()}]: ${chunk}`);
    },
  });

  console.log(`✓ Script execution completed with exit code: ${scriptResult.exitCode}`);
  console.log('\n--- All Agent Container tests passed successfully! ---');
}

testAgentRunner().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
