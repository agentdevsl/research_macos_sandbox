import { generateSandboxId, SandboxOrchestrator } from '@sandbox/core';
import type { Scenario, ScenarioContext } from '../types.js';

/**
 * Creates a scenario for launching N concurrent instances
 */
export function createConcurrentScenario(count: number): Scenario {
  return {
    name: `concurrent-${count}`,
    description: `Time to create ${count} concurrent instances`,
    unit: 'ms',
    managesSandbox: true,
    async run(ctx: ScenarioContext): Promise<number> {
      const orchestrator = new SandboxOrchestrator();
      orchestrator.registerProvider(ctx.provider);

      const sandboxIds: string[] = [];
      const startTime = performance.now();

      // Create all instances concurrently
      const createPromises = Array.from({ length: count }, async (_, i) => {
        const sandboxId = generateSandboxId(`bench-${i}`);
        sandboxIds.push(sandboxId);

        return orchestrator.createSandbox(ctx.providerName, {
          id: sandboxId,
          image: 'alpine:latest',
        });
      });

      const sandboxes = await Promise.all(createPromises);
      const duration = performance.now() - startTime;

      // Cleanup all instances
      await Promise.all(sandboxes.map(s => s.stop()));
      await Promise.all(sandboxIds.map(id => orchestrator.cleanupMount(id)));

      return duration;
    },
  };
}

/**
 * Measures memory usage per instance
 */
export const memoryPerInstance: Scenario = {
  name: 'memory-per-instance',
  description: 'Memory usage in MB for a single instance',
  unit: 'MB',
  async run(ctx: ScenarioContext): Promise<number> {
    if (!ctx.sandbox) throw new Error('Sandbox required');

    const metrics = ctx.sandbox.getMetrics();
    return metrics.memoryBytes / (1024 * 1024);
  },
};
