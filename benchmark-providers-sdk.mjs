#!/usr/bin/env node
/**
 * SDK-based Provider Benchmark
 * Uses actual provider implementations (dockerode for Docker, libkrun for BoxLite, etc.)
 * No CLI shelling - pure SDK calls
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

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
  console.error('ANTHROPIC_AUTH_TOKEN not set');
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

const settings = { permissions: { defaultMode: 'bypassPermissions' } };
const CLAUDE_IMAGE = 'docker/sandbox-templates:claude-code';

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     SDK-based Provider Benchmark (No CLI)                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  console.log(`\nImage: ${CLAUDE_IMAGE}`);
  console.log(`Token: ${authToken.slice(0, 25)}...`);

  const testId = randomUUID().slice(0, 8);
  const results = [];

  // 1. Docker (via OrbStackProvider - uses dockerode)
  console.log('\n' + '─'.repeat(60));
  console.log('Provider: Docker (OrbStackProvider/dockerode)');
  console.log('─'.repeat(60));
  try {
    const { OrbStackProvider } = await import('./packages/sandbox-orbstack/dist/index.js');
    const { generateSandboxId } = await import('./packages/sandbox-core/dist/index.js');

    const id = generateSandboxId('docker-sdk');
    const mountPath = `/tmp/docker-sdk-${testId}`;
    mkdirSync(mountPath, { recursive: true });

    const e2eStart = performance.now();
    const startupStart = performance.now();

    const provider = new OrbStackProvider();
    const sandbox = await provider.create({
      id,
      image: CLAUDE_IMAGE,
      mountPath,
      env: { CI: 'true', TERM: 'dumb' },
      // Note: claude-code image already runs as 'agent' user, no user switching needed
    });
    const startupMs = performance.now() - startupStart;

    // Setup credentials
    const userHome = '/home/agent';
    await sandbox.exec('sh', ['-c', `mkdir -p ${userHome}/.claude`]);
    await sandbox.exec('sh', ['-c', `cat > ${userHome}/.claude/.credentials.json << 'EOF'\n${JSON.stringify(credentials)}\nEOF`]);
    await sandbox.exec('sh', ['-c', `cat > ${userHome}/.claude/settings.json << 'EOF'\n${JSON.stringify(settings)}\nEOF`]);

    // Run prompt with stdin fix
    const claudePath = '/home/agent/.local/bin/claude';
    const promptStart = performance.now();
    const promptResult = await sandbox.exec('sh', ['-c', `echo "" | HOME=${userHome} ${claudePath} -p "Reply with exactly: SUCCESS" --output-format text 2>&1`]);
    const promptMs = performance.now() - promptStart;
    const e2eMs = performance.now() - e2eStart;
    const success = promptResult.stdout?.includes('SUCCESS');

    // Get memory
    await sandbox.updateStats();
    const metrics = sandbox.getMetrics();
    const peakMemory = metrics.memoryBytes ? metrics.memoryBytes / (1024 * 1024) : null;

    console.log(`Startup: ${startupMs.toFixed(0)}ms`);
    console.log(`Prompt: ${promptMs.toFixed(0)}ms`);
    console.log(`E2E: ${e2eMs.toFixed(0)}ms`);
    console.log(`Peak Memory: ${peakMemory?.toFixed(1) || 'N/A'} MiB`);
    console.log(`Result: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);

    results.push({ provider: 'Docker (dockerode)', startupMs, promptMs, e2eMs, peakMemoryMib: peakMemory, success, isolation: 'Container' });
    await sandbox.stop();
  } catch (e) {
    console.log(`Error: ${e.message}`);
    results.push({ provider: 'Docker (dockerode)', error: e.message });
  }

  // 2. BoxLite
  console.log('\n' + '─'.repeat(60));
  console.log('Provider: BoxLite (libkrun)');
  console.log('─'.repeat(60));
  try {
    const { BoxLiteProvider } = await import('./packages/sandbox-boxlite/dist/index.js');
    const { generateSandboxId } = await import('./packages/sandbox-core/dist/index.js');

    const id = generateSandboxId('boxlite-sdk');
    const mountPath = `/tmp/boxlite-sdk-${testId}`;
    mkdirSync(mountPath, { recursive: true });

    const e2eStart = performance.now();
    const startupStart = performance.now();

    const provider = new BoxLiteProvider();
    const sandbox = await provider.create({
      id,
      image: CLAUDE_IMAGE,
      mountPath,
      memoryMib: 4096,
      cpus: 4,
      env: { CI: 'true', TERM: 'dumb' },
      user: { name: 'agent', uid: 1000, gid: 1000 },
    });
    const startupMs = performance.now() - startupStart;

    // Setup credentials
    const userHome = '/home/agent';
    await sandbox.exec('sh', ['-c', `mkdir -p ${userHome}/.claude`]);
    await sandbox.exec('sh', ['-c', `cat > ${userHome}/.claude/.credentials.json << 'EOF'\n${JSON.stringify(credentials)}\nEOF`]);
    await sandbox.exec('sh', ['-c', `cat > ${userHome}/.claude/settings.json << 'EOF'\n${JSON.stringify(settings)}\nEOF`]);

    // Run prompt with stdin fix
    const claudePath = '/home/agent/.local/bin/claude';
    const promptStart = performance.now();
    const promptResult = await sandbox.exec('sh', ['-c', `echo "" | HOME=${userHome} ${claudePath} -p "Reply with exactly: SUCCESS" --output-format text 2>&1`]);
    const promptMs = performance.now() - promptStart;
    const e2eMs = performance.now() - e2eStart;
    const success = promptResult.stdout?.includes('SUCCESS');

    const metrics = sandbox.getMetrics();
    const peakMemory = metrics.memoryBytes ? metrics.memoryBytes / (1024 * 1024) : null;

    console.log(`Startup: ${startupMs.toFixed(0)}ms`);
    console.log(`Prompt: ${promptMs.toFixed(0)}ms`);
    console.log(`E2E: ${e2eMs.toFixed(0)}ms`);
    console.log(`Peak Memory: ${peakMemory?.toFixed(1) || 'N/A'} MiB`);
    console.log(`Result: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);

    results.push({ provider: 'BoxLite (libkrun)', startupMs, promptMs, e2eMs, peakMemoryMib: peakMemory, success, isolation: 'Micro-VM' });
    await sandbox.stop();
  } catch (e) {
    console.log(`Error: ${e.message}`);
    results.push({ provider: 'BoxLite (libkrun)', error: e.message });
  }

  // 3. Apple Container
  console.log('\n' + '─'.repeat(60));
  console.log('Provider: Apple Container');
  console.log('─'.repeat(60));
  try {
    const { AppleContainerProvider } = await import('./packages/sandbox-apple-container/dist/index.js');
    const { generateSandboxId } = await import('./packages/sandbox-core/dist/index.js');

    const id = generateSandboxId('apple-sdk');
    const mountPath = `/tmp/apple-sdk-${testId}`;
    mkdirSync(mountPath, { recursive: true });

    const e2eStart = performance.now();
    const startupStart = performance.now();

    const provider = new AppleContainerProvider();
    const sandbox = await provider.create({
      id,
      image: CLAUDE_IMAGE,
      mountPath,
      memoryMib: 4096,
      cpus: 4,
      env: { CI: 'true', TERM: 'dumb' },
    });
    const startupMs = performance.now() - startupStart;

    // Setup credentials
    const userHome = '/home/agent';
    await sandbox.exec('sh', ['-c', `mkdir -p ${userHome}/.claude`]);
    await sandbox.exec('sh', ['-c', `cat > ${userHome}/.claude/.credentials.json << 'EOF'\n${JSON.stringify(credentials)}\nEOF`]);
    await sandbox.exec('sh', ['-c', `cat > ${userHome}/.claude/settings.json << 'EOF'\n${JSON.stringify(settings)}\nEOF`]);

    // Run prompt with stdin fix
    const claudePath = '/home/agent/.local/bin/claude';
    const promptStart = performance.now();
    const promptResult = await sandbox.exec('sh', ['-c', `echo "" | HOME=${userHome} ${claudePath} -p "Reply with exactly: SUCCESS" --output-format text 2>&1`]);
    const promptMs = performance.now() - promptStart;
    const e2eMs = performance.now() - e2eStart;
    const success = promptResult.stdout?.includes('SUCCESS');

    const metrics = sandbox.getMetrics();
    const peakMemory = metrics.memoryBytes ? metrics.memoryBytes / (1024 * 1024) : null;

    console.log(`Startup: ${startupMs.toFixed(0)}ms`);
    console.log(`Prompt: ${promptMs.toFixed(0)}ms`);
    console.log(`E2E: ${e2eMs.toFixed(0)}ms`);
    console.log(`Peak Memory: ${peakMemory?.toFixed(1) || 'N/A'} MiB`);
    console.log(`Result: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);

    results.push({ provider: 'Apple Container', startupMs, promptMs, e2eMs, peakMemoryMib: peakMemory, success, isolation: 'Full VM' });
    await sandbox.stop();
  } catch (e) {
    console.log(`Error: ${e.message}`);
    results.push({ provider: 'Apple Container', error: e.message });
  }

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('SDK-BASED BENCHMARK SUMMARY');
  console.log('═'.repeat(60));
  console.log(`\nImage: ${CLAUDE_IMAGE}\n`);

  console.log('| Provider | Startup | Prompt | E2E | Memory | Isolation | Result |');
  console.log('|----------|---------|--------|-----|--------|-----------|--------|');
  for (const r of results) {
    if (r.error) {
      console.log(`| ${r.provider.padEnd(20)} | ERROR: ${r.error.slice(0, 40)} |`);
    } else {
      const startup = `${Math.round(r.startupMs)}ms`.padEnd(7);
      const prompt = `${Math.round(r.promptMs)}ms`.padEnd(6);
      const e2e = `${Math.round(r.e2eMs)}ms`.padEnd(6);
      const memory = r.peakMemoryMib ? `${r.peakMemoryMib.toFixed(0)}MB`.padEnd(6) : 'N/A'.padEnd(6);
      const isolation = (r.isolation || 'N/A').padEnd(9);
      const result = r.success ? '✅' : '❌';
      console.log(`| ${r.provider.padEnd(20)} | ${startup} | ${prompt} | ${e2e} | ${memory} | ${isolation} | ${result}     |`);
    }
  }

  // Save results
  const resultsFile = `results/benchmark-sdk-${Date.now()}.json`;
  mkdirSync('results', { recursive: true });
  writeFileSync(resultsFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    image: CLAUDE_IMAGE,
    method: 'SDK (no CLI)',
    results
  }, null, 2));
  console.log(`\nResults saved to: ${resultsFile}`);
}

main().catch(console.error);
