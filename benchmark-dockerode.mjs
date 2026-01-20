#!/usr/bin/env node
/**
 * Dockerode-based Benchmark
 * Uses dockerode SDK instead of CLI for Docker operations
 */
import Docker from 'dockerode';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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

const docker = new Docker();

async function dockerExec(container, cmd, options = {}) {
  const exec = await container.exec({
    Cmd: ['sh', '-c', cmd],
    AttachStdout: true,
    AttachStderr: true,
    Env: options.env || [],
  });

  const stream = await exec.start();

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    stream.on('data', (chunk) => {
      // Docker multiplexes stdout/stderr with 8-byte header
      // Header: [type(1), 0, 0, 0, size(4)]
      // type: 1 = stdout, 2 = stderr
      const data = chunk.toString();
      stdout += data;
    });

    stream.on('end', () => {
      // Clean up Docker stream header bytes
      const cleanOutput = stdout.replace(/[\x00-\x08]/g, '').trim();
      resolve({ stdout: cleanOutput, stderr });
    });

    stream.on('error', reject);

    // Timeout
    if (options.timeout) {
      setTimeout(() => resolve({ stdout, stderr, timeout: true }), options.timeout);
    }
  });
}

async function getContainerMemory(container) {
  try {
    const stats = await container.stats({ stream: false });
    return stats.memory_stats.usage / (1024 * 1024); // Convert to MiB
  } catch {
    return null;
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     Dockerode SDK Benchmark                                ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  console.log(`\nImage: ${CLAUDE_IMAGE}`);
  console.log(`Token: ${authToken.slice(0, 25)}...`);

  const testId = randomUUID().slice(0, 8);
  const results = [];

  // Test 1: Dockerode (SDK)
  console.log('\n' + '─'.repeat(60));
  console.log('Provider: Docker (dockerode SDK)');
  console.log('─'.repeat(60));
  {
    const workspace = `/tmp/dockerode-bench-${testId}`;
    mkdirSync(workspace, { recursive: true });

    const e2eStart = performance.now();
    const startupStart = performance.now();

    // Create container using SDK
    const container = await docker.createContainer({
      Image: CLAUDE_IMAGE,
      Cmd: ['tail', '-f', '/dev/null'],
      Env: ['CI=true', 'TERM=dumb'],
      HostConfig: {
        Binds: [`${workspace}:/workspace`]
      }
    });

    await container.start();
    const startupMs = performance.now() - startupStart;

    // Setup credentials
    const userHome = '/home/agent';
    await dockerExec(container, `mkdir -p ${userHome}/.claude`);

    // Write credentials via workspace mount
    writeFileSync(`${workspace}/.credentials.json`, JSON.stringify(credentials));
    writeFileSync(`${workspace}/.settings.json`, JSON.stringify(settings));

    await dockerExec(container, `cp /workspace/.credentials.json ${userHome}/.claude/.credentials.json`);
    await dockerExec(container, `chmod 600 ${userHome}/.claude/.credentials.json`);
    await dockerExec(container, `cp /workspace/.settings.json ${userHome}/.claude/settings.json`);

    // Run Claude CLI
    const claudePath = '/home/agent/.local/bin/claude';
    const promptStart = performance.now();

    // Track peak memory
    let peakMemory = 0;
    const memInterval = setInterval(async () => {
      const mem = await getContainerMemory(container);
      if (mem && mem > peakMemory) peakMemory = mem;
    }, 100);

    const promptResult = await dockerExec(
      container,
      `echo "" | HOME=${userHome} ${claudePath} -p "Reply with exactly: SUCCESS" --output-format text 2>&1`,
      { timeout: 120000, env: [`HOME=${userHome}`] }
    );

    clearInterval(memInterval);
    const promptMs = performance.now() - promptStart;
    const e2eMs = performance.now() - e2eStart;

    // Final memory reading
    const finalMemory = await getContainerMemory(container);
    if (finalMemory && finalMemory > peakMemory) peakMemory = finalMemory;

    const success = promptResult.stdout.includes('SUCCESS');

    console.log(`Startup: ${startupMs.toFixed(0)}ms`);
    console.log(`Prompt: ${promptMs.toFixed(0)}ms`);
    console.log(`E2E: ${e2eMs.toFixed(0)}ms`);
    console.log(`Peak Memory: ${peakMemory.toFixed(1)} MiB`);
    console.log(`Result: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);

    if (!success) {
      console.log(`Output: ${promptResult.stdout.slice(-300)}`);
    }

    results.push({
      provider: 'Docker (dockerode)',
      startupMs,
      promptMs,
      e2eMs,
      peakMemoryMib: peakMemory,
      success
    });

    // Cleanup
    await container.stop({ t: 1 });
    await container.remove();
    rmSync(workspace, { recursive: true, force: true });
  }

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('DOCKERODE BENCHMARK RESULT');
  console.log('═'.repeat(60));

  console.log('\n| Provider | Startup | Prompt | E2E | Memory | Result |');
  console.log('|----------|---------|--------|-----|--------|--------|');
  for (const r of results) {
    const startup = `${Math.round(r.startupMs)}ms`.padEnd(7);
    const prompt = `${Math.round(r.promptMs)}ms`.padEnd(6);
    const e2e = `${Math.round(r.e2eMs)}ms`.padEnd(6);
    const memory = r.peakMemoryMib ? `${r.peakMemoryMib.toFixed(0)}MB`.padEnd(6) : 'N/A'.padEnd(6);
    const result = r.success ? '✅' : '❌';
    console.log(`| ${r.provider.padEnd(18)} | ${startup} | ${prompt} | ${e2e} | ${memory} | ${result}     |`);
  }

  // Save results
  const resultsFile = `results/benchmark-dockerode-${Date.now()}.json`;
  mkdirSync('results', { recursive: true });
  writeFileSync(resultsFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    image: CLAUDE_IMAGE,
    results
  }, null, 2));
  console.log(`\nResults saved to: ${resultsFile}`);
}

main().catch(console.error);
