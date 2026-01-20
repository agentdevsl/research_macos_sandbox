/**
 * API Validation Test
 *
 * Tests that Claude Agent SDK and Claude Code CLI actually work
 * against the real Anthropic API in each sandbox provider.
 *
 * Authentication:
 * - Claude Code CLI: Uses CLAUDE_CODE_OAUTH_TOKEN (sk-ant-oat01-*) OR ANTHROPIC_API_KEY (sk-ant-api01-*)
 * - Claude Agent SDK: Requires ANTHROPIC_API_KEY (sk-ant-api01-*) - does NOT support OAuth tokens
 */
import { BoxLiteProvider } from './packages/sandbox-boxlite/dist/index.js';
import { generateSandboxId } from './packages/sandbox-core/dist/index.js';

// OAuth token for CLI (sk-ant-oat01-*)
const OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
// API key for SDK (sk-ant-api01-*)
const API_KEY = process.env.ANTHROPIC_API_KEY;

// Detect token type
function getTokenType(token) {
  if (!token) return 'none';
  if (token.startsWith('sk-ant-oat01-')) return 'oauth';
  if (token.startsWith('sk-ant-api01-')) return 'api-key';
  return 'unknown';
}

const oauthType = getTokenType(OAUTH_TOKEN);
const apiKeyType = getTokenType(API_KEY);

console.log('Authentication Configuration:');
console.log(`  ANTHROPIC_API_KEY: ${apiKeyType} (${API_KEY ? API_KEY.slice(0, 20) + '...' : 'not set'})`);
console.log(`  CLAUDE_CODE_OAUTH_TOKEN: ${oauthType} (${OAUTH_TOKEN ? OAUTH_TOKEN.slice(0, 20) + '...' : 'not set'})`);
console.log('');

if (!OAUTH_TOKEN && !API_KEY) {
  console.error('ERROR: No authentication token found');
  console.log('\nRequired environment variables:');
  console.log('  - CLAUDE_CODE_OAUTH_TOKEN (sk-ant-oat01-*) for CLI');
  console.log('  - ANTHROPIC_API_KEY (sk-ant-api01-*) for SDK');
  process.exit(1);
}

// Determine what we can test
const canTestCLI = oauthType === 'oauth' || apiKeyType === 'api-key';
const canTestSDK = apiKeyType === 'api-key';

