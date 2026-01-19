import type { Scenario, ScenarioContext } from '../types.js';

/**
 * Measures exec latency for a simple echo command
 */
export const execLatency: Scenario = {
  name: 'exec-latency',
  description: 'Round-trip time for echo command via direct exec',
  unit: 'ms',
  async run(ctx: ScenarioContext): Promise<number> {
    if (!ctx.sandbox) throw new Error('Sandbox required');

    const startTime = performance.now();
    await ctx.sandbox.exec('echo', ['test']);
    return performance.now() - startTime;
  },
};

/**
 * Measures SSH exec latency
 */
export const sshExecLatency: Scenario = {
  name: 'ssh-exec-latency',
  description: 'Round-trip time for echo command via SSH',
  unit: 'ms',
  async run(ctx: ScenarioContext): Promise<number> {
    if (!ctx.sandbox) throw new Error('Sandbox required');

    const startTime = performance.now();
    await ctx.sandbox.sshExec('echo test');
    return performance.now() - startTime;
  },
};

/**
 * Measures Node.js invocation time
 */
export const nodeVersion: Scenario = {
  name: 'node-invocation',
  description: 'Time to run node --version',
  unit: 'ms',
  async run(ctx: ScenarioContext): Promise<number> {
    if (!ctx.sandbox) throw new Error('Sandbox required');

    const startTime = performance.now();
    await ctx.sandbox.sshExec('node --version');
    return performance.now() - startTime;
  },
};

/**
 * Measures Claude CLI invocation time
 */
export const claudeVersion: Scenario = {
  name: 'claude-invocation',
  description: 'Time to run claude --version',
  unit: 'ms',
  async run(ctx: ScenarioContext): Promise<number> {
    if (!ctx.sandbox) throw new Error('Sandbox required');

    const startTime = performance.now();
    await ctx.sandbox.sshExec('claude --version');
    return performance.now() - startTime;
  },
};
