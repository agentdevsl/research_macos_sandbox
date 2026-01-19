import { generateSandboxId, SandboxOrchestrator } from '@sandbox/core';
import type { Scenario, ScenarioContext } from '../types.js';

/**
 * Measures cold startup time from create() to container/VM ready
 */
export const coldStartup: Scenario = {
  name: 'cold-startup',
  description: 'Time from create() call to sandbox ready',
  unit: 'ms',
  managesSandbox: true,
  async run(ctx: ScenarioContext): Promise<number> {
    const orchestrator = new SandboxOrchestrator();
    orchestrator.registerProvider(ctx.provider);

    const sandboxId = generateSandboxId('bench');
    const startTime = performance.now();

    const sandbox = await orchestrator.createSandbox(ctx.providerName, {
      id: sandboxId,
      image: 'alpine:latest',
    });

    const duration = performance.now() - startTime;

    // Cleanup
    await sandbox.stop();
    await orchestrator.cleanupMount(sandboxId);

    return duration;
  },
};

/**
 * Measures time until SSH is ready and responsive
 */
export const sshReady: Scenario = {
  name: 'ssh-ready',
  description: 'Time from create() to SSH connection established',
  unit: 'ms',
  managesSandbox: true,
  async run(ctx: ScenarioContext): Promise<number> {
    const orchestrator = new SandboxOrchestrator();
    orchestrator.registerProvider(ctx.provider);

    const sandboxId = generateSandboxId('bench');
    const startTime = performance.now();

    const sandbox = await orchestrator.createSandbox(ctx.providerName, {
      id: sandboxId,
      image: 'alpine:latest',
    });

    // First SSH command establishes connection
    await sandbox.sshExec('echo ready');

    const duration = performance.now() - startTime;

    // Cleanup
    await sandbox.stop();
    await orchestrator.cleanupMount(sandboxId);

    return duration;
  },
};
