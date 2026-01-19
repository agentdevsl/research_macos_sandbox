import { spawn, execSync } from 'node:child_process';
import type {
  ISandbox,
  ExecResult,
  SandboxMetrics,
} from '@sandbox/core';
import { SSHClient, waitForSSH } from '@sandbox/core';

interface AppleContainerSandboxOptions {
  id: string;
  containerId: string;
  containerCli: string;
  sshPort: number;
  mountPath: string;
  startupMs: number;
}

/**
 * Apple Container sandbox instance
 *
 * Uses the native `container` CLI in macOS 26 for execution
 */
export class AppleContainerSandbox implements ISandbox {
  readonly id: string;
  readonly sshPort: number;
  readonly mountPath: string;
  readonly provider = 'apple-container';

  private readonly containerId: string;
  private readonly containerCli: string;
  private sshClient: SSHClient | null = null;
  private metrics: SandboxMetrics;

  constructor(options: AppleContainerSandboxOptions) {
    this.id = options.id;
    this.containerId = options.containerId;
    this.containerCli = options.containerCli;
    this.sshPort = options.sshPort;
    this.mountPath = options.mountPath;
    this.metrics = {
      startupMs: options.startupMs,
      sshReadyMs: 0,
      execLatencyMs: 0,
      memoryBytes: 0,
    };
  }

  async exec(cmd: string, args: string[] = []): Promise<ExecResult> {
    const fullCmd = args.length > 0 ? [cmd, ...args] : [cmd];
    const startTime = performance.now();

    return new Promise((resolve) => {
      const execArgs = ['exec', this.containerId, ...fullCmd];

      const proc = spawn(this.containerCli, execArgs, {
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
        const durationMs = performance.now() - startTime;

        // Update exec latency metric
        if (this.metrics.execLatencyMs === 0) {
          this.metrics.execLatencyMs = durationMs;
        } else {
          this.metrics.execLatencyMs = (this.metrics.execLatencyMs + durationMs) / 2;
        }

        resolve({
          exitCode: code ?? 0,
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
          durationMs,
        });
      });

      proc.on('error', (err) => {
        const durationMs = performance.now() - startTime;
        resolve({
          exitCode: 1,
          stdout: '',
          stderr: err.message,
          durationMs,
        });
      });
    });
  }

  async sshExec(cmd: string): Promise<ExecResult> {
    // Establish SSH connection if not already connected
    if (!this.sshClient) {
      const sshStartTime = performance.now();
      try {
        this.sshClient = await waitForSSH({
          host: '127.0.0.1',
          port: this.sshPort,
          username: 'root',
          password: 'sandbox', // Apple Container may use different auth
          readyTimeout: 30000,
        });
        this.metrics.sshReadyMs = performance.now() - sshStartTime;
      } catch (err) {
        // If SSH fails, fall back to container exec
        console.warn('SSH not available, falling back to container exec');
        return this.exec('sh', ['-c', cmd]);
      }
    }

    const result = await this.sshClient.exec(cmd);

    // Update exec latency metric
    if (this.metrics.execLatencyMs === 0) {
      this.metrics.execLatencyMs = result.durationMs;
    } else {
      this.metrics.execLatencyMs = (this.metrics.execLatencyMs + result.durationMs) / 2;
    }

    return result;
  }

  getMetrics(): SandboxMetrics {
    return { ...this.metrics };
  }

  async stop(): Promise<void> {
    // Disconnect SSH
    if (this.sshClient) {
      this.sshClient.disconnect();
      this.sshClient = null;
    }

    // Stop the container
    try {
      execSync(`${this.containerCli} stop ${this.containerId}`, {
        stdio: 'pipe',
        timeout: 10000,
      });
    } catch {
      // Container might already be stopped
    }

    // Remove the container
    try {
      execSync(`${this.containerCli} rm -f ${this.containerId}`, {
        stdio: 'pipe',
      });
    } catch {
      // Container might already be removed
    }
  }

  async isRunning(): Promise<boolean> {
    try {
      const result = execSync(
        `${this.containerCli} inspect ${this.containerId} --format '{{.State.Running}}'`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      return result.trim() === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Get container stats
   */
  async updateStats(): Promise<void> {
    try {
      const result = execSync(
        `${this.containerCli} stats ${this.containerId} --no-stream --format '{{.MemUsage}}'`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );

      // Parse memory usage (e.g., "100MiB / 512MiB")
      const memMatch = result.match(/(\d+(?:\.\d+)?)\s*(MiB|GiB|KiB|B)/i);
      if (memMatch) {
        const value = parseFloat(memMatch[1] ?? '0');
        const unit = (memMatch[2] ?? 'B').toLowerCase();
        const multipliers: Record<string, number> = {
          'b': 1,
          'kib': 1024,
          'mib': 1024 * 1024,
          'gib': 1024 * 1024 * 1024,
        };
        this.metrics.memoryBytes = value * (multipliers[unit] ?? 1);
      }
    } catch {
      // Stats not available
    }
  }

  /**
   * Get container logs
   */
  async getLogs(tail = 100): Promise<string> {
    try {
      return execSync(
        `${this.containerCli} logs --tail ${tail} ${this.containerId}`,
        { encoding: 'utf-8' }
      );
    } catch (err) {
      return err instanceof Error ? err.message : 'Failed to get logs';
    }
  }

  /**
   * Get container ID
   */
  getContainerId(): string {
    return this.containerId;
  }
}
