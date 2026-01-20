/**
 * Final API Validation Test
 *
 * Tests Claude Code CLI and Agent SDK in BoxLite sandbox
 * using macOS Keychain credentials (like Automaker does).
 *
 * Key findings:
 * - CLI requires: CI=true, TERM=dumb, stdin=/dev/null, --model flag
 * - CLI uses OAuth via ~/.claude/.credentials.json
 * - SDK requires ANTHROPIC_API_KEY (sk-ant-api01-*), NOT OAuth tokens
 */
import { execSync } from 'node:child_process';
import { BoxLiteProvider } from './packages/sandbox-boxlite/dist/index.js';
import { generateSandboxId } from './packages/sandbox-core/dist/index.js';

// Extract credentials from macOS Keychain
function getKeychainCredentials() {
  try {
    const username = execSync('whoami', { encoding: 'utf-8' }).trim();
    const creds = execSync(
      `security find-generic-password -s "Claude Code-credentials" -a "${username}" -w`,
      { encoding: 'utf-8' }
    ).trim();
    return JSON.parse(creds);
  } catch (err) {
    console.error('Failed to extract credentials from Keychain:', err.message);
    return null;
  }
}

async function testBoxLite(credentials) {
  console.log('\n' + '='.repeat(60));
  console.log('BoxLite API Validation Test');
  console.log('='.repeat(60));

  const provider = new BoxLiteProvider();
  if (!(await provider.isAvailable())) {
    console.log('BoxLite not available');
    return null;
  }

  const id = generateSandboxId('api-final');
  console.log('Creating sandbox:', id);

  const sandbox = await provider.create({
    id,
    image: 'alpine:latest',
    mountPath: '/tmp/sandboxes/' + id + '/workspace',
    memoryMib: 2048,
    cpus: 2,
    env: {
      HOME: '/root',
      CI: 'true',        // Required for non-interactive CLI
      TERM: 'dumb',      // Required for non-interactive CLI
    },
  });

  console.log('Startup time:', sandbox.getMetrics().startupMs.toFixed(2), 'ms');

  const results = {
    provider: 'boxlite',
    startupMs: sandbox.getMetrics().startupMs,
    nodeInstall: null,
    cliInstall: null,
    credentialsSetup: null,
    cliApiCall: null,
    sdkNote: 'SDK requires ANTHROPIC_API_KEY (sk-ant-api01-*), OAuth not supported',
  };

  try {
    // Install Node.js
    console.log('\n[1/4] Installing Node.js...');
    let start = performance.now();
    let result = await sandbox.exec('apk', ['add', '--no-cache', 'nodejs', 'npm']);
    results.nodeInstall = { ok: result.exitCode === 0, ms: performance.now() - start };
    console.log('  Result:', result.exitCode === 0 ? '✅' : '❌', `(${results.nodeInstall.ms.toFixed(0)}ms)`);

    // Install Claude CLI
    console.log('\n[2/4] Installing Claude Code CLI...');
    start = performance.now();
    result = await sandbox.npmInstall('@anthropic-ai/claude-code', true);
    results.cliInstall = { ok: result.exitCode === 0, ms: performance.now() - start };
    console.log('  Result:', result.exitCode === 0 ? '✅' : '❌', `(${results.cliInstall.ms.toFixed(0)}ms)`);

    // Write Keychain credentials to sandbox
    console.log('\n[3/4] Setting up credentials from macOS Keychain...');
    start = performance.now();
    const credsJson = JSON.stringify(credentials);
    await sandbox.exec('mkdir', ['-p', '/root/.claude']);
    await sandbox.exec('sh', ['-c', 'cat > /root/.claude/.credentials.json << "ENDCREDS"\n' + credsJson + '\nENDCREDS']);
    await sandbox.exec('chmod', ['600', '/root/.claude/.credentials.json']);
    results.credentialsSetup = { ok: true, ms: performance.now() - start };
    console.log('  Result: ✅', `(${results.credentialsSetup.ms.toFixed(0)}ms)`);

    // TEST: Claude CLI API call
    console.log('\n[4/4] Testing Claude Code CLI API call...');
    console.log('  Command: claude -p "..." --max-turns 1 --output-format text --model sonnet');

    start = performance.now();
    result = await sandbox.execWithNpmPath(
      'timeout 60 claude -p "Reply with exactly one word: WORKING" --max-turns 1 --output-format text --model sonnet < /dev/null 2>&1'
    );
    const cliDuration = performance.now() - start;

    const cliOutput = result.stdout.trim();
    const cliSuccess = result.exitCode === 0 && cliOutput.includes('WORKING');
    results.cliApiCall = {
      ok: cliSuccess,
      response: cliOutput.slice(0, 100),
      ms: cliDuration,
      exitCode: result.exitCode,
    };
    console.log('  Exit code:', result.exitCode);
    console.log('  Response:', cliOutput.slice(0, 100));
    console.log('  Success:', cliSuccess ? '✅' : '❌');
    console.log('  Duration:', cliDuration.toFixed(0), 'ms');

  } finally {
    await sandbox.stop();
  }

  return results;
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  Claude API Validation Test - Final                      ║');
  console.log('║  Testing actual API calls (not just installation)        ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Extract credentials from Keychain
  console.log('Extracting credentials from macOS Keychain...');
  const credentials = getKeychainCredentials();

  if (!credentials) {
    console.error('\n❌ Failed to get credentials from Keychain.');
    console.log('Make sure you have logged in with: claude login');
    process.exit(1);
  }

  const hasOAuth = credentials.claudeAiOauth?.accessToken;
  console.log('  OAuth credentials:', hasOAuth ? '✅ Found' : '❌ Not found');
  if (hasOAuth) {
    console.log('  Access token:', credentials.claudeAiOauth.accessToken.slice(0, 25) + '...');
    console.log('  Has refresh token:', credentials.claudeAiOauth.refreshToken ? '✅' : '❌');
  }

  const allResults = [];

  // Test BoxLite
  const boxliteResults = await testBoxLite(credentials);
  if (boxliteResults) {
    allResults.push(boxliteResults);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  for (const r of allResults) {
    console.log(`\n${r.provider.toUpperCase()}:`);
    console.log(`  VM Startup:        ${r.startupMs?.toFixed(0) ?? 'N/A'} ms`);
    console.log(`  Node Install:      ${r.nodeInstall?.ok ? '✅' : '❌'} (${r.nodeInstall?.ms?.toFixed(0) ?? 'N/A'} ms)`);
    console.log(`  CLI Install:       ${r.cliInstall?.ok ? '✅' : '❌'} (${r.cliInstall?.ms?.toFixed(0) ?? 'N/A'} ms)`);
    console.log(`  Credentials Setup: ${r.credentialsSetup?.ok ? '✅' : '❌'} (${r.credentialsSetup?.ms?.toFixed(0) ?? 'N/A'} ms)`);
    console.log(`  CLI API Call:      ${r.cliApiCall?.ok ? '✅' : '❌'} (${r.cliApiCall?.ms?.toFixed(0) ?? 'N/A'} ms)`);
    if (r.sdkNote) {
      console.log(`  SDK Note:          ${r.sdkNote}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('KEY FINDINGS');
  console.log('='.repeat(60));
  console.log(`
Claude Code CLI in sandboxed environments requires:
1. Extract OAuth credentials from macOS Keychain:
   security find-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w

2. Write credentials to ~/.claude/.credentials.json in sandbox

3. Set environment variables:
   - CI=true
   - TERM=dumb

4. Run with stdin from /dev/null and explicit --model:
   claude -p "prompt" --max-turns 1 --output-format text --model sonnet < /dev/null

Claude Agent SDK:
- Requires ANTHROPIC_API_KEY (sk-ant-api01-*) from console.anthropic.com
- Does NOT support OAuth tokens (sk-ant-oat01-*)
- OAuth is for CLI subscription users only
`);

  console.log('\n--- JSON Results ---');
  console.log(JSON.stringify(allResults, null, 2));
}

main().catch(console.error);
