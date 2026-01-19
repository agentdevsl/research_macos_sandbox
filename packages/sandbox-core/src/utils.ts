import { randomBytes } from 'node:crypto';

/**
 * Generate a unique sandbox ID
 */
export function generateSandboxId(prefix = 'sandbox'): string {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(4).toString('hex');
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Calculate statistics from an array of numbers
 */
export function calculateStats(values: number[]): {
  mean: number;
  median: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  stdDev: number;
} {
  if (values.length === 0) {
    throw new Error('Cannot calculate stats on empty array');
  }

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;

  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);

  const percentile = (p: number): number => {
    const index = Math.ceil((p / 100) * n) - 1;
    return sorted[Math.max(0, Math.min(index, n - 1))]!;
  };

  return {
    mean,
    median: percentile(50),
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
    min: sorted[0]!,
    max: sorted[n - 1]!,
    stdDev,
  };
}

/**
 * Format milliseconds to human-readable string
 */
export function formatMs(ms: number): string {
  if (ms < 1) {
    return `${(ms * 1000).toFixed(2)}µs`;
  }
  if (ms < 1000) {
    return `${ms.toFixed(2)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffFactor?: number;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 100,
    maxDelayMs = 10000,
    backoffFactor = 2,
  } = options;

  let lastError: Error | undefined;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        await sleep(delay);
        delay = Math.min(delay * backoffFactor, maxDelayMs);
      }
    }
  }

  throw lastError;
}
