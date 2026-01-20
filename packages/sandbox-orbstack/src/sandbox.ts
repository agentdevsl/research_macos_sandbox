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
  /** Run commands as this user instead of root */
  runAsUser?: {
    name: string;
    uid: number;
    gid: number;
    home: string;
  };
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
  private runAsUser: { name: string; uid: number; gid: number; home: string } | undefined;
  private userSetupComplete = false;

  constructor(options: OrbStackSandboxOptions) {
    this.id = options.id;
    this.container = options.container;
    this.sshPort = options.sshPort;
    this.mountPath = options.mountPath;
    this.runAsUser = options.runAsUser;
    this.metrics = {
      startupMs: options.startupMs,
      sshReadyMs: 0,
      execLatencyMs: 0,
      memoryBytes: 0,
    };
  }

  /**
   * Set up non-root user environment
   */
  async setupUser(): Promise<void> {
    if (!this.runAsUser || this.userSetupComplete) return;

    const { name, uid, gid, home } = this.runAsUser;

    // Create user and directories - works on Alpine and Debian-based images
    const setupScript = `
      # Create group (Alpine uses addgroup, Debian uses groupadd)
      if command -v addgroup >/dev/null 2>&1; then
        addgroup -g ${gid} ${name} 2>/dev/null || true
        adduser -D -u ${uid} -G ${name} -h ${home} -s /bin/sh ${name} 2>/dev/null || true
      else
        groupadd -o -g ${gid} ${name} 2>/dev/null || true
        useradd -o -u ${uid} -g ${gid} -m -d ${home} -s /bin/sh ${name} 2>/dev/null || true
      fi
      # Ensure home exists with correct ownership
      mkdir -p ${home}
      chown -R ${uid}:${gid} ${home}
      # Create .claude directory
      mkdir -p ${home}/.claude
      chown ${uid}:${gid} ${home}/.claude
      chmod 700 ${home}/.claude
      # Create npm cache directory
      mkdir -p ${home}/.npm
      chown -R ${uid}:${gid} ${home}/.npm
      # Give user ownership of workspace
      chown -R ${uid}:${gid} /workspace
    `;

    await this.execAsRoot('sh', ['-c', setupScript.trim()]);
    this.userSetupComplete = true;
  }

  /**
   * Wrap a command to run as the configured user
   * Returns a single-element array with the complete shell command
   */
  private wrapCommandForUser(cmd: string[]): string[] {
    if (!this.runAsUser || !this.userSetupComplete) {
      return cmd;
    }

    const fullCmd = cmd.join(' ');
    const home = this.runAsUser.home;

    // Escape single quotes in fullCmd for shell
    const escapedCmd = fullCmd.replace(/'/g, "'\\''");

    // Use su with proper environment setup - quote the -c argument
    // Returns single command string that will be passed to sh -c
    return [
      `su -s /bin/sh ${this.runAsUser.name} -c 'export HOME=${home} && export PATH=/workspace/.npm-global/bin:$PATH && cd /workspace && ${escapedCmd}'`
    ];
  }

  /**
   * Execute a command as root, bypassing user switching.
   * Use this for system-level operations like package installation.
   */
  async execAsRoot(cmd: string, args: string[] = []): Promise<ExecResult> {
    const fullCmd = args.length > 0 ? [cmd, ...args] : [cmd];
    return this.execInternal(fullCmd, false);
  }

  async exec(cmd: string, args: string[] = []): Promise<ExecResult> {
    const baseCmd = args.length > 0 ? [cmd, ...args] : [cmd];
    // Wrap with user switching if configured
    const wrappedCmd = this.wrapCommandForUser(baseCmd);
    return this.execInternal(wrappedCmd, true);
  }

  /**
   * Internal exec that runs the given command array
   */
  private async execInternal(cmdArray: string[], updateMetrics = true): Promise<ExecResult> {
    const startTime = performance.now();

    // Join the command array into a shell command
    const fullCmd = cmdArray.length === 1 ? cmdArray[0] ?? 'true' : cmdArray.join(' ');

    const execInstance = await this.container.exec({
      Cmd: ['sh', '-c', fullCmd],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await execInstance.start({ hijack: true, stdin: false });

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
          const inspection = await execInstance.inspect();

          // Update exec latency metric (running average)
          if (updateMetrics) {
            if (this.metrics.execLatencyMs === 0) {
              this.metrics.execLatencyMs = durationMs;
            } else {
              this.metrics.execLatencyMs = (this.metrics.execLatencyMs + durationMs) / 2;
            }
          }

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
