import type { Scenario } from '../types.js';
import { coldStartup, sshReady } from './startup.js';
import { execLatency, sshExecLatency, nodeVersion, claudeVersion } from './exec.js';
import { createConcurrentScenario, memoryPerInstance } from './concurrent.js';
import { sdkApiCall, sdkInstallTime, sdkFixtureTest } from './sdk.js';
import { claudeCodeScenarios } from './claude-code.js';

export const defaultScenarios: Scenario[] = [
  coldStartup,
  sshReady,
  execLatency,
  sshExecLatency,
  nodeVersion,
  claudeVersion,
  memoryPerInstance,
];

/** SDK scenarios that require ANTHROPIC_API_KEY */
export const sdkScenarios: Scenario[] = [
  sdkApiCall,
  sdkInstallTime,
  sdkFixtureTest,
];

/** Claude Code CLI scenarios that require ANTHROPIC_API_KEY for prompt tests */
export { claudeCodeScenarios };

export function getScenarios(concurrentCounts: number[], includeSDK: boolean = false): Scenario[] {
  const scenarios = [
    ...defaultScenarios,
    ...concurrentCounts.map(createConcurrentScenario),
  ];

  if (includeSDK && process.env.ANTHROPIC_API_KEY) {
    scenarios.push(...sdkScenarios);
  }

  return scenarios;
}

export * from './startup.js';
export * from './exec.js';
export * from './concurrent.js';
export * from './sdk.js';
export * from './claude-code.js';
