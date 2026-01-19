import type {
  ISandboxProvider,
  ISandbox,
  SandboxConfig,
  ProviderInfo,
} from '@sandbox/core';
import type { LibkrunNative, LibkrunConfig } from './types.js';
import { LibkrunSandbox } from './sandbox.js';

/**
 * libkrun native provider using napi-rs bindings
 */
export class LibkrunProvider implements ISandboxProvider {
  readonly name = 'libkrun';
  private native: LibkrunNative | null = null;
  private loadAttempted = false;
  private loadError: Error | null = null;

  /**
   * Load the native module
   */
  private async loadNative(): Promise<LibkrunNative | null> {
    if (this.loadAttempted) {
      return this.native;
    }

    this.loadAttempted = true;

    try {
      // Try to load the native module dynamically
      // The .node file should be in the package root after native build
      // @ts-expect-error - Native module may not exist until built
      const nativeModule = await import('../libkrun.darwin-arm64.node');
      this.native = nativeModule as unknown as LibkrunNative;
      return this.native;
    } catch (err: unknown) {
      this.loadError = new Error(
        `Failed to load libkrun native module: ${err instanceof Error ? err.message : err}\n` +
        'Make sure libkrun is installed and the native module is built.\n' +
        'Run: pnpm --filter @sandbox/libkrun build'
      );
      return null;
    }
  }

  async create(config: SandboxConfig): Promise<ISandbox> {
    const native = await this.loadNative();
    if (!native) {
      throw new Error(`libkrun not available: ${this.loadError?.message}`);
    }

    const libkrunConfig: LibkrunConfig = {
      cpus: config.cpus ?? 1,
      memoryMib: config.memoryMib ?? 512,
      rootfsPath: '/opt/libkrun/rootfs', // Default rootfs location
      workdir: '/workspace',
      mounts: {
        workspace: config.mountPath,
      },
      env: config.env ?? {},
    };

    if (config.sshPort) {
      libkrunConfig.portMap = [`${config.sshPort}:22`];
    }

    const startTime = performance.now();
    const vmInfo = native.createContext(libkrunConfig);
    const startupMs = performance.now() - startTime;

    return new LibkrunSandbox({
      id: config.id,
      native,
      vmInfo,
      sshPort: config.sshPort ?? 0,
      mountPath: config.mountPath,
      startupMs,
    });
  }

  async isAvailable(): Promise<boolean> {
    const native = await this.loadNative();
    if (!native) {
      return false;
    }

    try {
      return native.isAvailable();
    } catch {
      return false;
    }
  }

  async getInfo(): Promise<ProviderInfo> {
    const native = await this.loadNative();

    return {
      name: 'libkrun',
      version: native?.getVersion() ?? 'unavailable',
      isolationType: 'microvm',
      features: native ? [
        'native-bindings',
        'napi-rs',
        'virtiofs',
        'vsock',
        'low-overhead',
      ] : [],
    };
  }

  getLoadError(): Error | null {
    return this.loadError;
  }
}
