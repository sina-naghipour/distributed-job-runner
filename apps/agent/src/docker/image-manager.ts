import Docker from 'dockerode';
import { Logger } from '@djr/shared';

/**
 * ImageManager encapsulates Docker image discovery, verification, and pulling.
 * Adheres to Single Responsibility Principle (SRP).
 */
export class ImageManager {
  private logger: Logger;

  constructor(private docker: Docker, agentId: string) {
    this.logger = new Logger({ agentId, service: 'image-manager' });
  }

  /**
   * Checks if an image exists locally; if not, pulls it from the configured registry.
   *
   * @param imageName - Full image name/tag (e.g., 'alpine:latest').
   */
  async ensureImageExists(imageName: string): Promise<void> {
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
}
