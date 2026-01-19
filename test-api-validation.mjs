/**
 * API Validation Test
 *
 * Tests that Claude Agent SDK and Claude Code CLI actually work
 * against the real Anthropic API in each sandbox provider.
 */
import { BoxLiteProvider } from './packages/sandbox-boxlite/dist/index.js';
import { generateSandboxId } from './packages/sandbox-core/dist/index.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable required');
  process.exit(1);
}

async function testBoxLite() {
  console.log('\n' + '='.repeat(60));
  console.log('BoxLite API Validation Test');
  console.log('='.repeat(60));

  const provider = new BoxLiteProvider();
  if (!(await provider.isAvailable())) {
    console.log('BoxLite not available');
    return null;
  }

  const id = generateSandboxId('api-test');
  console.log('Creating sandbox:', id);

  const sandbox = await provider.create({
    id,
    image: 'alpine:latest',
    mountPath: '/tmp/sandboxes/' + id + '/workspace',
    memoryMib: 2048,
    cpus: 2,
    env: {
      ANTHROPIC_API_KEY,
    },
  });

  console.log('Startup time:', sandbox.getMetrics().startupMs.toFixed(2), 'ms');

  const results = {
    provider: 'boxlite',
    startupMs: sandbox.getMetrics().startupMs,
    nodeInstall: null,
    sdkInstall: null,
    cliInstall: null,
    sdkApiCall: null,
    cliApiCall: null,
  };

  try {
    // Install Node.js
    console.log('\n[1/5] Installing Node.js...');
    let start = performance.now();
    let result = await sandbox.exec('apk', ['add', '--no-cache', 'nodejs', 'npm']);
    results.nodeInstall = { ok: result.exitCode === 0, ms: performance.now() - start };
    console.log('  Result:', result.exitCode === 0 ? 'OK' : 'FAILED', `(${results.nodeInstall.ms.toFixed(0)}ms)`);

    // Install Agent SDK
    console.log('\n[2/5] Installing Claude Agent SDK...');
    start = performance.now();
    result = await sandbox.npmInstall('@anthropic-ai/claude-agent-sdk');
    results.sdkInstall = { ok: result.exitCode === 0, ms: performance.now() - start };
    console.log('  Result:', result.exitCode === 0 ? 'OK' : 'FAILED', `(${results.sdkInstall.ms.toFixed(0)}ms)`);
    if (result.exitCode !== 0) {
      console.log('  Error:', result.stderr.slice(-200));
    }

    // Install Claude CLI
    console.log('\n[3/5] Installing Claude Code CLI...');
    start = performance.now();
    result = await sandbox.npmInstall('@anthropic-ai/claude-code', true);
    results.cliInstall = { ok: result.exitCode === 0, ms: performance.now() - start };
    console.log('  Result:', result.exitCode === 0 ? 'OK' : 'FAILED', `(${results.cliInstall.ms.toFixed(0)}ms)`);

    // TEST: Agent SDK API call
    console.log('\n[4/5] Testing Agent SDK API call...');
    const sdkTestScript = `
const { query } = require('@anthropic-ai/claude-agent-sdk');

async function test() {
  const start = Date.now();
  const q = query({
    prompt: 'Respond with exactly one word: WORKING',
    options: { tools: [], maxTurns: 1 }
  });

  let response = '';
  for await (const msg of q) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text') response += block.text;
      }
    }
  }

  console.log(JSON.stringify({
    success: response.includes('WORKING'),
    response: response.trim(),
    durationMs: Date.now() - start
  }));
}

test().catch(e => {
  console.log(JSON.stringify({ success: false, error: e.message }));
  process.exit(1);
});
`;

    // Write test script to workspace
    await sandbox.exec('sh', ['-c', `cat > /workspace/sdk-test.js << 'SCRIPT'
${sdkTestScript}
SCRIPT`]);

    start = performance.now();
    result = await sandbox.execWithNpmPath('cd /workspace && node sdk-test.js');
    const sdkDuration = performance.now() - start;

    console.log('  Raw output:', result.stdout);
    try {
      const sdkResult = JSON.parse(result.stdout.split('\n').pop() || '{}');
      results.sdkApiCall = {
        ok: sdkResult.success === true,
        response: sdkResult.response,
        ms: sdkResult.durationMs || sdkDuration,
        error: sdkResult.error,
      };
      console.log('  Success:', sdkResult.success);
      console.log('  Response:', sdkResult.response);
      console.log('  API Duration:', results.sdkApiCall.ms.toFixed(0), 'ms');
    } catch (e) {
      results.sdkApiCall = { ok: false, error: result.stderr || result.stdout, ms: sdkDuration };
      console.log('  FAILED:', result.stderr || result.stdout);
    }

    // TEST: Claude CLI API call
    console.log('\n[5/5] Testing Claude Code CLI API call...');
    start = performance.now();
    result = await sandbox.execWithNpmPath(
      'claude -p "Respond with exactly one word: WORKING" --max-turns 1 --output-format text 2>&1'
    );
    const cliDuration = performance.now() - start;

    const cliOutput = result.stdout.trim();
    const cliSuccess = cliOutput.includes('WORKING');
    results.cliApiCall = {
      ok: cliSuccess,
      response: cliOutput.slice(0, 100),
      ms: cliDuration,
    };
    console.log('  Success:', cliSuccess);
    console.log('  Response:', cliOutput.slice(0, 100));
    console.log('  Duration:', cliDuration.toFixed(0), 'ms');

  } finally {
    await sandbox.stop();
  }

  return results;
}

async function main() {
  console.log('Claude API Validation Test');
  console.log('Testing that tools actually work against the Anthropic API\n');

  const allResults = [];

  // Test BoxLite
  const boxliteResults = await testBoxLite();
  if (boxliteResults) {
    allResults.push(boxliteResults);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  for (const r of allResults) {
    console.log(`\n${r.provider.toUpperCase()}:`);
    console.log(`  VM Startup:     ${r.startupMs?.toFixed(0) ?? 'N/A'} ms`);
    console.log(`  Node Install:   ${r.nodeInstall?.ok ? '✅' : '❌'} (${r.nodeInstall?.ms?.toFixed(0) ?? 'N/A'} ms)`);
    console.log(`  SDK Install:    ${r.sdkInstall?.ok ? '✅' : '❌'} (${r.sdkInstall?.ms?.toFixed(0) ?? 'N/A'} ms)`);
    console.log(`  CLI Install:    ${r.cliInstall?.ok ? '✅' : '❌'} (${r.cliInstall?.ms?.toFixed(0) ?? 'N/A'} ms)`);
    console.log(`  SDK API Call:   ${r.sdkApiCall?.ok ? '✅' : '❌'} (${r.sdkApiCall?.ms?.toFixed(0) ?? 'N/A'} ms)`);
    console.log(`  CLI API Call:   ${r.cliApiCall?.ok ? '✅' : '❌'} (${r.cliApiCall?.ms?.toFixed(0) ?? 'N/A'} ms)`);

    if (r.sdkApiCall?.error) {
      console.log(`  SDK Error: ${r.sdkApiCall.error}`);
    }
  }

  // Output JSON for programmatic use
  console.log('\n--- JSON Results ---');
  console.log(JSON.stringify(allResults, null, 2));
}

main().catch(console.error);
