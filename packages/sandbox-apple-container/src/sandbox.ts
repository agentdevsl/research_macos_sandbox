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
  /** Run commands as this user instead of root */
  runAsUser?: {
    name: string;
    uid: number;
    gid: number;
    home: string;
  } | undefined;
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
  private runAsUser: { name: string; uid: number; gid: number; home: string } | undefined;
  private userSetupComplete = false;

  constructor(options: AppleContainerSandboxOptions) {
    this.id = options.id;
    this.containerId = options.containerId;
    this.containerCli = options.containerCli;
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
   * Set up non-root user environment (Debian/Ubuntu style)
   */
  async setupUser(): Promise<void> {
    if (!this.runAsUser || this.userSetupComplete) return;

    const { name, uid, gid, home } = this.runAsUser;

    // Debian uses useradd/groupadd (in /usr/sbin)
    // Use -o flag to allow non-unique UID/GID (in case image already has users)
    // node:22-slim has node:node with UID/GID 1000
    const setupScript = `
      export PATH=/usr/sbin:/usr/bin:/sbin:/bin:$PATH
      # Create group (allow non-unique GID with -o)
      if ! getent group ${name} >/dev/null 2>&1; then
        /usr/sbin/groupadd -o -g ${gid} ${name} 2>/dev/null || true
      fi
      # Create user with home directory (allow non-unique UID with -o)
      if ! id ${name} >/dev/null 2>&1; then
        /usr/sbin/useradd -o -u ${uid} -g ${gid} -m -d ${home} -s /bin/sh ${name} 2>/dev/null || true
      fi
      # Ensure home exists with correct ownership
      mkdir -p ${home}
      chown ${uid}:${gid} ${home}
      # Create .claude directory
      mkdir -p ${home}/.claude
      chown ${uid}:${gid} ${home}/.claude
      chmod 700 ${home}/.claude
      # Give user ownership of workspace
      chown -R ${uid}:${gid} /workspace 2>/dev/null || true
      # Verify user was created
      id ${name}
    `;

    const result = await this.execAsRoot('sh', ['-c', setupScript.trim()]);
    if (result.exitCode !== 0) {
      console.error('User setup failed:', result.stderr || result.stdout);
    }
    this.userSetupComplete = true;
  }

  /**
   * Execute a command as root, bypassing user switching.
   */
  async execAsRoot(cmd: string, args: string[] = []): Promise<ExecResult> {
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

  /**
   * Wrap a command to run as the configured user
   * Returns a single shell command with proper quoting
   */
  private wrapCommandForUser(cmd: string, args: string[]): string[] {
    if (!this.runAsUser || !this.userSetupComplete) {
      return args.length > 0 ? [cmd, ...args] : [cmd];
    }

    // Combine cmd and args into a single command string
    const fullCmd = args.length > 0 ? `${cmd} ${args.join(' ')}` : cmd;
    const home = this.runAsUser.home;

    // Escape single quotes in fullCmd for shell
    const escapedCmd = fullCmd.replace(/'/g, "'\\''");

    // Use su with proper environment setup - return as single shell command
    return [
      'sh', '-c',
      `su -s /bin/sh ${this.runAsUser.name} -c 'export HOME=${home} && cd /workspace && ${escapedCmd}'`
    ];
  }

  async exec(cmd: string, args: string[] = []): Promise<ExecResult> {
    // Wrap command for user if configured
    const fullCmd = this.wrapCommandForUser(cmd, args);
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
