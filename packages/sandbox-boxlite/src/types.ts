/**
 * BoxLite-specific types and interfaces
 * Updated to match @boxlite-ai/boxlite SDK v0.1.6
 * 
 * Note: BoxLite uses lazy initialization - the VM is only created on first exec()
 */

/**
 * Volume mount configuration
 */
export interface VolumeMount {
  hostPath: string;
  guestPath: string;
  readOnly?: boolean;
}

/**
 * Port mapping configuration
 */
export interface PortMapping {
  hostPort: number;
  guestPort: number;
}

/**
 * SimpleBox configuration options
 */
export interface SimpleBoxOptions {
  /** OCI image name (e.g., 'alpine:latest', 'python:slim') */
  image: string;
  /** Memory limit in MiB */
  memoryMib?: number;
  /** Number of CPU cores */
  cpus?: number;
  /** Optional container name */
  name?: string;
  /** Auto-remove on stop (default: true) */
  autoRemove?: boolean;
  /** Working directory inside container */
  workingDir?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Volume mounts */
  volumes?: VolumeMount[];
  /** Port mappings */
  ports?: PortMapping[];
}

/**
 * Execution result from SimpleBox.exec()
 */
export interface BoxLiteExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * SimpleBox instance interface
 * 
 * Note: The `id` property is only available after the first exec() call
 * due to lazy initialization. Use getId() for async access.
 */
export interface SimpleBoxInstance {
  /** 
   * Unique box ID (ULID) - only available after first exec()
   * Throws "Box not yet created" if accessed before exec()
   */
  readonly id: string;
  /** Optional name */
  readonly name?: string;
  /** Execute command in the box (triggers VM creation on first call) */
  exec(cmd: string, ...args: string[]): Promise<BoxLiteExecResult>;
  /** Stop and clean up the box */
  stop(): Promise<void>;
  /** Get box metadata */
  info(): Record<string, unknown>;
  /** Async method to get ID (waits for VM creation if needed) */
  getId?(): Promise<string>;
}

/**
 * SimpleBox constructor type
 */
export interface SimpleBoxConstructor {
  new (options: SimpleBoxOptions): SimpleBoxInstance;
}

/**
 * CodeBox options (extends SimpleBox)
 */
export interface CodeBoxOptions {
  image?: string;
  memoryMib?: number;
  cpus?: number;
}

/**
 * CodeBox instance for Python execution
 */
export interface CodeBoxInstance extends SimpleBoxInstance {
  /** Run Python code */
  run(code: string): Promise<string>;
  /** Install a Python package */
  installPackage(pkg: string): Promise<void>;
  /** Install multiple Python packages */
  installPackages(...pkgs: string[]): Promise<void>;
}

/**
 * ComputerBox options for desktop automation
 */
export interface ComputerBoxOptions {
  cpus?: number;
  memoryMib?: number;
  guiHttpPort?: number;
  guiHttpsPort?: number;
}

/**
 * Screenshot result
 */
export interface Screenshot {
  width: number;
  height: number;
  format: string;
  data: string; // base64-encoded
}

/**
 * ComputerBox instance for desktop automation
 */
export interface ComputerBoxInstance extends SimpleBoxInstance {
  waitUntilReady(timeoutSec: number): Promise<void>;
  mouseMove(x: number, y: number): Promise<void>;
  leftClick(): Promise<void>;
  doubleClick(): Promise<void>;
  rightClick(): Promise<void>;
  leftClickDrag(startX: number, startY: number, endX: number, endY: number): Promise<void>;
  cursorPosition(): Promise<[number, number]>;
  type(text: string): Promise<void>;
  key(combo: string): Promise<void>;
  screenshot(): Promise<Screenshot>;
  scroll(x: number, y: number, direction: 'up' | 'down', clicks: number): Promise<void>;
  getScreenSize(): Promise<[number, number]>;
}

/**
 * BoxLite module exports
 */
export interface BoxLiteModule {
  SimpleBox: SimpleBoxConstructor;
  CodeBox?: new (options: CodeBoxOptions) => CodeBoxInstance;
  ComputerBox?: new (options: ComputerBoxOptions) => ComputerBoxInstance;
  // Error classes
  BoxliteError?: new (message: string) => Error;
  ExecError?: new (message: string) => Error;
  TimeoutError?: new (message: string) => Error;
  // Native module access (advanced)
  getNativeModule?: () => unknown;
  getJsBoxlite?: () => unknown;
}

// Re-export for backward compatibility
export type BoxLiteConfig = SimpleBoxOptions;
export type BoxLiteInstance = SimpleBoxInstance;