console.log('Test capabilities:');
console.log(`  CLI API test: ${canTestCLI ? '✅ Can test' : '❌ Need OAuth token or API key'}`);
console.log(`  SDK API test: ${canTestSDK ? '✅ Can test' : '❌ Need API key (sk-ant-api01-*), OAuth tokens not supported'}`);
console.log('');

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

  // Pass appropriate environment variables based on token type
  const envVars = {};
  if (oauthType === 'oauth') {
    envVars.CLAUDE_CODE_OAUTH_TOKEN = OAUTH_TOKEN;
  }
  if (apiKeyType === 'api-key') {
    envVars.ANTHROPIC_API_KEY = API_KEY;
  }

  const sandbox = await provider.create({
    id,
    image: 'alpine:latest',
    mountPath: '/tmp/sandboxes/' + id + '/workspace',
    memoryMib: 2048,
    cpus: 2,
    env: envVars,
  });

  console.log('Startup time:', sandbox.getMetrics().startupMs.toFixed(2), 'ms');

  const results = {
    provider: 'boxlite',
    startupMs: sandbox.getMetrics().startupMs,
    nodeInstall: null,
    cliInstall: null,
    cliApiCall: null,
    sdkInstall: null,
    sdkApiCall: null,
  };

  try {
    // Install Node.js
    console.log('\n[1/5] Installing Node.js...');
    let start = performance.now();
    let result = await sandbox.exec('apk', ['add', '--no-cache', 'nodejs', 'npm']);
    results.nodeInstall = { ok: result.exitCode === 0, ms: performance.now() - start };
    console.log('  Result:', result.exitCode === 0 ? 'OK' : 'FAILED', `(${results.nodeInstall.ms.toFixed(0)}ms)`);

    // Install Claude CLI
    console.log('\n[2/5] Installing Claude Code CLI...');
    start = performance.now();
    result = await sandbox.npmInstall('@anthropic-ai/claude-code', true);
    results.cliInstall = { ok: result.exitCode === 0, ms: performance.now() - start };
    console.log('  Result:', result.exitCode === 0 ? 'OK' : 'FAILED', `(${results.cliInstall.ms.toFixed(0)}ms)`);

    // TEST: Claude CLI API call
    if (canTestCLI) {
      console.log('\n[3/5] Testing Claude Code CLI API call...');

      // Check which env var is set in sandbox
      result = await sandbox.exec('sh', ['-c', 'echo "OAUTH: ${CLAUDE_CODE_OAUTH_TOKEN:0:20}... API: ${ANTHROPIC_API_KEY:0:20}..."']);
      console.log('  Env check:', result.stdout);

      start = performance.now();
      result = await sandbox.execWithNpmPath(
        'timeout 60 claude -p "Reply with exactly one word: WORKING" --max-turns 1 --output-format text 2>&1 || echo "EXIT_CODE:$?"'
      );
      const cliDuration = performance.now() - start;

      const cliOutput = result.stdout.trim();
      const cliSuccess = cliOutput.includes('WORKING') && !cliOutput.includes('EXIT_CODE:');
      results.cliApiCall = {
        ok: cliSuccess,
        response: cliOutput.slice(0, 200),
        ms: cliDuration,
      };
      console.log('  Success:', cliSuccess);
      console.log('  Response:', cliOutput.slice(0, 200));
      console.log('  Duration:', cliDuration.toFixed(0), 'ms');
    } else {
      console.log('\n[3/5] Skipping CLI test (no valid token)');
      results.cliApiCall = { ok: false, skipped: true, reason: 'No OAuth token or API key' };
    }

    // Install Agent SDK
    console.log('\n[4/5] Installing Claude Agent SDK...');
    start = performance.now();
    result = await sandbox.npmInstall('@anthropic-ai/claude-agent-sdk');
    results.sdkInstall = { ok: result.exitCode === 0, ms: performance.now() - start };
    console.log('  Result:', result.exitCode === 0 ? 'OK' : 'FAILED', `(${results.sdkInstall.ms.toFixed(0)}ms)`);

    // TEST: Agent SDK API call
    if (canTestSDK) {
      console.log('\n[5/5] Testing Agent SDK API call...');
      const sdkTestScript = `
const { query } = require('@anthropic-ai/claude-agent-sdk');

async function test() {
  const start = Date.now();
  try {
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
  } catch (e) {
    console.log(JSON.stringify({
      success: false,
      error: e.message,
      durationMs: Date.now() - start
    }));
  }
}

test();
`;

      await sandbox.exec('sh', ['-c', `cat > /workspace/sdk-test.js << 'SCRIPT'
${sdkTestScript}
SCRIPT`]);

      start = performance.now();
      result = await sandbox.execWithNpmPath('cd /workspace && timeout 60 node sdk-test.js 2>&1');
      const sdkDuration = performance.now() - start;

      console.log('  Raw output:', result.stdout);
      try {
        const lines = result.stdout.trim().split('\n');
        const jsonLine = lines.find(l => l.startsWith('{')) || '{}';
        const sdkResult = JSON.parse(jsonLine);
        results.sdkApiCall = {
          ok: sdkResult.success === true,
          response: sdkResult.response,
          ms: sdkResult.durationMs || sdkDuration,
          error: sdkResult.error,
        };
        console.log('  Success:', sdkResult.success);
        console.log('  Response:', sdkResult.response);
        if (sdkResult.error) console.log('  Error:', sdkResult.error);
        console.log('  API Duration:', results.sdkApiCall.ms.toFixed(0), 'ms');
      } catch (e) {
        results.sdkApiCall = { ok: false, error: result.stderr || result.stdout, ms: sdkDuration };
        console.log('  FAILED:', result.stderr || result.stdout);
      }
    } else {
      console.log('\n[5/5] Skipping SDK test (OAuth tokens not supported, need sk-ant-api01-* key)');
      results.sdkApiCall = { ok: false, skipped: true, reason: 'SDK requires API key, not OAuth token' };
    }

  } finally {
    await sandbox.stop();
  }

  return results;
}

async function main() {
  console.log('Claude API Validation Test');
  console.log('Testing actual API calls (not just installation)\n');

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
    console.log(`  CLI Install:    ${r.cliInstall?.ok ? '✅' : '❌'} (${r.cliInstall?.ms?.toFixed(0) ?? 'N/A'} ms)`);
    console.log(`  CLI API Call:   ${r.cliApiCall?.skipped ? '⏭️ Skipped' : (r.cliApiCall?.ok ? '✅' : '❌')} (${r.cliApiCall?.ms?.toFixed(0) ?? 'N/A'} ms)`);
    console.log(`  SDK Install:    ${r.sdkInstall?.ok ? '✅' : '❌'} (${r.sdkInstall?.ms?.toFixed(0) ?? 'N/A'} ms)`);
    console.log(`  SDK API Call:   ${r.sdkApiCall?.skipped ? '⏭️ Skipped' : (r.sdkApiCall?.ok ? '✅' : '❌')} (${r.sdkApiCall?.ms?.toFixed(0) ?? 'N/A'} ms)`);

    if (r.cliApiCall?.error) console.log(`  CLI Error: ${r.cliApiCall.error}`);
    if (r.sdkApiCall?.error) console.log(`  SDK Error: ${r.sdkApiCall.error}`);
    if (r.cliApiCall?.skipped) console.log(`  CLI Skip Reason: ${r.cliApiCall.reason}`);
    if (r.sdkApiCall?.skipped) console.log(`  SDK Skip Reason: ${r.sdkApiCall.reason}`);
  }

  console.log('\n--- JSON Results ---');
  console.log(JSON.stringify(allResults, null, 2));
}

main().catch(console.error);
