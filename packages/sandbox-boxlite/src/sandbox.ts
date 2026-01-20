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
  /** Run commands as this user instead of root */
  runAsUser?: {
    name: string;
    uid: number;
    gid: number;
    home: string;
  } | undefined;
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
  private runAsUser: { name: string; uid: number; gid: number; home: string } | undefined;
  private userSetupComplete = false;

  constructor(options: BoxLiteSandboxOptions) {
    this.id = options.id;
    this.instance = options.instance;
    this.sshPort = options.sshPort;
    this.mountPath = options.mountPath;
    this.initializeNpmOnStart = options.initializeNpm ?? true;
    this.runAsUser = options.runAsUser;
    this.metrics = {
      startupMs: options.startupMs,
      sshReadyMs: 0,
      execLatencyMs: 0,
      memoryBytes: 0,
    };
  }

  /**
   * Set up non-root user environment (Alpine Linux style)
   */
  async setupUser(): Promise<void> {
    if (!this.runAsUser || this.userSetupComplete) return;

    const { name, uid, gid, home } = this.runAsUser;

    // Alpine uses adduser/addgroup instead of useradd/groupadd
    // Run these commands as root (before user switching is active)
    const setupScript = `
      # Create group
      addgroup -g ${gid} ${name} 2>/dev/null || true
      # Create user with home directory
      adduser -D -u ${uid} -G ${name} -h ${home} -s /bin/sh ${name} 2>/dev/null || true
      # Ensure home exists with correct ownership
      mkdir -p ${home}
      chown -R ${uid}:${gid} ${home}
      # Create .claude directory
      mkdir -p ${home}/.claude
      chown ${uid}:${gid} ${home}/.claude
      chmod 700 ${home}/.claude
      # Create npm cache directory with correct ownership
      mkdir -p ${home}/.npm
      chown -R ${uid}:${gid} ${home}/.npm
      # Give user ownership of workspace and all its contents
      chown -R ${uid}:${gid} /workspace
    `;

    await this.instance.exec('sh', '-c', setupScript.trim());
    this.userSetupComplete = true;
  }

  /**
   * Wrap a command to run as the configured user
   */
  private wrapCommandForUser(cmd: string, args: string[]): { cmd: string; args: string[] } {
    if (!this.runAsUser || !this.userSetupComplete) {
      return { cmd, args };
    }

    // Combine cmd and args into a single command string, then wrap with su
    const fullCmd = args.length > 0 ? `${cmd} ${args.join(' ')}` : cmd;
    const home = this.runAsUser.home;

    // Use su with proper environment setup
    return {
      cmd: 'su',
      args: [
        '-s', '/bin/sh',
        this.runAsUser.name,
        '-c',
        `export HOME=${home} && export PATH=/workspace/.npm-global/bin:$PATH && cd /workspace && ${fullCmd}`
      ]
    };
  }

  /**
   * Execute a command as root, bypassing user switching.
   * Use this for system-level operations like package installation.
   */
  async execAsRoot(cmd: string, args: string[] = []): Promise<ExecResult> {
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
      // Don't wrap with user switching
      const result = await this.instance.exec(cmd, ...args);
      const durationMs = performance.now() - startTime;

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
      // Create directories - use execAsRoot to ensure proper permissions
      await this.execAsRoot('mkdir', ['-p', '/workspace/node_modules']);
      await this.execAsRoot('mkdir', ['-p', '/workspace/.npm-global/bin']);

      // If running as non-root user, set ownership
      if (this.runAsUser) {
        const { uid, gid } = this.runAsUser;
        await this.execAsRoot('chown', ['-R', `${uid}:${gid}`, '/workspace']);
      }

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
      // Wrap command to run as user if configured
      const wrapped = this.wrapCommandForUser(cmd, args);

      // SimpleBox.exec takes command and args separately
      const result = await this.instance.exec(wrapped.cmd, ...wrapped.args);
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
