export const swaggerSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Distributed Job Runner (DJR) API',
    version: '1.0.0',
    description:
      'Control Plane REST API for submitting, monitoring, and retrieving results and logs for distributed containerized jobs.',
  },
  servers: [
    {
      url: 'http://localhost:4000/api',
      description: 'Local Development Server',
    },
  ],
  paths: {
    '/jobs': {
      post: {
        summary: 'Submit a new Job',
        description:
          'Asynchronously accepts a job specification. If the target agent is connected, dispatches it immediately; otherwise, leaves it in PENDING state. Returns 202 Accepted with a jobId.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['targetAgentId', 'image'],
                properties: {
                  targetAgentId: {
                    type: 'string',
                    description: 'Unique ID of the agent destined to execute the job',
                    example: 'agent-mvp-01',
                  },
                  image: {
                    type: 'string',
                    description: 'Docker image to use for the isolated worker container',
                    example: 'alpine:latest',
                  },
                  command: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Command arguments to pass to the container',
                    example: ['echo', 'Hello World'],
                  },
                  script: {
                    type: 'string',
                    description: 'Inline shell script executed via /bin/sh -c',
                    example: 'echo "Running task..."; uname -a',
                  },
                  timeoutMs: {
                    type: 'integer',
                    description: 'Execution timeout in milliseconds (default: 60000)',
                    example: 30000,
                  },
                  idempotencyKey: {
                    type: 'string',
                    description: 'Optional client-generated key to prevent duplicate job executions',
                    example: 'req-abc-12345',
                  },
                  env: {
                    type: 'object',
                    additionalProperties: { type: 'string' },
                    description: 'Key-value environment variables injected into the container',
                  },
                  metadata: {
                    type: 'object',
                    description: 'Arbitrary user metadata',
                  },
                },
              },
            },
          },
        },
        responses: {
          '202': {
            description: 'Job accepted for processing',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    jobId: { type: 'string', example: 'job-0d67ba9a' },
                    state: { type: 'string', example: 'DISPATCHED' },
                    targetAgentId: { type: 'string', example: 'agent-mvp-01' },
                    message: { type: 'string', example: 'Dispatched to agent' },
                  },
                },
              },
            },
          },
          '200': {
            description: 'Idempotent replay of a previously submitted job',
          },
          '400': {
            description: 'Invalid input parameters',
          },
        },
      },
      get: {
        summary: 'List all Jobs',
        description: 'Returns an array of all recorded jobs with current states and timestamps.',
        responses: {
          '200': {
            description: 'List of jobs',
          },
        },
      },
    },
    '/jobs/{id}': {
      get: {
        summary: 'Get Job Details & Result',
        description:
          'Retrieves job execution state (PENDING, DISPATCHED, RUNNING, SUCCEEDED, FAILED, TIMED_OUT), timing metrics, and exitCode.',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'The unique jobId',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Job details',
          },
          '404': {
            description: 'Job not found',
          },
        },
      },
    },
    '/jobs/{id}/logs': {
      get: {
        summary: 'Get Job Logs',
        description: 'Returns combined stdout/stderr log output and raw timestamped chunks.',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'The unique jobId',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Combined execution logs',
          },
          '404': {
            description: 'Job not found',
          },
        },
      },
    },
    '/agents': {
      get: {
        summary: 'List Connected Agents',
        description: 'Returns all agents currently connected to the control plane via WebSocket.',
        responses: {
          '200': {
            description: 'List of connected agents',
          },
        },
      },
    },
  },
};
