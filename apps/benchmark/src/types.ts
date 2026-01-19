import type { ISandbox, ISandboxProvider, BenchmarkResult } from '@sandbox/core';

export interface BenchmarkConfig {
  /** Providers to benchmark */
  providers: string[];
  /** Number of iterations per scenario */
  iterations: number;
  /** Warmup iterations (not counted) */
  warmupIterations: number;
  /** Output directory for results */
  outputDir: string;
  /** Verbose output */
  verbose: boolean;
  /** Concurrent instance counts to test */
  concurrentCounts: number[];
}

export interface ScenarioContext {
  provider: ISandboxProvider;
  providerName: string;
  config: BenchmarkConfig;
  sandbox?: ISandbox;
}

export interface ScenarioResult extends BenchmarkResult {
  timestamp: string;
  metadata: {
    nodeVersion: string;
    platform: string;
    arch: string;
  };
}

export type ScenarioFn = (ctx: ScenarioContext) => Promise<number>;

export interface Scenario {
  name: string;
  description: string;
  unit: string;
  /** If true, scenario manages its own sandbox lifecycle */
  managesSandbox?: boolean;
  run: ScenarioFn;
}
