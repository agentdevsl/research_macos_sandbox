import { mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { SandboxConfig, ISandbox, ISandboxProvider } from './types.js';

/**
 * Orchestrates sandbox lifecycle and manages unique mounts
 */
export class SandboxOrchestrator {
  private readonly baseDir: string;
  private readonly providers = new Map<string, ISandboxProvider>();
  private readonly activeSandboxes = new Map<string, ISandbox>();
  private portCounter = 2222;

  constructor(baseDir = '/tmp/sandboxes') {
    this.baseDir = baseDir;
  }

  /**
   * Register a sandbox provider
   */
  registerProvider(provider: ISandboxProvider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Get a registered provider
   */
  getProvider(name: string): ISandboxProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * List available providers
   */
  async getAvailableProviders(): Promise<string[]> {
    const available: string[] = [];
    for (const [name, provider] of this.providers) {
      if (await provider.isAvailable()) {
        available.push(name);
      }
    }
    return available;
  }

  /**
   * Create unique mount path for a sandbox
   */
  async createMountPath(sandboxId: string): Promise<string> {
    const mountPath = join(this.baseDir, sandboxId, 'workspace');
    await mkdir(mountPath, { recursive: true });
    return mountPath;
  }

  /**
   * Allocate a unique SSH port
   */
  allocatePort(): number {
    return this.portCounter++;
  }

  /**
   * Create a sandbox with automatic mount and port allocation
   */
  async createSandbox(
    providerName: string,
    config: Omit<SandboxConfig, 'mountPath' | 'sshPort'> & {
      mountPath?: string;
      sshPort?: number
    }
  ): Promise<ISandbox> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider not found: ${providerName}`);
    }

    if (!(await provider.isAvailable())) {
      throw new Error(`Provider not available: ${providerName}`);
    }

    const mountPath = config.mountPath ?? await this.createMountPath(config.id);
    const sshPort = config.sshPort ?? this.allocatePort();

    const fullConfig: SandboxConfig = {
      ...config,
      mountPath,
      sshPort,
    };

    const sandbox = await provider.create(fullConfig);
    this.activeSandboxes.set(config.id, sandbox);
    return sandbox;
  }

  /**
   * Stop a specific sandbox
   */
  async stopSandbox(id: string): Promise<void> {
    const sandbox = this.activeSandboxes.get(id);
    if (sandbox) {
      await sandbox.stop();
      this.activeSandboxes.delete(id);
    }
  }

  /**
   * Stop all active sandboxes
   */
  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.activeSandboxes.values()).map(s => s.stop());
    await Promise.allSettled(stopPromises);
    this.activeSandboxes.clear();
  }

  /**
   * Cleanup mount directory for a sandbox
   */
  async cleanupMount(sandboxId: string): Promise<void> {
    const sandboxDir = join(this.baseDir, sandboxId);
    try {
      await access(sandboxDir);
      await rm(sandboxDir, { recursive: true, force: true });
    } catch {
      // Directory doesn't exist, nothing to clean
    }
  }

  /**
   * Get active sandbox count
   */
  getActiveCount(): number {
    return this.activeSandboxes.size;
  }

  /**
   * Get all active sandbox IDs
   */
  getActiveIds(): string[] {
    return Array.from(this.activeSandboxes.keys());
  }
}
