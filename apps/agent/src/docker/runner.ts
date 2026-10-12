import Docker from 'dockerode';
import { Logger } from '@djr/shared';
import { Writable } from 'node:stream';

/**
 * Configuration options required to execute a job inside an isolated container.
 */
export interface RunContainerOptions {
  /** Unique identifier for the job being run */
  jobId: string;
  /** Unique identifier of the agent managing this execution */
  agentId: string;
  /** Name/tag of the Docker image (e.g., 'alpine:latest', 'python:3.11-slim') */
  image: string;
  /** Explicit array of command arguments passed to Docker Cmd */
  command?: string[];
  /** Shell script string executed inside container via `/bin/sh -c` */
  script?: string;
  /** Key-value environment variables passed into the container */
  env?: Record<string, string>;
  /** Maximum execution duration in milliseconds before forcing a container kill */
  timeoutMs?: number;
  /** Optional callback invoked whenever new stdout/stderr log data arrives */
  onLogChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

/**
 * Execution summary returned after container termination.
 */
export interface ContainerExecutionResult {
  /** The process exit code (0 for success, non-zero for errors, 124 for timeout) */
  exitCode: number;
  /** Error message if an execution failure or timeout occurred */
  error?: string;
  /** Flag indicating whether the process was stopped due to timeout expiration */
  timedOut?: boolean;
  /** Docker container identifier */
  containerId: string;
}

/**
 * DockerRunner is responsible for the direct lifecycle management of worker containers.
 *
 * It uses Docker-outside-of-Docker (DooD) via the host's `/var/run/docker.sock` to:
 * 1. Pull necessary container images.
 * 2. Create isolated sibling containers with safety resource bounds.
 * 3. Attach multiplexed stdout/stderr streams and demux them in real-time.
 * 4. Monitor execution against timeout limits.
 * 5. Clean up containers post-execution to prevent container leakage.
 */
export class DockerRunner {
  private docker: Docker;
  private logger: Logger;

  /**
   * Initializes a new DockerRunner instance.
   *
   * @param agentId - The ID of the agent owning this runner instance.
   */
  constructor(agentId: string) {
    this.logger = new Logger({ agentId, service: 'docker-runner' });
    this.docker = new Docker();
  }

  /**
   * Pings the Docker daemon to verify connectivity and retrieve the engine version.
   *
   * @returns Promise resolving to the Docker engine version string (e.g., '28.5.1').
   * @throws Error if connection to the Docker daemon fails.
   */
  async verifyDockerConnection(): Promise<string> {
    try {
      const version = await this.docker.version();
      this.logger.info('Connected to Docker Engine successfully', {
        dockerVersion: version.Version,
        apiVersion: version.ApiVersion,
      });
      return version.Version;
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error('Failed to communicate with Docker Engine', { error: error.message });
      throw new Error(`Docker connection failure: ${error.message}`);
    }
  }

