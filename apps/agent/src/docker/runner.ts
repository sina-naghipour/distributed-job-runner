import Docker from 'dockerode';
import { Logger } from '@djr/shared';
import { Writable } from 'node:stream';
import { ImageManager } from './image-manager.js';
import { ContainerReconciler } from './reconciler.js';

/**
 * Execution options for running a job in an isolated container.
 */
export interface RunContainerOptions {
  jobId: string;
  agentId: string;
  image: string;
  command?: string[];
  script?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  onLogChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

/**
 * Result returned after container execution.
 */
export interface ContainerExecutionResult {
  exitCode: number;
  error?: string;
  timedOut?: boolean;
  containerId: string;
}

/**
 * DockerRunner coordinates container execution by composing ImageManager and ContainerReconciler.
 * Adheres to Single Responsibility (SRP) and Dependency Inversion.
 */
export class DockerRunner {
  private docker: Docker;
  private logger: Logger;
  private imageManager: ImageManager;
  private reconciler: ContainerReconciler;

  constructor(agentId: string) {
    this.logger = new Logger({ agentId, service: 'docker-runner' });
    this.docker = new Docker();
    this.imageManager = new ImageManager(this.docker, agentId);
    this.reconciler = new ContainerReconciler(this.docker, agentId);
  }

  /**
   * Pings Docker daemon to verify connectivity and retrieve engine version.
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
   * Delegate orphaned container cleanup to ContainerReconciler.
   */
  async cleanupOrphanedContainers(): Promise<number> {
    return this.reconciler.cleanupOrphanedContainers();
  }

  /**
   * Spawns an isolated sibling container, streams its output, and monitors completion.
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

    await this.imageManager.ensureImageExists(image);

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
        Memory: 512 * 1024 * 1024,
      },
      AttachStdout: true,
      AttachStderr: true,
    });

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

    this.docker.modem.demuxStream(stream, stdoutWritable, stderrWritable);

    this.logger.info(`Starting worker container ${container.id}`, { jobId });
    await container.start();

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
          } catch {}
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
        exitCode = 124;
        errorMsg = `Job timed out after ${timeoutMs}ms`;
      } else if ('statusCode' in outcome) {
        exitCode = outcome.statusCode;
      }

      this.logger.info(`Job container finished with exitCode ${exitCode}`, {
        jobId,
        exitCode,
      });

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
}
