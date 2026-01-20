/**
 * Apple Container CLI types
 *
 * Apple Container is the native container runtime in macOS 26 (Tahoe)
 * It provides:
 * - Full VM isolation per container
 * - Native SSH support via --ssh flag
 * - virtiofs mounts with -v flag
 * - Sub-second startup times
 */

export interface AppleContainerConfig {
  /** Container image (e.g., 'node:22-slim') */
  image: string;
  /** Memory limit (e.g., '2g') */
  memory?: string;
  /** CPU count */
  cpus?: number;
  /** Enable SSH access (--ssh flag) */
  ssh?: boolean;
  /** Volume mounts: { hostPath: containerPath } */
  volumes?: Record<string, string>;
  /** Working directory inside container */
  workdir?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Container name */
  name?: string;
  /** Remove container on exit */
  rm?: boolean;
  /** Run interactively */
  interactive?: boolean;
  /** Allocate TTY */
  tty?: boolean;
  /** User ID to run as (--uid flag) */
  uid?: number;
  /** Group ID to run as (--gid flag) */
  gid?: number;
  /** Username for display (informational) */
  username?: string;
}

export interface ContainerInfo {
  /** Container ID */
  id: string;
  /** Container name */
  name: string;
  /** Container image */
  image: string;
  /** Container status */
  status: 'running' | 'stopped' | 'created' | 'unknown';
  /** SSH port if enabled */
  sshPort?: number;
}

/**
 * Result from container CLI commands
 */
export interface ContainerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
