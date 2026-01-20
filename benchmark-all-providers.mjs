#!/usr/bin/env node
/**
 * Comprehensive benchmark: Test Agent SDK and Claude Code CLI
 * across all providers, including 5 concurrent instances
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { BoxLiteProvider } from './packages/sandbox-boxlite/dist/index.js';
import { OrbStackProvider } from './packages/sandbox-orbstack/dist/index.js';
import { AppleContainerProvider } from './packages/sandbox-apple-container/dist/index.js';
import { generateSandboxId } from './packages/sandbox-core/dist/index.js';

// Load .env
function loadEnv() {
  try {
    const content = readFileSync('.env', 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      const [key, ...valueParts] = line.split('=');
      const value = valueParts.join('=').trim();
      if (key && value) process.env[key.trim()] = value;
    }
  } catch {}
}

loadEnv();

const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
if (!authToken) {
  console.error('ANTHROPIC_AUTH_TOKEN not set in .env');
  process.exit(1);
}

const credentials = {
  claudeAiOauth: {
    accessToken: authToken,
    refreshToken: '',
    expiresAt: Date.now() + 86400000,
    scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
    subscriptionType: 'max',
  }
};

const results = {
  timestamp: new Date().toISOString(),
  providers: {},
};

/**
 * Test a single provider
 */
async function testProvider(name, provider, imageConfig) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${name}`);
  console.log('='.repeat(60));

  const providerResults = {
    available: false,
    info: null,
    sdk: { success: false, startupMs: 0, execMs: 0, totalMs: 0 },
    cli: { success: false, startupMs: 0, execMs: 0, totalMs: 0 },
    concurrent: { success: false, instances: 0, totalMs: 0, avgStartupMs: 0 },
  };

  // Check availability
  const available = await provider.isAvailable();
  if (!available) {
    console.log(`❌ ${name} not available`);
    providerResults.available = false;
    return providerResults;
  }

  providerResults.available = true;
  providerResults.info = await provider.getInfo();
  console.log(`Provider: ${providerResults.info.name} v${providerResults.info.version}`);

  const userHome = '/home/sandbox';
  const credsJson = JSON.stringify(credentials);

  // Test 1: Agent SDK
  console.log(`\n--- Agent SDK Test ---`);
  try {
    const sdkStart = performance.now();
    const id = generateSandboxId(name.toLowerCase().replace(/\s+/g, '-'));
    const mountPath = `/tmp/sandboxes/${id}/workspace`;
    mkdirSync(mountPath, { recursive: true });

    const sandbox = await provider.create({
      id,
      image: imageConfig.image,
      mountPath,
      memoryMib: 2048,
      cpus: 2,
      env: { CI: 'true', TERM: 'dumb' },
      user: { name: 'sandbox', uid: 1000, gid: 1000 },
    });

    providerResults.sdk.startupMs = sandbox.getMetrics().startupMs;
    console.log(`Startup: ${providerResults.sdk.startupMs.toFixed(0)}ms`);

    // Install Node.js if needed (Alpine)
    if (imageConfig.installNode) {
      await sandbox.execAsRoot('apk', ['add', '--no-cache', 'nodejs', 'npm']);
    }

    // Install SDK
    await sandbox.exec('sh', ['-c', 'cd /workspace && npm init -y 2>/dev/null']);
    await sandbox.exec('sh', ['-c', 'cd /workspace && npm install @anthropic-ai/claude-agent-sdk 2>/dev/null']);

    // Write credentials
    await sandbox.exec('sh', ['-c', `mkdir -p ${userHome}/.claude`]);
    await sandbox.exec('sh', ['-c', `cat > ${userHome}/.claude/.credentials.json << 'CREDS_EOF'\n${credsJson}\nCREDS_EOF`]);
    await sandbox.exec('sh', ['-c', `chmod 600 ${userHome}/.claude/.credentials.json`]);

    // SDK test script
    const sdkScript = `
