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
  private metrics: SandboxMetrics;

  constructor(options: BoxLiteSandboxOptions) {
    this.id = options.id;
    this.instance = options.instance;
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
    if (this.stopped) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'Sandbox has been stopped',
        durationMs: 0,
      };
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
