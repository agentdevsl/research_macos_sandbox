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
    // Use 0 to let Docker assign a random available port, or use specified port
    const requestedPort = config.sshPort ?? 0;

    // Create container with bind mount and port mapping
    // Use tail -f /dev/null to keep container running (standard Docker pattern)
    const container = await this.docker.createContainer({
      Image: image,
      name: `sandbox-${config.id}`,
      Hostname: config.id,
      Cmd: ['tail', '-f', '/dev/null'],
      Env: Object.entries(config.env || {}).map(([k, v]) => `${k}=${v}`),
      HostConfig: {
        Binds: [`${config.mountPath}:/workspace`],
        PortBindings: requestedPort > 0
          ? { '22/tcp': [{ HostPort: String(requestedPort) }] }
          : { '22/tcp': [{ HostPort: '' }] },  // Empty string = random port
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

    // Get the actual assigned SSH port from the container
    const inspection = await container.inspect();
    const portBindings = inspection.NetworkSettings?.Ports?.['22/tcp'];
    const actualSshPort = portBindings?.[0]?.HostPort
      ? parseInt(portBindings[0].HostPort, 10)
      : (requestedPort || 2222);

    // Build user config if provided (with default uid/gid of 1000)
    const runAsUser = config.user
      ? {
          name: config.user.name,
          uid: config.user.uid ?? 1000,
          gid: config.user.gid ?? 1000,
          home: `/home/${config.user.name}`,
        }
      : undefined;

    const sandbox = new OrbStackSandbox(
      runAsUser
        ? {
            id: config.id,
            container,
            sshPort: actualSshPort,
            mountPath: config.mountPath,
            startupMs,
            runAsUser,
          }
        : {
            id: config.id,
            container,
            sshPort: actualSshPort,
            mountPath: config.mountPath,
            startupMs,
          }
    );

    // Set up user if configured
    if (runAsUser) {
      await sandbox.setupUser();
    }

    return sandbox;
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
