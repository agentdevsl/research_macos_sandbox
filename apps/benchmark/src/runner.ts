import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ISandboxProvider,
  SandboxOrchestrator,
  generateSandboxId,
  calculateStats,
  formatMs,
} from '@sandbox/core';
import type { BenchmarkConfig, Scenario, ScenarioContext, ScenarioResult } from './types.js';
import { getScenarios } from './scenarios/index.js';

export class BenchmarkRunner {
  private readonly config: BenchmarkConfig;
  private readonly providers = new Map<string, ISandboxProvider>();
  private results: ScenarioResult[] = [];

  constructor(config: BenchmarkConfig) {
    this.config = config;
  }

  registerProvider(provider: ISandboxProvider): void {
    this.providers.set(provider.name, provider);
  }

  async run(): Promise<ScenarioResult[]> {
    const scenarios = getScenarios(this.config.concurrentCounts);
    this.results = [];

    for (const providerName of this.config.providers) {
      const provider = this.providers.get(providerName);
      if (!provider) {
        console.warn(`Provider not registered: ${providerName}`);
        continue;
      }

      if (!(await provider.isAvailable())) {
        console.warn(`Provider not available: ${providerName}`);
        continue;
      }

      console.log(`\n=== Benchmarking: ${providerName} ===\n`);

      for (const scenario of scenarios) {
        const result = await this.runScenario(provider, providerName, scenario);
        this.results.push(result);
      }
    }

    return this.results;
  }

  private async runScenario(
    provider: ISandboxProvider,
    providerName: string,
    scenario: Scenario
  ): Promise<ScenarioResult> {
    console.log(`Running: ${scenario.name}`);
    if (this.config.verbose) {
      console.log(`  ${scenario.description}`);
    }

    const ctx: ScenarioContext = {
      provider,
      providerName,
      config: this.config,
    };

    const values: number[] = [];
    let sandbox;
    const orchestrator = new SandboxOrchestrator();
    orchestrator.registerProvider(provider);

    // Setup shared sandbox for non-managing scenarios
    if (!scenario.managesSandbox) {
      const sandboxId = generateSandboxId('bench-shared');
      sandbox = await orchestrator.createSandbox(providerName, {
        id: sandboxId,
        image: 'alpine:latest',
      });
      ctx.sandbox = sandbox;

      // Warmup SSH connection
      await sandbox.sshExec('echo warmup');
    }

    try {
      // Warmup iterations
      for (let i = 0; i < this.config.warmupIterations; i++) {
        await scenario.run(ctx);
      }

      // Measured iterations
      for (let i = 0; i < this.config.iterations; i++) {
        const value = await scenario.run(ctx);
        values.push(value);

        if (this.config.verbose) {
          console.log(`  [${i + 1}/${this.config.iterations}] ${value.toFixed(2)}${scenario.unit}`);
        }
      }
    } finally {
      // Cleanup shared sandbox
      if (sandbox) {
        await sandbox.stop();
        await orchestrator.cleanupMount(sandbox.id);
      }
    }

    const stats = calculateStats(values);

    console.log(`  Mean: ${formatMs(stats.mean)} | P50: ${formatMs(stats.p50)} | P95: ${formatMs(stats.p95)}\n`);

    return {
      scenario: scenario.name,
      provider: providerName,
      iterations: this.config.iterations,
      values,
      stats,
      unit: scenario.unit,
      timestamp: new Date().toISOString(),
      metadata: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
      },
    };
  }

  async saveResults(): Promise<string> {
    await mkdir(this.config.outputDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `benchmark-${timestamp}.json`;
    const filepath = join(this.config.outputDir, filename);

    const output = {
      config: this.config,
      results: this.results,
      summary: this.generateSummary(),
    };

    await writeFile(filepath, JSON.stringify(output, null, 2));
    console.log(`\nResults saved to: ${filepath}`);

    return filepath;
  }

  private generateSummary(): Record<string, Record<string, { mean: number; p50: number; p95: number }>> {
    const summary: Record<string, Record<string, { mean: number; p50: number; p95: number }>> = {};

    for (const result of this.results) {
      const scenarioSummary = summary[result.scenario] ?? {};
      scenarioSummary[result.provider] = {
        mean: result.stats.mean,
        p50: result.stats.p50,
        p95: result.stats.p95,
      };
      summary[result.scenario] = scenarioSummary;
    }

    return summary;
  }

  printSummaryTable(): void {
    console.log('\n=== Summary ===\n');

    const providers = this.config.providers;
    const scenarios = [...new Set(this.results.map(r => r.scenario))];

    // Header
    const header = ['Scenario', ...providers].map(h => h.padEnd(20)).join(' | ');
    console.log(header);
    console.log('-'.repeat(header.length));

    // Rows
    for (const scenario of scenarios) {
      const row = [scenario.padEnd(20)];

      for (const provider of providers) {
        const result = this.results.find(r => r.scenario === scenario && r.provider === provider);
        if (result) {
          row.push(`${result.stats.mean.toFixed(2)}ms`.padEnd(20));
        } else {
          row.push('N/A'.padEnd(20));
        }
      }

      console.log(row.join(' | '));
    }
  }
}
