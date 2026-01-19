import Docker from 'dockerode';
import type {
  ISandboxProvider,
  ISandbox,
  SandboxConfig,
  ProviderInfo,
} from '@sandbox/core';
import { OrbStackSandbox } from './sandbox.js';

const DEFAULT_IMAGE = 'sandbox-claude:latest';

/**
 * OrbStack-based sandbox provider using Docker containers
 */
export class OrbStackProvider implements ISandboxProvider {
  readonly name = 'orbstack';
  private readonly docker: Docker;

  constructor() {
    // OrbStack provides Docker API compatibility via its socket
    this.docker = new Docker({
      socketPath: '/var/run/docker.sock',
    });
  }

  async create(config: SandboxConfig): Promise<ISandbox> {
    const image = config.image || DEFAULT_IMAGE;
    const sshPort = config.sshPort || 2222;

    // Create container with bind mount and port mapping
    const container = await this.docker.createContainer({
      Image: image,
      name: `sandbox-${config.id}`,
      Hostname: config.id,
      Env: Object.entries(config.env || {}).map(([k, v]) => `${k}=${v}`),
      HostConfig: {
        Binds: [`${config.mountPath}:/workspace`],
        PortBindings: {
          '22/tcp': [{ HostPort: String(sshPort) }],
        },
        Memory: config.memoryMib ? config.memoryMib * 1024 * 1024 : undefined,
        NanoCpus: config.cpus ? config.cpus * 1e9 : undefined,
        AutoRemove: false,
      },
      ExposedPorts: {
        '22/tcp': {},
      },
    });

    // Start the container
    const startTime = performance.now();
    await container.start();
    const startupMs = performance.now() - startTime;

    return new OrbStackSandbox({
      id: config.id,
      container,
      sshPort,
      mountPath: config.mountPath,
      startupMs,
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Check if OrbStack is running by pinging Docker
      await this.docker.ping();

      // Verify Docker is running (OrbStack or Docker Desktop)
      await this.docker.info();
      return true;
    } catch {
      return false;
    }
  }

  async getInfo(): Promise<ProviderInfo> {
    try {
      const info = await this.docker.info();
      const version = await this.docker.version();

      return {
        name: 'orbstack',
        version: version.Version || 'unknown',
        isolationType: 'container',
        features: [
          'docker-api',
          'bind-mounts',
          'port-mapping',
          'resource-limits',
          info.OperatingSystem?.includes('OrbStack') ? 'orbstack-native' : 'docker-compat',
        ],
      };
    } catch {
      return {
        name: 'orbstack',
        version: 'unavailable',
        isolationType: 'container',
        features: [],
      };
    }
  }

  /**
   * Build the sandbox Docker image
   */
  async buildImage(dockerfilePath: string, tag = DEFAULT_IMAGE): Promise<void> {
    const stream = await this.docker.buildImage(
      {
        context: dockerfilePath,
        src: ['Dockerfile.claude'],
      },
      { t: tag }
    );

    // Wait for build to complete
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        },
        (event: { stream?: string }) => {
          if (event.stream) {
            process.stdout.write(event.stream);
          }
        }
      );
    });
  }

  /**
   * Check if image exists locally
   */
  async hasImage(tag = DEFAULT_IMAGE): Promise<boolean> {
    try {
      await this.docker.getImage(tag).inspect();
      return true;
    } catch {
      return false;
    }
  }
}
