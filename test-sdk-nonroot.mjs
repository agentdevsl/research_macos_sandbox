/**
 * Test SDK with non-root user (allows bypassPermissions mode)
 */
import { execSync } from 'node:child_process';
import { BoxLiteProvider } from './packages/sandbox-boxlite/dist/index.js';
import { AppleContainerProvider } from './packages/sandbox-apple-container/dist/index.js';
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
    return null;
  }
}

async function testProvider(providerName, provider) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing ${providerName} with non-root user`);
  console.log(`${'='.repeat(60)}`);

  const credentials = getKeychainCredentials();
  if (!credentials) {
    console.error('No credentials found');
    return { provider: providerName, success: false, error: 'No credentials' };
  }

  if (!(await provider.isAvailable())) {
    console.log(`${providerName} not available`);
    return { provider: providerName, success: false, error: 'Not available' };
  }

  const id = generateSandboxId('nonroot');
  console.log('Creating sandbox:', id);

  try {
    const sandbox = await provider.create({
      id,
      image: providerName === 'boxlite' ? 'alpine:latest' : 'node:22-slim',
      mountPath: '/tmp/sandboxes/' + id + '/workspace',
      memoryMib: 2048,
      cpus: 2,
      env: {
        CI: 'true',
        TERM: 'dumb',
      },
      // Run as non-root user - allows bypassPermissions
      user: {
        name: 'sandbox',
        uid: 1000,
        gid: 1000,
      },
    });

    console.log('Startup:', sandbox.getMetrics().startupMs.toFixed(0), 'ms');

    // Install Node.js if needed (BoxLite/Alpine) - must run as root
    if (providerName === 'boxlite') {
      console.log('\nInstalling Node.js (as root)...');
      await sandbox.execAsRoot('apk', ['add', '--no-cache', 'nodejs', 'npm']);
    }

    // Verify running as non-root
    let result = await sandbox.exec('id');
    console.log('User:', result.stdout.trim());
    const isNonRoot = result.stdout.includes('uid=1000');
    console.log('Running as non-root:', isNonRoot ? '✅' : '❌');

    if (!isNonRoot) {
      await sandbox.stop();
      return { provider: providerName, success: false, error: 'Still running as root' };
    }

    // Install SDK (as non-root user)
    console.log('\nInstalling SDK (as non-root)...');
    if (providerName === 'boxlite') {
      await sandbox.npmInstall('@anthropic-ai/claude-agent-sdk');
    } else {
      await sandbox.exec('sh', ['-c', 'cd /workspace && npm init -y']);
      await sandbox.exec('sh', ['-c', 'cd /workspace && npm install @anthropic-ai/claude-agent-sdk']);
    }

    // Write credentials to user's home
    console.log('Writing credentials...');
    const credsJson = JSON.stringify(credentials);
    const userHome = '/home/sandbox';
    await sandbox.exec('sh', ['-c', `mkdir -p ${userHome}/.claude && printf '%s' '${credsJson.replace(/'/g, "'\\''")}' > ${userHome}/.claude/.credentials.json && chmod 600 ${userHome}/.claude/.credentials.json`]);

    // Create test script with bypassPermissions
    const testScript = `
const { query } = require('@anthropic-ai/claude-agent-sdk');

async function main() {
  console.log('User ID:', process.getuid?.() ?? 'N/A');
  console.log('HOME:', process.env.HOME);
  console.log('Starting SDK test with bypassPermissions...');
  const start = Date.now();

  try {
    const q = query({
      prompt: 'Reply with exactly one word: SUCCESS',
      options: {
        model: 'claude-sonnet-4-20250514',
        maxTurns: 1,
        cwd: '/workspace',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        stderr: (msg) => console.log('[SDK STDERR]', msg),
      }
    });

    let response = '';
    for await (const msg of q) {
      console.log('Message type:', msg.type);
      if (msg.type === 'assistant' && msg.message && msg.message.content) {
        for (const b of msg.message.content) {
          if (b.type === 'text') {
            console.log('Text block:', b.text);
            response += b.text;
          }
        }
      }
      if (msg.type === 'result') {
        console.log('Result:', JSON.stringify(msg).slice(0, 500));
      }
    }

    console.log('Final Response:', response);
    console.log('Success:', response.includes('SUCCESS'));
    console.log('Duration:', Date.now() - start, 'ms');
    process.exit(response.includes('SUCCESS') ? 0 : 1);
  } catch (e) {
    console.log('Error:', e.message);
    console.log('Stack:', e.stack?.slice(0, 500));
    process.exit(1);
  }
}

main();
`;

    await sandbox.exec('sh', ['-c', `cat > /workspace/test.js << 'ENDSCRIPT'
${testScript}
ENDSCRIPT`]);

    console.log('\n=== SDK Test with bypassPermissions ===');
    result = await sandbox.exec('sh', ['-c', 'cd /workspace && timeout 120 node test.js 2>&1']);
    console.log('Output:');
    console.log(result.stdout);
    if (result.stderr) console.log('Stderr:', result.stderr);

    const success = result.exitCode === 0 && result.stdout.includes('SUCCESS');
    console.log(`\nResult: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);

    await sandbox.stop();
    return { provider: providerName, success, output: result.stdout };

  } catch (err) {
    console.error('Error:', err.message);
    return { provider: providerName, success: false, error: err.message };
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  SDK Non-Root User Test                                  ║');
  console.log('║  Testing bypassPermissions mode with non-root user       ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const results = [];

  // Test BoxLite
  const boxlite = new BoxLiteProvider();
  results.push(await testProvider('boxlite', boxlite));

  // Test Apple Container
  const appleContainer = new AppleContainerProvider();
  results.push(await testProvider('apple-container', appleContainer));

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  for (const r of results) {
    console.log(`${r.provider}: ${r.success ? '✅ SUCCESS' : '❌ FAILED'} ${r.error ?? ''}`);
  }
}

main().catch(console.error);
