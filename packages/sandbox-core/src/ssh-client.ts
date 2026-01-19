import { Client, type ConnectConfig } from 'ssh2';
import type { ExecResult } from './types.js';

export interface SSHClientConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string | Buffer;
  readyTimeout?: number;
}

interface InternalSSHConfig {
  host: string;
  port: number;
  username: string;
  readyTimeout: number;
  password: string | null;
  privateKey: string | Buffer | null;
}

/**
 * SSH client wrapper for sandbox communication
 */
export class SSHClient {
  private client: Client | null = null;
  private readonly config: InternalSSHConfig;

  constructor(config: SSHClientConfig) {
    this.config = {
      host: config.host,
      port: config.port,
      username: config.username,
      readyTimeout: config.readyTimeout ?? 10000,
      password: config.password ?? null,
      privateKey: config.privateKey ?? null,
    };
  }

  /**
   * Connect to SSH server
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client = new Client();

      const connectConfig: ConnectConfig = {
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        readyTimeout: this.config.readyTimeout,
      };

      if (this.config.password !== null) {
        connectConfig.password = this.config.password;
      }
      if (this.config.privateKey !== null) {
        connectConfig.privateKey = this.config.privateKey;
      }

      this.client.on('ready', () => resolve());
      this.client.on('error', (err) => reject(err));
      this.client.connect(connectConfig);
    });
  }

  /**
   * Execute command via SSH
   */
  async exec(command: string): Promise<ExecResult> {
    if (!this.client) {
      throw new Error('SSH client not connected');
    }

    const startTime = performance.now();

    return new Promise((resolve, reject) => {
      this.client!.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on('close', (code: number) => {
          const durationMs = performance.now() - startTime;
          resolve({
            exitCode: code ?? 0,
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
            durationMs,
          });
        });

        stream.on('error', reject);
      });
    });
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.client !== null;
  }

  /**
   * Disconnect from SSH server
   */
  disconnect(): void {
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }
}

/**
 * Wait for SSH to become available with retries
 */
export async function waitForSSH(
  config: SSHClientConfig,
  options: { maxRetries?: number; retryDelayMs?: number } = {}
): Promise<SSHClient> {
  const { maxRetries = 30, retryDelayMs = 1000 } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const client = new SSHClient(config);
    try {
      await client.connect();
      return client;
    } catch (err) {
      client.disconnect();
      if (attempt === maxRetries) {
        throw new Error(`SSH not available after ${maxRetries} attempts: ${err}`);
      }
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error('SSH connection failed');
}
