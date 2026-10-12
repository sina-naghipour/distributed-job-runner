import Docker from 'dockerode';
import { Logger } from '@djr/shared';

/**
 * ContainerReconciler is dedicated to discovering and pruning orphaned containers
 * left by crashed or restarted agent processes.
 * Adheres to Single Responsibility Principle (SRP).
 */
export class ContainerReconciler {
  private logger: Logger;

  constructor(private docker: Docker, private agentId: string) {
    this.logger = new Logger({ agentId, service: 'container-reconciler' });
  }

  /**
   * Scans Docker for containers labeled as managed by this agent.
   */
  async listOrphanedContainers() {
    return this.docker.listContainers({
      all: true,
      filters: {
        label: [`djr.managed-by=djr-agent`, `djr.agent-id=${this.agentId}`],
      },
    });
  }

  /**
   * Reconciles and cleans up orphaned containers.
   *
   * @returns Count of cleaned containers
   */
  async cleanupOrphanedContainers(): Promise<number> {
    const orphans = await this.listOrphanedContainers();
    if (orphans.length === 0) return 0;

    this.logger.warn(`Found ${orphans.length} orphaned worker containers from previous execution. Initiating cleanup...`, {
      agentId: this.agentId,
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
