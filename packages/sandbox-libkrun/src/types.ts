/**
 * libkrun native binding types
 */

export interface LibkrunConfig {
  /** Number of virtual CPUs (default: 1) */
  cpus?: number;
  /** Memory in MiB (default: 512) */
  memoryMib?: number;
  /** Root filesystem path */
  rootfsPath: string;
  /** Working directory inside VM */
  workdir?: string;
  /** virtiofs mounts: { tag: hostPath } */
  mounts?: Record<string, string>;
  /** Port mappings: ["hostPort:guestPort", ...] */
  portMap?: string[];
  /** Environment variables */
  env?: Record<string, string>;
}

export interface VmInfo {
  /** libkrun context ID */
  ctxId: number;
  /** vsock context ID for communication */
  cid: number;
  /** Number of CPUs */
  cpus: number;
  /** Memory in MiB */
  memoryMib: number;
}

/**
 * Native module interface (loaded from .node file)
 */
export interface LibkrunNative {
  isAvailable(): boolean;
  getVersion(): string;
  createContext(config: LibkrunConfig): VmInfo;
  startVm(ctxId: number): number;
  freeContext(ctxId: number): void;
  setExec(ctxId: number, execPath: string, args: string[], env: Record<string, string>): void;
}
