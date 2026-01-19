import type Docker from 'dockerode';
import type {
  ISandbox,
  ExecResult,
  SandboxMetrics,
} from '@sandbox/core';
import { SSHClient, waitForSSH } from '@sandbox/core';

interface OrbStackSandboxOptions {
  id: string;
  container: Docker.Container;
  sshPort: number;
  mountPath: string;
  startupMs: number;
}

/**
 * OrbStack Docker container sandbox instance
 */
export class OrbStackSandbox implements ISandbox {
  readonly id: string;
  readonly sshPort: number;
  readonly mountPath: string;
  readonly provider = 'orbstack';

  private readonly container: Docker.Container;
  private sshClient: SSHClient | null = null;
  private metrics: SandboxMetrics;

  constructor(options: OrbStackSandboxOptions) {
    this.id = options.id;
    this.container = options.container;
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
    const fullCmd = args.length > 0 ? `${cmd} ${args.join(' ')}` : cmd;
    const startTime = performance.now();

    const exec = await this.container.exec({
      Cmd: ['sh', '-c', fullCmd],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      // Docker multiplexes stdout/stderr in a single stream
      // Format: [STREAM_TYPE, 0, 0, 0, SIZE1, SIZE2, SIZE3, SIZE4, DATA...]
      stream.on('data', (chunk: Buffer) => {
        let offset = 0;
        while (offset < chunk.length) {
          if (offset + 8 > chunk.length) break;

          const streamType = chunk[offset];
          const size = chunk.readUInt32BE(offset + 4);
          const data = chunk.slice(offset + 8, offset + 8 + size).toString();

          if (streamType === 1) {
            stdout += data;
          } else if (streamType === 2) {
            stderr += data;
          }

          offset += 8 + size;
        }
      });

      stream.on('end', async () => {
        const durationMs = performance.now() - startTime;

        try {
          const inspection = await exec.inspect();
          resolve({
            exitCode: inspection.ExitCode ?? 0,
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
            durationMs,
          });
        } catch (err) {
          reject(err);
        }
      });

      stream.on('error', reject);
    });
  }

  async sshExec(cmd: string): Promise<ExecResult> {
    // Ensure SSH client is connected
    if (!this.sshClient) {
      const sshStartTime = performance.now();
      this.sshClient = await waitForSSH({
        host: '127.0.0.1',
        port: this.sshPort,
        username: 'root',
        password: 'sandbox',
        readyTimeout: 30000,
      });
      this.metrics.sshReadyMs = performance.now() - sshStartTime;
    }

    const result = await this.sshClient.exec(cmd);

    // Update exec latency metric (running average)
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

    try {
      // Stop container
      await this.container.stop({ t: 5 });
    } catch (err) {
      // Container might already be stopped
    }

    try {
      // Remove container
      await this.container.remove({ force: true });
    } catch {
      // Container might already be removed
    }
  }

  async isRunning(): Promise<boolean> {
    try {
      const inspection = await this.container.inspect();
      return inspection.State?.Running ?? false;
    } catch {
      return false;
    }
  }

  /**
   * Get container stats (memory, CPU)
   */
  async updateStats(): Promise<void> {
    try {
      const stats = await this.container.stats({ stream: false });
      this.metrics.memoryBytes = stats.memory_stats?.usage ?? 0;
    } catch {
      // Stats might not be available
    }
  }

  /**
   * Get container logs
   */
  async getLogs(tail = 100): Promise<string> {
    const logs = await this.container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
    });
    return logs.toString();
  }
}
