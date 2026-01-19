import type { Scenario, ScenarioContext } from '../types.js';

/**
 * Measures actual Claude SDK API call execution time inside sandbox.
 * This scenario installs the SDK and makes a real LLM API call.
 */
export const sdkApiCall: Scenario = {
  name: 'sdk-api-call',
  description: 'Time for Claude SDK API call inside sandbox',
  unit: 'ms',
  async run(ctx: ScenarioContext): Promise<number> {
    if (!ctx.sandbox) throw new Error('Sandbox required');

    // Check if ANTHROPIC_API_KEY is available
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn('ANTHROPIC_API_KEY not set, skipping SDK test');
      return 0;
    }

    const startTime = performance.now();

    // Install SDK and run test inside sandbox
    // Using a here-document style to avoid shell escaping issues
    const script = `
      cd /tmp &&
      npm init -y > /dev/null 2>&1 &&
      npm install @anthropic-ai/sdk > /dev/null 2>&1 &&
      ANTHROPIC_API_KEY="${apiKey}" node -e "
        const Anthropic = require('@anthropic-ai/sdk').default;
        const client = new Anthropic();
        const start = Date.now();
        client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 20,
          messages: [{ role: 'user', content: 'Say OK' }]
        }).then(r => {
          console.log(Date.now() - start);
        }).catch(e => {
          console.error(e.message);
          process.exit(1);
        });
      "
    `;

    const result = await ctx.sandbox.sshExec(script);

    if (result.exitCode !== 0) {
      console.error('SDK test failed:', result.stderr);
      return 0;
    }

    // Parse the duration from output
    const duration = parseFloat(result.stdout.trim());
    return isNaN(duration) ? performance.now() - startTime : duration;
  },
};

/**
 * Measures SDK installation time inside sandbox.
 * This helps understand the overhead of setting up the SDK.
 */
export const sdkInstallTime: Scenario = {
  name: 'sdk-install-time',
  description: 'Time to install Claude SDK in sandbox',
  unit: 'ms',
  async run(ctx: ScenarioContext): Promise<number> {
    if (!ctx.sandbox) throw new Error('Sandbox required');

    const startTime = performance.now();

    const script = `
      cd /tmp &&
      rm -rf sdk-test-install &&
      mkdir sdk-test-install &&
      cd sdk-test-install &&
      npm init -y > /dev/null 2>&1 &&
      npm install @anthropic-ai/sdk 2>&1 &&
      echo "INSTALL_COMPLETE"
    `;

    const result = await ctx.sandbox.sshExec(script);

    if (result.exitCode !== 0 || !result.stdout.includes('INSTALL_COMPLETE')) {
      console.error('SDK install failed:', result.stderr);
      return 0;
    }

    return performance.now() - startTime;
  },
};

/**
 * Measures end-to-end SDK test execution using the pre-built fixture.
 * This is more representative of actual agent startup performance.
 */
export const sdkFixtureTest: Scenario = {
  name: 'sdk-fixture-test',
  description: 'End-to-end SDK test using agent-test fixture',
  unit: 'ms',
  async run(ctx: ScenarioContext): Promise<number> {
    if (!ctx.sandbox) throw new Error('Sandbox required');

    // Check if ANTHROPIC_API_KEY is available
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn('ANTHROPIC_API_KEY not set, skipping SDK fixture test');
      return 0;
    }

    const startTime = performance.now();

    // Run the sdk-test from the mounted workspace
    // Assumes fixtures/agent-test is available in /workspace
    const script = `
      export ANTHROPIC_API_KEY="${apiKey}"
      cd /workspace/fixtures/agent-test 2>/dev/null || cd /tmp
      if [ -f "package.json" ]; then
        npm install > /dev/null 2>&1
        npx tsx src/sdk-test.ts
      else
        echo "Fixture not found, running inline test"
        cd /tmp
        npm init -y > /dev/null 2>&1
        npm install @anthropic-ai/sdk > /dev/null 2>&1
        node -e "
          const Anthropic = require('@anthropic-ai/sdk').default;
          const client = new Anthropic();
          const start = Date.now();
          client.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 20,
            messages: [{ role: 'user', content: 'Say OK' }]
          }).then(r => {
            console.log(JSON.stringify({success: true, apiDurationMs: Date.now() - start}));
          }).catch(e => {
            console.error(e.message);
            process.exit(1);
          });
        "
      fi
    `;

    const result = await ctx.sandbox.sshExec(script);

    if (result.exitCode !== 0) {
      console.error('SDK fixture test failed:', result.stderr);
      return 0;
    }

    // Try to parse JSON output from the test
    const lines = result.stdout.trim().split('\n');
    for (const line of lines.reverse()) {
      try {
        const json = JSON.parse(line);
        if (json.apiDurationMs !== undefined) {
          return json.apiDurationMs;
        }
      } catch {
        // Not JSON, continue
      }
    }

    return performance.now() - startTime;
  },
};
