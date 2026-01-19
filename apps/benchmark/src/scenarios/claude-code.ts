import type { Scenario, ScenarioContext } from '../types.js';

/**
 * Measures Claude Code CLI version check time
 */
export const claudeCodeVersion: Scenario = {
  name: 'claude-code-version',
  description: 'Time to run claude --version',
  unit: 'ms',
  async run(ctx: ScenarioContext): Promise<number> {
    if (!ctx.sandbox) throw new Error('Sandbox required');

    const startTime = performance.now();
    const result = await ctx.sandbox.sshExec('claude --version');
    const duration = performance.now() - startTime;

    if (result.exitCode !== 0) {
      console.warn('Claude CLI not available:', result.stderr);
      return 0;
    }

    console.log('  Claude version:', result.stdout.trim());
    return duration;
  },
};

/**
 * Measures Claude Code CLI prompt execution time
 */
export const claudeCodePrompt: Scenario = {
  name: 'claude-code-prompt',
  description: 'Time for Claude Code CLI to execute a simple prompt',
  unit: 'ms',
  async run(ctx: ScenarioContext): Promise<number> {
    if (!ctx.sandbox) throw new Error('Sandbox required');

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn('ANTHROPIC_API_KEY not set, skipping');
      return 0;
    }

    const startTime = performance.now();
    const result = await ctx.sandbox.sshExec(
      `ANTHROPIC_API_KEY="${apiKey}" claude -p "Say OK" --max-turns 1 --output-format text`
    );
    const duration = performance.now() - startTime;

    if (result.exitCode !== 0) {
      console.warn('Claude prompt failed:', result.stderr);
    }

    return duration;
  },
};

export const claudeCodeScenarios = [claudeCodeVersion, claudeCodePrompt];