const { query } = require('@anthropic-ai/claude-agent-sdk');
async function test() {
  const q = query({
    prompt: 'Reply with exactly: SUCCESS',
    options: {
      model: 'claude-sonnet-4-20250514',
      maxTurns: 1,
      cwd: '/workspace',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    }
  });
  let response = '';
  for await (const msg of q) {
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const b of msg.message.content) {
        if (b.type === 'text') response += b.text;
      }
    }
  }
  console.log('Response:', response);
  process.exit(response.includes('SUCCESS') ? 0 : 1);
}
test().catch(e => { console.error(e.message); process.exit(1); });
`;
    await sandbox.exec('sh', ['-c', `cat > /workspace/sdk-test.js << 'EOF'\n${sdkScript}\nEOF`]);

    const execStart = performance.now();
    const sdkResult = await sandbox.exec('sh', ['-c', `cd /workspace && HOME=${userHome} timeout 120 node sdk-test.js 2>&1`]);
    providerResults.sdk.execMs = performance.now() - execStart;
    providerResults.sdk.totalMs = performance.now() - sdkStart;
    providerResults.sdk.success = sdkResult.exitCode === 0 && sdkResult.stdout.includes('SUCCESS');

    console.log(`SDK Result: ${providerResults.sdk.success ? '✅ SUCCESS' : '❌ FAILED'}`);
    console.log(`Exec time: ${providerResults.sdk.execMs.toFixed(0)}ms`);
    if (!providerResults.sdk.success) console.log(`Output: ${sdkResult.stdout.slice(0, 200)}`);

    await sandbox.stop();
  } catch (err) {
    console.log(`SDK Error: ${err.message}`);
    providerResults.sdk.success = false;
  }

  // Test 2: Claude Code CLI
  console.log(`\n--- Claude Code CLI Test ---`);
  try {
    const cliStart = performance.now();
    const id = generateSandboxId(name.toLowerCase().replace(/\s+/g, '-') + '-cli');
    const mountPath = `/tmp/sandboxes/${id}/workspace`;
    mkdirSync(mountPath, { recursive: true });

    const sandbox = await provider.create({
      id,
      image: imageConfig.image,
      mountPath,
      memoryMib: 2048,
      cpus: 2,
      env: { CI: 'true', TERM: 'dumb' },
      user: { name: 'sandbox', uid: 1000, gid: 1000 },
    });

    providerResults.cli.startupMs = sandbox.getMetrics().startupMs;
    console.log(`Startup: ${providerResults.cli.startupMs.toFixed(0)}ms`);

    // Install Node.js and Claude CLI
    if (imageConfig.installNode) {
      await sandbox.execAsRoot('apk', ['add', '--no-cache', 'nodejs', 'npm']);
    }
    await sandbox.execAsRoot('npm', ['install', '-g', '@anthropic-ai/claude-code']);

    // Write credentials
    await sandbox.exec('sh', ['-c', `mkdir -p ${userHome}/.claude`]);
    await sandbox.exec('sh', ['-c', `cat > ${userHome}/.claude/.credentials.json << 'CREDS_EOF'\n${credsJson}\nCREDS_EOF`]);
    await sandbox.exec('sh', ['-c', `chmod 600 ${userHome}/.claude/.credentials.json`]);

    // Test CLI version
    let result = await sandbox.exec('claude', ['--version']);
    console.log(`Claude CLI: ${result.stdout}`);

    // Test CLI with a simple prompt
    const execStart = performance.now();
    result = await sandbox.exec('sh', ['-c',
      `cd /workspace && HOME=${userHome} timeout 120 claude -p "Reply with exactly: SUCCESS" --output-format text 2>&1`
    ]);
    providerResults.cli.execMs = performance.now() - execStart;
    providerResults.cli.totalMs = performance.now() - cliStart;
    providerResults.cli.success = result.exitCode === 0 && result.stdout.includes('SUCCESS');

    console.log(`CLI Result: ${providerResults.cli.success ? '✅ SUCCESS' : '❌ FAILED'}`);
    console.log(`Exec time: ${providerResults.cli.execMs.toFixed(0)}ms`);
    if (!providerResults.cli.success) console.log(`Output: ${result.stdout.slice(0, 200)}`);

    await sandbox.stop();
  } catch (err) {
    console.log(`CLI Error: ${err.message}`);
    providerResults.cli.success = false;
  }

  return providerResults;
}

/**
 * Test 5 concurrent instances
 */
async function testConcurrent(name, provider, imageConfig) {
  console.log(`\n--- 5 Concurrent Instances ---`);

  const concurrentResults = {
    success: false,
    instances: 5,
    totalMs: 0,
    avgStartupMs: 0,
    startupTimes: [],
    memoryMb: [],
  };

  try {
    const startTime = performance.now();
    const sandboxes = [];
    const userHome = '/home/sandbox';
    const credsJson = JSON.stringify(credentials);

    // Create 5 sandboxes in parallel
    console.log('Creating 5 sandboxes...');
    const createPromises = [];
    for (let i = 0; i < 5; i++) {
      const id = generateSandboxId(`${name.toLowerCase()}-concurrent-${i}`);
      const mountPath = `/tmp/sandboxes/${id}/workspace`;
      mkdirSync(mountPath, { recursive: true });

      createPromises.push(
        provider.create({
          id,
          image: imageConfig.image,
          mountPath,
          memoryMib: 1024,
          cpus: 1,
          env: { CI: 'true', TERM: 'dumb' },
          user: { name: 'sandbox', uid: 1000, gid: 1000 },
        })
      );
    }

    const created = await Promise.all(createPromises);
    sandboxes.push(...created);

    for (const sb of sandboxes) {
      concurrentResults.startupTimes.push(sb.getMetrics().startupMs);
    }
    concurrentResults.avgStartupMs = concurrentResults.startupTimes.reduce((a, b) => a + b, 0) / 5;
    console.log(`Avg startup: ${concurrentResults.avgStartupMs.toFixed(0)}ms`);

    // Install Node.js on all (in parallel)
    if (imageConfig.installNode) {
      console.log('Installing Node.js on all...');
      await Promise.all(sandboxes.map(sb => sb.execAsRoot('apk', ['add', '--no-cache', 'nodejs', 'npm'])));
    }

    // Install SDK and write credentials on all (in parallel)
    console.log('Installing SDK on all...');
    await Promise.all(sandboxes.map(async (sb) => {
      await sb.exec('sh', ['-c', 'cd /workspace && npm init -y 2>/dev/null']);
      await sb.exec('sh', ['-c', 'cd /workspace && npm install @anthropic-ai/claude-agent-sdk 2>/dev/null']);
      await sb.exec('sh', ['-c', `mkdir -p ${userHome}/.claude`]);
      await sb.exec('sh', ['-c', `cat > ${userHome}/.claude/.credentials.json << 'CREDS_EOF'\n${credsJson}\nCREDS_EOF`]);
      await sb.exec('sh', ['-c', `chmod 600 ${userHome}/.claude/.credentials.json`]);
    }));

    // Write test script to all
    const sdkScript = `
