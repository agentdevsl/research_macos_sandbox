#!/usr/bin/env node

import { Command } from 'commander';
import { OrbStackProvider } from '@sandbox/orbstack';
import { BoxLiteProvider } from '@sandbox/boxlite';
import { AppleContainerProvider } from '@sandbox/apple-container';
import { LibkrunProvider } from '@sandbox/libkrun';
import { BenchmarkRunner } from './runner.js';
import type { BenchmarkConfig } from './types.js';

const program = new Command();

program
  .name('sandbox-benchmark')
  .description('Benchmark sandbox providers for Claude Agent SDK')
  .version('0.1.0');

program
  .option('-p, --providers <providers>', 'Comma-separated list of providers to benchmark', 'orbstack')
  .option('-i, --iterations <n>', 'Number of iterations per scenario', '20')
  .option('-w, --warmup <n>', 'Number of warmup iterations', '2')
  .option('-o, --output <dir>', 'Output directory for results', './results')
  .option('-v, --verbose', 'Verbose output')
  .option('-c, --concurrent <counts>', 'Concurrent instance counts to test', '5,10')
  .action(async (options) => {
    const config: BenchmarkConfig = {
      providers: options.providers.split(',').map((p: string) => p.trim()),
      iterations: parseInt(options.iterations, 10),
      warmupIterations: parseInt(options.warmup, 10),
      outputDir: options.output,
      verbose: options.verbose ?? false,
      concurrentCounts: options.concurrent.split(',').map((c: string) => parseInt(c.trim(), 10)),
    };

    console.log('Sandbox Benchmark Suite');
    console.log('=======================\n');
    console.log('Configuration:');
    console.log(`  Providers: ${config.providers.join(', ')}`);
    console.log(`  Iterations: ${config.iterations}`);
    console.log(`  Warmup: ${config.warmupIterations}`);
    console.log(`  Concurrent counts: ${config.concurrentCounts.join(', ')}`);
    console.log('');

    const runner = new BenchmarkRunner(config);

    // Register all providers
    runner.registerProvider(new OrbStackProvider());
    runner.registerProvider(new BoxLiteProvider());
    runner.registerProvider(new AppleContainerProvider());
    runner.registerProvider(new LibkrunProvider());

    // Check which providers are available
    console.log('Checking provider availability...');
    const providers = [
      { name: 'OrbStack', instance: new OrbStackProvider() },
      { name: 'BoxLite', instance: new BoxLiteProvider() },
      { name: 'Apple Container', instance: new AppleContainerProvider() },
      { name: 'libkrun', instance: new LibkrunProvider() },
    ];

    for (const { name, instance } of providers) {
      console.log(`  ${name}: ${await instance.isAvailable() ? 'available' : 'not available'}`);
    }
    console.log('');

    try {
      await runner.run();
      runner.printSummaryTable();
      await runner.saveResults();
    } catch (err) {
      console.error('Benchmark failed:', err);
      process.exit(1);
    }
  });

program
  .command('list-providers')
  .description('List available providers')
  .action(async () => {
    console.log('Available Providers:\n');

    const providers = [
      { name: 'orbstack', instance: new OrbStackProvider() },
      { name: 'boxlite', instance: new BoxLiteProvider() },
      { name: 'apple-container', instance: new AppleContainerProvider() },
      { name: 'libkrun', instance: new LibkrunProvider() },
    ];

    for (const { name, instance } of providers) {
      const available = await instance.isAvailable();
      const info = await instance.getInfo();

      console.log(`${name}:`);
      console.log(`  Available: ${available}`);
      console.log(`  Version: ${info.version}`);
      console.log(`  Isolation: ${info.isolationType}`);
      console.log(`  Features: ${info.features.join(', ') || 'none'}`);
      console.log('');
    }
  });

program.parse();
