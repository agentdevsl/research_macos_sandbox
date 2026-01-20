/**
 * User configuration for running sandbox as non-root
 */
export interface SandboxUser {
  /** Username */
  name: string;
  /** User ID (default: 1000) */
  uid?: number;
  /** Group ID (default: 1000) */
  gid?: number;
  /** Home directory (default: /home/{name}) */
  home?: string;
}

/**
 * Configuration for creating a sandbox instance
 */
export interface SandboxConfig {
  /** Unique identifier for this sandbox */
  id: string;
  /** Container/VM image to use */
  image: string;
  /** Host path to mount as /workspace in sandbox */
  mountPath: string;
  /** SSH port (0 = auto-assign) */
  sshPort?: number;
  /** Memory limit in MiB */
  memoryMib?: number;
  /** CPU count */
  cpus?: number;
  /** Environment variables to pass */
  env?: Record<string, string>;
  /** Run as non-root user (recommended for SDK with bypassPermissions) */
  user?: SandboxUser;
}

/**
 * Result of executing a command in the sandbox
 */
export interface ExecResult {
  /** Exit code */
  exitCode: number;
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Execution time in milliseconds */
  durationMs: number;
}

/**
 * Performance metrics for a sandbox instance
 */
export interface SandboxMetrics {
  /** Time from create() call to sandbox ready */
  startupMs: number;
  /** Time for SSH to become available */
  sshReadyMs: number;
  /** Average exec latency (ms) */
  execLatencyMs: number;
  /** Memory usage in bytes */
  memoryBytes: number;
}

/**
 * Sandbox instance interface
 */
export interface ISandbox {
  /** Unique sandbox identifier */
  readonly id: string;
  /** SSH port for external access */
  readonly sshPort: number;
  /** Host mount path */
  readonly mountPath: string;
  /** Provider name (orbstack, boxlite, libkrun) */
  readonly provider: string;

  /**
   * Execute command directly in sandbox
   */
  exec(cmd: string, args?: string[]): Promise<ExecResult>;

  /**
   * Execute command via SSH connection
   */
  sshExec(cmd: string): Promise<ExecResult>;

  /**
   * Get current metrics
   */
  getMetrics(): SandboxMetrics;

  /**
   * Stop and cleanup sandbox
   */
  stop(): Promise<void>;

  /**
   * Check if sandbox is running
   */
  isRunning(): Promise<boolean>;
}

/**
 * Sandbox provider interface for different implementations
 */
export interface ISandboxProvider {
  /** Provider name */
  readonly name: string;

  /**
   * Create a new sandbox instance
   */
  create(config: SandboxConfig): Promise<ISandbox>;

  /**
   * Check if provider is available on this system
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get provider-specific info
   */
  getInfo(): Promise<ProviderInfo>;
}

/**
 * Provider information
 */
export interface ProviderInfo {
  name: string;
  version: string;
  isolationType: 'container' | 'microvm' | 'vm';
  features: string[];
}

/**
 * Benchmark result for a single scenario
 */
export interface BenchmarkResult {
  scenario: string;
  provider: string;
  iterations: number;
  values: number[];
  stats: {
    mean: number;
    median: number;
    p50: number;
    p95: number;
    p99: number;
    min: number;
    max: number;
    stdDev: number;
  };
  unit: string;
}

/**
 * Benchmark scenario definition
 */
export interface BenchmarkScenario {
  name: string;
  description: string;
  iterations: number;
  warmupIterations: number;
  run(sandbox: ISandbox): Promise<number>;
}
