import type {
  ISandboxProvider,
  ISandbox,
  SandboxConfig,
  ProviderInfo,
} from '@sandbox/core';
import type { BoxLiteModule, SimpleBoxOptions } from './types.js';
import { BoxLiteSandbox } from './sandbox.js';

/**
 * BoxLite micro-VM provider
 *
 * Uses @boxlite-ai/boxlite SDK for hardware-isolated sandbox execution.
 * Supports macOS ARM64 (Apple Silicon) and Linux with KVM.
 */
export class BoxLiteProvider implements ISandboxProvider {
  readonly name = 'boxlite';
  private boxliteModule: BoxLiteModule | null = null;
  private loadAttempted = false;
  private loadError: Error | null = null;

  /**
   * Attempt to load the BoxLite module dynamically
   */
  private async loadModule(): Promise<BoxLiteModule | null> {
    if (this.loadAttempted) {
      return this.boxliteModule;
    }

    this.loadAttempted = true;

    // Try different possible module names in order of preference
    const possibleModules = [
      '@boxlite-ai/boxlite',           // Official npm package
      'boxlite',                        // Alias
      '@anthropic-ai/claude-sandbox',  // Anthropic internal (if available)
    ];

    for (const moduleName of possibleModules) {
      try {
        const module = await import(moduleName);
        // Check for SimpleBox class (the actual BoxLite API)
        if (module.SimpleBox || module.default?.SimpleBox) {
          this.boxliteModule = module.default || module;
          console.log('Loaded BoxLite from: ' + moduleName);
          return this.boxliteModule;
        }
      } catch (err) {
        // Module not found or failed to load, continue trying
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('Cannot find package') && !message.includes('ERR_MODULE_NOT_FOUND')) {
          // Log non-standard errors for debugging
          console.warn('Failed to load ' + moduleName + ': ' + message);
        }
      }
    }

    this.loadError = new Error(
      'BoxLite module not found. Tried: ' + possibleModules.join(', ') + '\n' +
      'Install with: npm install @boxlite-ai/boxlite\n' +
      'Requirements: macOS ARM64 (Apple Silicon) or Linux with KVM'
    );
    return null;
  }

  async create(config: SandboxConfig): Promise<ISandbox> {
    const module = await this.loadModule();
    if (!module) {
      throw new Error('BoxLite not available: ' + this.loadError?.message);
    }

    // Map SandboxConfig to SimpleBoxOptions
    const boxOptions: SimpleBoxOptions = {
      image: config.image ?? 'alpine:latest',
      memoryMib: config.memoryMib ?? 512,
      cpus: config.cpus ?? 1,
      name: config.id,
      autoRemove: true,
    };

    // Add volume mount if mountPath specified
    if (config.mountPath) {
      boxOptions.volumes = [{
        hostPath: config.mountPath,
        guestPath: '/workspace',
        readOnly: false,
      }];
    }

    // Add environment variables if specified
    if (config.env) {
      boxOptions.env = config.env;
    }

    const startTime = performance.now();
    
    // Create SimpleBox instance
    const instance = new module.SimpleBox(boxOptions);
    
    // SimpleBox starts automatically on first exec, but we'll do a probe
    // to ensure it's ready and measure startup time
    try {
      await instance.exec('true');
    } catch (err) {
      // Cleanup on failure
      try { await instance.stop(); } catch (e) { /* ignore */ }
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new Error('BoxLite failed to start: ' + errMsg);
    }
    
    const startupMs = performance.now() - startTime;

    return new BoxLiteSandbox({
      id: config.id,
      instance,
      sshPort: config.sshPort ?? 0,
      mountPath: config.mountPath,
      startupMs,
    });
  }

  async isAvailable(): Promise<boolean> {
    const module = await this.loadModule();
    if (!module) {
      return false;
    }

    // Try to verify the native bindings are working
    try {
      // Check if SimpleBox constructor exists and is callable
      if (typeof module.SimpleBox !== 'function') {
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  async getInfo(): Promise<ProviderInfo> {
    const module = await this.loadModule();
    const available = module !== null;

    return {
      name: 'boxlite',
      version: available ? '0.1.6' : 'unavailable',
      isolationType: 'microvm',
      features: available ? [
        'hardware-vm',
        'hypervisor-framework',
        'oci-images',
        'volume-mounts',
        'port-forwarding',
        'fast-startup',
      ] : [],
    };
  }

  /**
   * Get the last load error if BoxLite failed to load
   */
  getLoadError(): Error | null {
    return this.loadError;
  }
}
