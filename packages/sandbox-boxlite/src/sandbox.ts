import type {
  ISandbox,
  ExecResult,
  SandboxMetrics,
} from '@sandbox/core';
import type { SimpleBoxInstance } from './types.js';

interface BoxLiteSandboxOptions {
  id: string;
  instance: SimpleBoxInstance;
  sshPort: number;
  mountPath: string;
  startupMs: number;
  /** Initialize npm to use /workspace for packages (avoids rootfs space issues) */
  initializeNpm?: boolean;
}

/**
 * BoxLite micro-VM sandbox instance
 * 
 * Wraps a SimpleBox instance from @boxlite-ai/boxlite SDK.
 * Uses Hypervisor.framework on macOS or KVM on Linux for hardware-level isolation.
 */
export class BoxLiteSandbox implements ISandbox {
  readonly id: string;
  readonly sshPort: number;
  readonly mountPath: string;
  readonly provider = 'boxlite';

  private readonly instance: SimpleBoxInstance;
  private boxId: string | null = null;
  private stopped = false;
  private npmInitialized = false;
  private initializeNpmOnStart: boolean;
  private metrics: SandboxMetrics;

  constructor(options: BoxLiteSandboxOptions) {
    this.id = options.id;
    this.instance = options.instance;
    this.sshPort = options.sshPort;
    this.mountPath = options.mountPath;
    this.initializeNpmOnStart = options.initializeNpm ?? true;
    this.metrics = {
      startupMs: options.startupMs,
      sshReadyMs: 0,
      execLatencyMs: 0,
      memoryBytes: 0,
    };
  }

  /**
   * Initialize npm to use /workspace for packages.
   * This avoids disk space issues on the limited Alpine rootfs (~220MB).
   *
   * Creates:
   * - /workspace/node_modules for local packages
   * - /workspace/.npm-global for global packages
   * - Configures npm prefix and PATH
   */
  async initializeNpm(): Promise<void> {
    if (this.npmInitialized) return;

    try {
      // Create directories
      await this.instance.exec('mkdir', '-p', '/workspace/node_modules');
      await this.instance.exec('mkdir', '-p', '/workspace/.npm-global/bin');

      // Configure npm to use /workspace for global packages
      await this.instance.exec('npm', 'config', 'set', 'prefix', '/workspace/.npm-global');

      // Add global bin to PATH in profile
      await this.instance.exec('sh', '-c',
        'echo \'export PATH=/workspace/.npm-global/bin:$PATH\' >> /etc/profile');

      // Also set for current session via environment
      await this.instance.exec('sh', '-c',
        'echo \'export NPM_CONFIG_PREFIX=/workspace/.npm-global\' >> /etc/profile');

      this.npmInitialized = true;
    } catch (err) {
      // npm might not be installed yet, that's OK
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('not found')) {
        console.warn('Failed to initialize npm workspace:', message);
      }
    }
  }

  /**
   * Execute a command with npm PATH configured.
   * Use this for npm/node commands to ensure global packages are found.
   */
  async execWithNpmPath(cmd: string): Promise<ExecResult> {
    const wrappedCmd = `export PATH=/workspace/.npm-global/bin:$PATH && ${cmd}`;
    return this.exec('sh', ['-c', wrappedCmd]);
  }

  /**
   * Install an npm package (handles workspace configuration automatically).
   * @param pkg Package name (e.g., '@anthropic-ai/claude-agent-sdk')
   * @param global Install globally (to /workspace/.npm-global)
   */
  async npmInstall(pkg: string, global = false): Promise<ExecResult> {
    await this.initializeNpm();
    const globalFlag = global ? '-g' : '';
    const cmd = global
      ? `export PATH=/workspace/.npm-global/bin:$PATH && npm install ${globalFlag} ${pkg}`
      : `cd /workspace && npm install ${pkg}`;
    return this.exec('sh', ['-c', cmd]);
  }

  async exec(cmd: string, args: string[] = []): Promise<ExecResult> {
    if (this.stopped) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'Sandbox has been stopped',
        durationMs: 0,
      };
    }

    // Auto-initialize npm on first exec if enabled and npm is available
    if (this.initializeNpmOnStart && !this.npmInitialized && cmd !== 'true') {
      await this.initializeNpm();
    }

    const startTime = performance.now();

    try {
      // SimpleBox.exec takes command and args separately
      const result = await this.instance.exec(cmd, ...args);
      const durationMs = performance.now() - startTime;

      // Cache the box ID after first successful exec (lazy initialization)
      if (!this.boxId) {
        try {
          this.boxId = this.instance.id;
        } catch (e) {
          // ID not available yet, will try again later
        }
      }

      // Update exec latency metric (rolling average)
      if (this.metrics.execLatencyMs === 0) {
        this.metrics.execLatencyMs = durationMs;
      } else {
        this.metrics.execLatencyMs = (this.metrics.execLatencyMs + durationMs) / 2;
      }

      return {
        exitCode: result.exitCode,
        stdout: result.stdout.trimEnd(),
        stderr: result.stderr.trimEnd(),
        durationMs,
      };
    } catch (err) {
      const durationMs = performance.now() - startTime;
      return {
        exitCode: 1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        durationMs,
      };
    }
  }

  async sshExec(cmd: string): Promise<ExecResult> {
    // BoxLite uses direct exec via native bindings, not SSH
    // Parse the command string into cmd and args for exec()
    const parts = cmd.split(' ');
    const command = parts[0] ?? 'true';
    const args = parts.slice(1);
    return this.exec(command, args);
  }

  getMetrics(): SandboxMetrics {
    return { ...this.metrics };
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;

    try {
      await this.instance.stop();
    } catch (err) {
      // Instance might already be stopped
      console.warn('Error stopping BoxLite instance:', err);
    }
  }

  async isRunning(): Promise<boolean> {
    if (this.stopped) {
      return false;
    }

    // Try a simple exec to check if the box is responsive
    try {
      const result = await this.instance.exec('true');
      return result.exitCode === 0;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get the BoxLite instance ID (ULID)
   * Returns null if the box hasn't been initialized yet (no exec() called)
   */
  getBoxId(): string | null {
    if (this.boxId) {
      return this.boxId;
    }
    try {
      this.boxId = this.instance.id;
      return this.boxId;
    } catch (e) {
      return null;
    }
  }

  /**
   * Get box metadata
   */
  getInfo(): Record<string, unknown> {
    try {
      return this.instance.info();
    } catch (e) {
      return { error: 'Box not yet initialized' };
    }
  }
}
