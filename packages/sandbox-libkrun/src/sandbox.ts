import type {
  ISandbox,
  ExecResult,
  SandboxMetrics,
} from '@sandbox/core';
import { SSHClient, waitForSSH } from '@sandbox/core';
import type { LibkrunNative, VmInfo } from './types.js';

interface LibkrunSandboxOptions {
  id: string;
  native: LibkrunNative;
  vmInfo: VmInfo;
  sshPort: number;
  mountPath: string;
  startupMs: number;
}

/**
 * libkrun micro-VM sandbox instance
 */
export class LibkrunSandbox implements ISandbox {
  readonly id: string;
  readonly sshPort: number;
  readonly mountPath: string;
  readonly provider = 'libkrun';

  private readonly native: LibkrunNative;
  private readonly vmInfo: VmInfo;
  private running = false;
  private sshClient: SSHClient | null = null;
  private metrics: SandboxMetrics;

  constructor(options: LibkrunSandboxOptions) {
    this.id = options.id;
    this.native = options.native;
    this.vmInfo = options.vmInfo;
    this.sshPort = options.sshPort;
    this.mountPath = options.mountPath;
    this.metrics = {
      startupMs: options.startupMs,
      sshReadyMs: 0,
      execLatencyMs: 0,
      memoryBytes: 0,
    };
  }

  /**
   * Start the VM in a subprocess
   * Note: krun_start_enter blocks, so we need to fork
   */
  async start(): Promise<void> {
    if (this.running) return;

    // Set up the init process
    this.native.setExec(
      this.vmInfo.ctxId,
      '/sbin/init',
      ['init'],
      { PATH: '/usr/local/bin:/usr/bin:/bin' }
    );

    // TODO: Start VM in subprocess and communicate via vsock
    // For now, mark as running - actual VM launch needs subprocess management
    this.running = true;
  }

  async exec(cmd: string, args: string[] = []): Promise<ExecResult> {
    const fullCmd = args.length > 0 ? `${cmd} ${args.join(' ')}` : cmd;
    const startTime = performance.now();

    // TODO: Implement vsock-based exec
    // This requires a guest agent running in the VM that listens on vsock
    // and executes commands, returning results

    // For now, fall back to SSH if available
    if (this.sshPort > 0) {
      return this.sshExec(fullCmd);
    }

    const durationMs = performance.now() - startTime;
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'Direct exec via vsock not yet implemented. Use SSH port mapping.',
      durationMs,
    };
  }

  async sshExec(cmd: string): Promise<ExecResult> {
    if (this.sshPort === 0) {
      throw new Error('SSH not configured for this sandbox');
    }

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
    if (this.sshClient) {
      this.sshClient.disconnect();
      this.sshClient = null;
    }

    if (this.running) {
      try {
        this.native.freeContext(this.vmInfo.ctxId);
      } catch (err) {
        console.warn('Error freeing libkrun context:', err);
      }
      this.running = false;
    }
  }

  async isRunning(): Promise<boolean> {
    return this.running;
  }

  /**
   * Get vsock context ID for direct communication
   */
  getVsockCid(): number {
    return this.vmInfo.cid;
  }

  /**
   * Get VM info
   */
  getVmInfo(): VmInfo {
    return { ...this.vmInfo };
  }
}