  /**
   * Checks if an image exists locally; if not, pulls it from the configured registry.
   *
   * @param imageName - Full image name/tag (e.g., 'alpine:latest').
   */
  private async ensureImageExists(imageName: string): Promise<void> {
    try {
      const img = this.docker.getImage(imageName);
      await img.inspect();
      this.logger.debug(`Image ${imageName} already exists locally`);
    } catch {
      this.logger.info(`Pulling container image: ${imageName}...`);
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(imageName, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          this.docker.modem.followProgress(stream, (followErr: Error | null) => {
            if (followErr) return reject(followErr);
            resolve();
          });
        });
      });
      this.logger.info(`Successfully pulled image: ${imageName}`);
    }
  }

  /**
   * Spawns an isolated sibling container, streams its output, and monitors completion.
   *
   * How it works:
   * 1. Pulls/validates the target Docker image.
   * 2. Creates the container with metadata labels (`djr.job-id`, `djr.agent-id`) and a 512MB RAM cap.
   * 3. Attaches to multiplexed stdout/stderr streams before start, using `demuxStream` to route chunks.
   * 4. Starts the container and races `container.wait()` against a watchdog timer (`timeoutMs`).
   * 5. If timeout fires, signals `container.stop({ t: 2 })` and sets exit code 124.
   * 6. Deletes the container upon completion (`container.remove({ force: true })`).
   *
   * @param options - Execution parameters.
   * @returns Result metrics including exitCode and containerId.
   */
  async runJobContainer(options: RunContainerOptions): Promise<ContainerExecutionResult> {
    const {
      jobId,
      agentId,
      image,
      command,
      script,
      env = {},
      timeoutMs = 60000,
      onLogChunk,
    } = options;

    await this.ensureImageExists(image);

    // Formulate command: if a raw script is passed, execute via /bin/sh -c
    let cmdToRun: string[] = [];
    if (script) {
      cmdToRun = ['/bin/sh', '-c', script];
    } else if (command && command.length > 0) {
      cmdToRun = command;
    }

    const envArray = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    envArray.push(`DJR_JOB_ID=${jobId}`, `DJR_AGENT_ID=${agentId}`);

    const containerName = `djr-job-${jobId}-${Date.now()}`;

    this.logger.info(`Creating worker container ${containerName}`, { jobId, image });

    const container = await this.docker.createContainer({
      Image: image,
      Cmd: cmdToRun.length > 0 ? cmdToRun : undefined,
      Env: envArray,
      name: containerName,
      Labels: {
        'djr.managed-by': 'djr-agent',
        'djr.job-id': jobId,
        'djr.agent-id': agentId,
      },
      HostConfig: {
        AutoRemove: false,
        Memory: 512 * 1024 * 1024, // 512 MB memory limit safety cap
      },
      AttachStdout: true,
      AttachStderr: true,
    });

    // Attach to stdout and stderr streams for live logging
    const stream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    });

    const stdoutWritable = new Writable({
      write(chunk, _encoding, callback) {
        onLogChunk?.(chunk.toString('utf-8'), 'stdout');
        callback();
      },
    });

    const stderrWritable = new Writable({
      write(chunk, _encoding, callback) {
        onLogChunk?.(chunk.toString('utf-8'), 'stderr');
        callback();
      },
    });

    // Demultiplex Docker raw stream into separate stdout and stderr channels
    this.docker.modem.demuxStream(stream, stdoutWritable, stderrWritable);

    this.logger.info(`Starting worker container ${container.id}`, { jobId });
    await container.start();

    // Watchdog timer for timeout enforcement
    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const timeoutPromise = new Promise<{ timedOut: boolean }>((resolve) => {
      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(async () => {
          timedOut = true;
          this.logger.warn(`Job ${jobId} exceeded timeout of ${timeoutMs}ms. Stopping container...`, {
            jobId,
          });
          try {
            await container.stop({ t: 2 });
          } catch {
            // Container might have already exited
          }
          resolve({ timedOut: true });
        }, timeoutMs);
      }
    });

    const waitPromise = container.wait().then((data) => ({
      timedOut: false,
      statusCode: data.StatusCode,
    }));

    try {
      const outcome = await Promise.race([waitPromise, timeoutPromise]);

      if (timeoutTimer) clearTimeout(timeoutTimer);

      let exitCode = -1;
      let errorMsg: string | undefined;

      if (timedOut) {
        exitCode = 124; // POSIX timeout standard exit code
        errorMsg = `Job timed out after ${timeoutMs}ms`;
      } else if ('statusCode' in outcome) {
        exitCode = outcome.statusCode;
      }

      this.logger.info(`Job container finished with exitCode ${exitCode}`, {
        jobId,
        exitCode,
      });

      // Remove container to prevent orphaned resources
      try {
        await container.remove({ force: true });
      } catch {
        this.logger.warn(`Failed to remove container ${container.id}`, { jobId });
      }

      return {
        exitCode,
        error: errorMsg,
        timedOut,
        containerId: container.id,
      };
    } catch (err: unknown) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      const error = err as Error;
      this.logger.error(`Error during container execution for job ${jobId}`, {
        error: error.message,
        jobId,
      });

      try {
        await container.remove({ force: true });
      } catch {}

      return {
        exitCode: 1,
        error: error.message,
        timedOut: false,
        containerId: container.id,
      };
    }
  }

  /**
   * Scans Docker for containers labeled as managed by this agent (useful for reconciliation).
   *
   * @param agentId - The ID of the agent whose containers are being queried.
   */
  async listOrphanedContainers(agentId: string) {
    return this.docker.listContainers({
      all: true,
      filters: {
        label: [`djr.managed-by=djr-agent`, `djr.agent-id=${agentId}`],
      },
    });
  }

  /**
   * Reconciles and cleans up orphaned containers left over from prior agent crashes or restarts.
   *
   * @param agentId - The agent ID to reconcile containers for
   * @returns Count of cleaned containers
   */
  async cleanupOrphanedContainers(agentId: string): Promise<number> {
    const orphans = await this.listOrphanedContainers(agentId);
    if (orphans.length === 0) return 0;

    this.logger.warn(`Found ${orphans.length} orphaned worker containers from previous execution. Initiating cleanup...`, {
      agentId,
      count: orphans.length,
    });

    let cleaned = 0;
    for (const info of orphans) {
      try {
        const container = this.docker.getContainer(info.Id);
        await container.remove({ force: true });
        cleaned++;
        this.logger.info(`Reconciled and removed orphaned container ${info.Id.substring(0, 12)}`, {
          containerId: info.Id,
        });
      } catch (err: unknown) {
        const error = err as Error;
        this.logger.error(`Failed to remove orphan container ${info.Id}`, { error: error.message });
      }
    }
    return cleaned;
  }
}
