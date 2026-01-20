/**
 * API Validation Test - Using macOS Keychain Credentials
 *
 * Extracts Claude OAuth credentials from macOS Keychain and writes them
 * to ~/.claude/.credentials.json inside the sandbox (like Automaker does).
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
    console.log('\nMake sure you have logged in with: claude login');
    return null;
  }
}

async function testBoxLite(credentials) {
  console.log('\n' + '='.repeat(60));
  console.log('BoxLite API Validation Test (Keychain Credentials)');
  console.log('='.repeat(60));

  const provider = new BoxLiteProvider();
  if (!(await provider.isAvailable())) {
    console.log('BoxLite not available');
    return null;
  }

  const id = generateSandboxId('api-keychain');
  console.log('Creating sandbox:', id);

  const sandbox = await provider.create({
    id,
    image: 'alpine:latest',
    mountPath: '/tmp/sandboxes/' + id + '/workspace',
    memoryMib: 2048,
    cpus: 2,
    env: {
      HOME: '/root',
    },
  });

  console.log('Startup time:', sandbox.getMetrics().startupMs.toFixed(2), 'ms');

  const results = {
    provider: 'boxlite',
    startupMs: sandbox.getMetrics().startupMs,
    nodeInstall: null,
    cliInstall: null,
    cliApiCall: null,
  };

  try {
    // Install Node.js
    console.log('\n[1/4] Installing Node.js...');
    let start = performance.now();
    let result = await sandbox.exec('apk', ['add', '--no-cache', 'nodejs', 'npm']);
    results.nodeInstall = { ok: result.exitCode === 0, ms: performance.now() - start };
    console.log('  Result:', result.exitCode === 0 ? 'OK' : 'FAILED', `(${results.nodeInstall.ms.toFixed(0)}ms)`);

    // Install Claude CLI
    console.log('\n[2/4] Installing Claude Code CLI...');
    start = performance.now();
    result = await sandbox.npmInstall('@anthropic-ai/claude-code', true);
    results.cliInstall = { ok: result.exitCode === 0, ms: performance.now() - start };
    console.log('  Result:', result.exitCode === 0 ? 'OK' : 'FAILED', `(${results.cliInstall.ms.toFixed(0)}ms)`);

    // Write credentials to ~/.claude/.credentials.json (like Automaker does)
    console.log('\n[3/4] Writing Keychain credentials to sandbox...');
    const credsJson = JSON.stringify(credentials);
    // Escape for shell
    const escapedCreds = credsJson.replace(/'/g, "'\\''");

    await sandbox.exec('mkdir', ['-p', '/root/.claude']);
    result = await sandbox.exec('sh', ['-c', `echo '${escapedCreds}' > /root/.claude/.credentials.json`]);
    await sandbox.exec('chmod', ['600', '/root/.claude/.credentials.json']);

    // Verify credentials file
    result = await sandbox.exec('sh', ['-c', 'cat /root/.claude/.credentials.json | head -c 100']);
    console.log('  Credentials written:', result.stdout.slice(0, 50) + '...');

    // TEST: Claude CLI API call
    console.log('\n[4/4] Testing Claude Code CLI API call...');
    start = performance.now();
    result = await sandbox.execWithNpmPath(
      'timeout 60 claude -p "Reply with exactly one word: WORKING" --max-turns 1 --output-format text 2>&1 || echo "EXIT_CODE:$?"'
    );
    const cliDuration = performance.now() - start;

    const cliOutput = result.stdout.trim();
    const cliSuccess = cliOutput.includes('WORKING') && !cliOutput.includes('EXIT_CODE:');
    results.cliApiCall = {
      ok: cliSuccess,
      response: cliOutput.slice(0, 300),
      ms: cliDuration,
    };
    console.log('  Success:', cliSuccess);
    console.log('  Response:', cliOutput.slice(0, 300));
    console.log('  Duration:', cliDuration.toFixed(0), 'ms');

  } finally {
    await sandbox.stop();
  }

  return results;
}

async function main() {
  console.log('Claude API Validation Test');
  console.log('Using macOS Keychain credentials (like Automaker)\n');

  // Extract credentials from Keychain
  console.log('Extracting credentials from macOS Keychain...');
  const credentials = getKeychainCredentials();

  if (!credentials) {
    console.error('\nFailed to get credentials. Exiting.');
    process.exit(1);
  }

  const hasOAuth = credentials.claudeAiOauth?.accessToken;
  console.log('  OAuth credentials found:', hasOAuth ? 'Yes' : 'No');
  if (hasOAuth) {
    console.log('  Access token:', credentials.claudeAiOauth.accessToken.slice(0, 25) + '...');
    console.log('  Has refresh token:', !!credentials.claudeAiOauth.refreshToken);
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
    console.log(`  VM Startup:     ${r.startupMs?.toFixed(0) ?? 'N/A'} ms`);
    console.log(`  Node Install:   ${r.nodeInstall?.ok ? '✅' : '❌'} (${r.nodeInstall?.ms?.toFixed(0) ?? 'N/A'} ms)`);
    console.log(`  CLI Install:    ${r.cliInstall?.ok ? '✅' : '❌'} (${r.cliInstall?.ms?.toFixed(0) ?? 'N/A'} ms)`);
    console.log(`  CLI API Call:   ${r.cliApiCall?.ok ? '✅' : '❌'} (${r.cliApiCall?.ms?.toFixed(0) ?? 'N/A'} ms)`);
  }

  console.log('\n--- JSON Results ---');
  console.log(JSON.stringify(allResults, null, 2));
}

main().catch(console.error);
