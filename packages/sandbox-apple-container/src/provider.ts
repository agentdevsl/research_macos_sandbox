import { spawn, execSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import type {
  ISandboxProvider,
  ISandbox,
  SandboxConfig,
  ProviderInfo,
} from '@sandbox/core';
import type { AppleContainerConfig } from './types.js';
import { AppleContainerSandbox } from './sandbox.js';

const DEFAULT_IMAGE = 'node:22-slim';

/**
 * Apple Container provider using the native `container` CLI in macOS 26+
 *
 * Features:
 * - Full VM isolation per container
 * - Native SSH support (--ssh flag)
 * - virtiofs mounts
 * - Sub-second startup
 */
export class AppleContainerProvider implements ISandboxProvider {
  readonly name = 'apple-container';
  private containerPath: string | null = null;

  /**
   * Find the container CLI path
   */
  private findContainerCli(): string | null {
    if (this.containerPath !== null) {
      return this.containerPath;
    }

    const possiblePaths = [
      '/usr/bin/container',
      '/usr/local/bin/container',
      '/opt/homebrew/bin/container',
    ];

    for (const path of possiblePaths) {
      try {
        execSync(`${path} --version`, { stdio: 'pipe' });
        this.containerPath = path;
        return path;
      } catch {
        // Not found at this path
      }
    }

    // Try PATH
    try {
      execSync('which container', { stdio: 'pipe' });
      this.containerPath = 'container';
      return 'container';
    } catch {
      return null;
    }
  }

  async create(config: SandboxConfig): Promise<ISandbox> {
    const cli = this.findContainerCli();
    if (!cli) {
      throw new Error('Apple Container CLI not found. Requires macOS 26+');
    }

    // Determine user home directory
    const user = config.user;
    const userHome = user?.home ?? (user ? `/home/${user.name}` : '/root');

    const containerConfig: AppleContainerConfig = {
      image: config.image || DEFAULT_IMAGE,
      memory: config.memoryMib ? `${config.memoryMib}m` : '512m',
      cpus: config.cpus ?? 1,
      ssh: true, // Always enable SSH for sandbox access
      volumes: {
        [config.mountPath]: '/workspace',
      },
      workdir: '/workspace',
      env: {
        ...config.env,
        HOME: userHome,
      },
      name: `sandbox-${config.id}`,
      rm: false, // Don't auto-remove so we can exec into it
    };

    // Note: Don't set uid/gid at container runtime as we need root access
    // for initial setup. User switching happens via exec wrapper instead.

    const startTime = performance.now();

    // Ensure mount path exists
    await mkdir(config.mountPath, { recursive: true });

    // Build container run command
    const args = this.buildRunArgs(containerConfig);

    // Start container in background
    const containerId = await this.startContainer(cli, args);
    const startupMs = performance.now() - startTime;

    // Get SSH port if SSH is enabled
    const sshPort = config.sshPort ?? await this.getSshPort(cli, containerId);

    const sandbox = new AppleContainerSandbox({
      id: config.id,
      containerId,
      containerCli: cli,
      sshPort,
      mountPath: config.mountPath,
      startupMs,
      runAsUser: user ? {
        name: user.name,
        uid: user.uid ?? 1000,
        gid: user.gid ?? 1000,
        home: userHome,
      } : undefined,
    });

    // If running as non-root user, set up user environment
    if (user) {
      await sandbox.setupUser();
    }

    return sandbox;
  }

  private buildRunArgs(config: AppleContainerConfig): string[] {
    const args: string[] = ['run', '-d']; // Detached mode

    if (config.name) {
      args.push('--name', config.name);
    }

    if (config.memory) {
      args.push('--memory', config.memory);
    }

    if (config.cpus) {
      args.push('--cpus', String(config.cpus));
    }

    if (config.ssh) {
      args.push('--ssh');
    }

    // User configuration (run as non-root)
    if (config.uid !== undefined) {
      args.push('--uid', String(config.uid));
    }
    if (config.gid !== undefined) {
      args.push('--gid', String(config.gid));
    }

    // Enable networking with DNS (required for npm/API access)
    args.push('--network', 'default');
    args.push('--dns', '8.8.8.8');

    if (config.volumes) {
      for (const [hostPath, containerPath] of Object.entries(config.volumes)) {
        args.push('-v', `${hostPath}:${containerPath}`);
      }
    }

    if (config.workdir) {
      args.push('-w', config.workdir);
    }

    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        args.push('-e', `${key}=${value}`);
      }
    }

    args.push(config.image);

    // Keep container running with a sleep command
    args.push('sleep', 'infinity');

    return args;
  }

  private async startContainer(cli: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cli, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Failed to start container: ${stderr}`));
        }
      });

      proc.on('error', reject);
    });
  }

  private async getSshPort(cli: string, containerId: string): Promise<number> {
    // Apple Container with --ssh provides SSH access
    // The port might be dynamically assigned or follow a pattern
    // For now, try to inspect the container for SSH info
    try {
      const result = execSync(`${cli} inspect ${containerId} --format '{{.NetworkSettings.Ports}}'`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Parse port mapping - this is a simplified implementation
      // The actual format depends on Apple Container's output
      const portMatch = result.match(/22\/tcp.*?(\d+)/);
      if (portMatch?.[1]) {
        return parseInt(portMatch[1], 10);
      }
    } catch {
      // Inspection failed
    }

    // Default SSH port if we can't determine it
    return 2222;
  }

  async isAvailable(): Promise<boolean> {
    const cli = this.findContainerCli();
    if (!cli) {
      return false;
    }

    try {
      // Verify the CLI works
      execSync(`${cli} --version`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  async getInfo(): Promise<ProviderInfo> {
    const cli = this.findContainerCli();

    let version = 'unavailable';
    if (cli) {
      try {
        version = execSync(`${cli} --version`, { encoding: 'utf-8' }).trim();
      } catch {
        // Version check failed
      }
    }

    return {
      name: 'apple-container',
      version,
      isolationType: 'vm', // Full VM isolation
      features: cli ? [
        'native-cli',
        'full-vm-isolation',
        'native-ssh',
        'virtiofs',
        'fast-startup',
        'macos-26+',
      ] : [],
    };
  }

  /**
   * List running containers
   */
  async listContainers(): Promise<string[]> {
    const cli = this.findContainerCli();
    if (!cli) {
      return [];
    }

    try {
      const result = execSync(`${cli} ps -q`, { encoding: 'utf-8' });
      return result.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}