const { query } = require('@anthropic-ai/claude-agent-sdk');
async function test() {
  const q = query({
    prompt: 'Reply with exactly: SUCCESS',
    options: {
      model: 'claude-sonnet-4-20250514',
      maxTurns: 1,
      cwd: '/workspace',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    }
  });
  let response = '';
  for await (const msg of q) {
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const b of msg.message.content) {
        if (b.type === 'text') response += b.text;
      }
    }
  }
  console.log('Response:', response);
  process.exit(response.includes('SUCCESS') ? 0 : 1);
}
test().catch(e => { console.error(e.message); process.exit(1); });
`;
    await Promise.all(sandboxes.map(sb =>
      sb.exec('sh', ['-c', `cat > /workspace/sdk-test.js << 'EOF'\n${sdkScript}\nEOF`])
    ));

    // Run SDK test on all concurrently
    console.log('Running SDK on all 5 concurrently...');
    const runResults = await Promise.all(sandboxes.map(sb =>
      sb.exec('sh', ['-c', `cd /workspace && HOME=${userHome} timeout 120 node sdk-test.js 2>&1`])
    ));

    const successes = runResults.filter(r => r.exitCode === 0 && r.stdout.includes('SUCCESS')).length;
    concurrentResults.success = successes === 5;
    concurrentResults.totalMs = performance.now() - startTime;

    console.log(`Concurrent Result: ${successes}/5 succeeded ${concurrentResults.success ? '✅' : '❌'}`);
    console.log(`Total time: ${concurrentResults.totalMs.toFixed(0)}ms`);

    // Get memory stats
    for (const sb of sandboxes) {
      if (sb.updateStats) {
        await sb.updateStats();
        const metrics = sb.getMetrics();
        if (metrics.memoryBytes > 0) {
          concurrentResults.memoryMb.push(metrics.memoryBytes / (1024 * 1024));
        }
      }
    }

    if (concurrentResults.memoryMb.length > 0) {
      const avgMem = concurrentResults.memoryMb.reduce((a, b) => a + b, 0) / concurrentResults.memoryMb.length;
      console.log(`Avg memory: ${avgMem.toFixed(1)}MB per instance`);
    }

    // Cleanup
    await Promise.all(sandboxes.map(sb => sb.stop()));

  } catch (err) {
    console.log(`Concurrent Error: ${err.message}`);
    concurrentResults.success = false;
  }

  return concurrentResults;
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     Sandbox Provider Benchmark - SDK & CLI Testing         ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`\nTimestamp: ${results.timestamp}`);
  console.log(`Auth Token: ${authToken.slice(0, 25)}...`);

  const providers = [
    {
      name: 'BoxLite',
      provider: new BoxLiteProvider(),
      config: { image: 'alpine:latest', installNode: true },
    },
    {
      name: 'OrbStack',
      provider: new OrbStackProvider(),
      config: { image: 'alpine:latest', installNode: true },
    },
    {
      name: 'AppleContainer',
      provider: new AppleContainerProvider(),
      config: { image: 'node:22-slim', installNode: false },
    },
  ];

  for (const { name, provider, config } of providers) {
    const providerResults = await testProvider(name, provider, config);

    if (providerResults.available && providerResults.sdk.success) {
      providerResults.concurrent = await testConcurrent(name, provider, config);
    }

    results.providers[name] = providerResults;
  }

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('SUMMARY');
  console.log('═'.repeat(60));

  console.log('\n| Provider | SDK | CLI | Startup | 5-Concurrent |');
  console.log('|----------|-----|-----|---------|--------------|');

  for (const [name, r] of Object.entries(results.providers)) {
    if (!r.available) {
      console.log(`| ${name.padEnd(8)} | N/A | N/A | N/A | N/A |`);
      continue;
    }
    const sdk = r.sdk.success ? '✅' : '❌';
    const cli = r.cli.success ? '✅' : '❌';
    const startup = `${r.sdk.startupMs.toFixed(0)}ms`;
    const concurrent = r.concurrent?.success ? `✅ ${r.concurrent.totalMs.toFixed(0)}ms` : '❌';
    console.log(`| ${name.padEnd(8)} | ${sdk}  | ${cli}  | ${startup.padEnd(7)} | ${concurrent.padEnd(12)} |`);
  }

  // Save results
  const resultsFile = `results/benchmark-${Date.now()}.json`;
  mkdirSync('results', { recursive: true });
  writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to: ${resultsFile}`);
}

main().catch(console.error);
