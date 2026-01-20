#!/usr/bin/env node
/**
 * Fair Comparison Benchmark - All Providers
 * Uses the same image (docker/sandbox-templates:claude-code) for all providers
 * Measures: startup, E2E, prompt time, and memory usage
 */
import { execSync } from 'node:child_process';
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

function runCommand(cmd, options = {}) {
  const timeout = options.timeout || 120000;
  try {
    const result = execSync(cmd, {
      encoding: 'utf-8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: result.trim(), stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status || 1,
      stdout: err.stdout?.toString().trim() || '',
      stderr: err.stderr?.toString().trim() || err.message,
    };
  }
}

function dockerExec(containerId, cmd, options = {}) {
  return runCommand(`docker exec ${containerId} sh -c "${cmd.replace(/"/g, '\\"')}"`, options);
}

function getDockerMemory(containerId) {
  const stats = runCommand(`docker stats ${containerId} --no-stream --format "{{.MemUsage}}"`, { timeout: 10000 });
  const match = stats.stdout.match(/(\d+(?:\.\d+)?)\s*(MiB|GiB|KiB)/i);
  if (!match) return null;
  let value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'gib') value *= 1024;
  if (unit === 'kib') value /= 1024;
  return value;
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     Fair Comparison - All Providers (Same Image)          ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  console.log(`\nImage: ${CLAUDE_IMAGE}`);
  console.log(`Token: ${authToken.slice(0, 25)}...`);

  const testId = randomUUID().slice(0, 8);
  const results = [];

  // 1. Docker Direct
  console.log('\n' + '─'.repeat(60));
  console.log('Provider: Docker Direct');
  console.log('─'.repeat(60));
  {
    const containerId = `fair-docker-${testId}`;
    const workspace = `/tmp/fair-docker-${testId}`;
    mkdirSync(workspace, { recursive: true });

    const e2eStart = performance.now();
    const startupStart = performance.now();
    // No resource limits - Docker Sandbox doesn't support them, so we don't set them for fair comparison
    runCommand(`docker run -d --name ${containerId} -v ${workspace}:/workspace -e CI=true ${CLAUDE_IMAGE} tail -f /dev/null`);
    const startupMs = performance.now() - startupStart;

    // Setup credentials
    writeFileSync(`${workspace}/.credentials.json`, JSON.stringify(credentials));
    writeFileSync(`${workspace}/.settings.json`, JSON.stringify(settings));
    dockerExec(containerId, 'mkdir -p /home/agent/.claude');
    dockerExec(containerId, 'cp /workspace/.credentials.json /home/agent/.claude/.credentials.json');
    dockerExec(containerId, 'chmod 600 /home/agent/.claude/.credentials.json');
    dockerExec(containerId, 'rm -f /home/agent/.claude/settings.json');
    dockerExec(containerId, 'cp /workspace/.settings.json /home/agent/.claude/settings.json');

    // Run prompt and measure memory during execution
    const promptStart = performance.now();

    // Start a background process to measure memory during execution
    let peakMemory = 0;
    const memInterval = setInterval(() => {
      const mem = getDockerMemory(containerId);
      if (mem && mem > peakMemory) peakMemory = mem;
    }, 100);

    const promptResult = dockerExec(
      containerId,
      'cd /workspace && HOME=/home/agent claude -p "Reply with exactly: SUCCESS" --output-format text 2>&1',
      { timeout: 120000 }
    );

    clearInterval(memInterval);
    const promptMs = performance.now() - promptStart;
    const e2eMs = performance.now() - e2eStart;
    const success = promptResult.stdout.includes('SUCCESS');

    // Final memory reading
    const finalMemory = getDockerMemory(containerId);
    if (finalMemory && finalMemory > peakMemory) peakMemory = finalMemory;

    console.log(`Startup: ${startupMs.toFixed(0)}ms`);
    console.log(`Prompt: ${promptMs.toFixed(0)}ms`);
    console.log(`E2E: ${e2eMs.toFixed(0)}ms`);
    console.log(`Peak Memory: ${peakMemory.toFixed(1)} MiB`);
    console.log(`Result: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);

    results.push({ provider: 'Docker Direct', startupMs, promptMs, e2eMs, peakMemoryMib: peakMemory, success });
    runCommand(`docker rm -f ${containerId}`);
  }

  // 2. Docker Sandbox
  console.log('\n' + '─'.repeat(60));
  console.log('Provider: Docker Sandbox');
  console.log('─'.repeat(60));
  {
    const sandboxName = `fair-sandbox-${testId}`;
    const workspace = `/tmp/fair-sandbox-${testId}`;
    mkdirSync(workspace, { recursive: true });

    const e2eStart = performance.now();
    const startupStart = performance.now();
    runCommand(`docker sandbox run -d --name ${sandboxName} -w ${workspace} claude`, { timeout: 120000 });
    const containerId = runCommand(`docker ps --filter "name=${sandboxName}" --format "{{.ID}}"`, { timeout: 5000 }).stdout.trim();
    const startupMs = performance.now() - startupStart;

    // Setup credentials
    writeFileSync(`${workspace}/.credentials.json`, JSON.stringify(credentials));
    writeFileSync(`${workspace}/.settings.json`, JSON.stringify(settings));
    dockerExec(containerId, 'mkdir -p /home/agent/.claude');
    dockerExec(containerId, `cp ${workspace}/.credentials.json /home/agent/.claude/.credentials.json`);
    dockerExec(containerId, 'chmod 600 /home/agent/.claude/.credentials.json');
    dockerExec(containerId, 'rm -f /home/agent/.claude/settings.json');
    dockerExec(containerId, `cp ${workspace}/.settings.json /home/agent/.claude/settings.json`);

    // Run prompt and measure memory
    const promptStart = performance.now();
    let peakMemory = 0;
    const memInterval = setInterval(() => {
      const mem = getDockerMemory(containerId);
      if (mem && mem > peakMemory) peakMemory = mem;
    }, 100);

    const promptResult = dockerExec(
      containerId,
      `cd ${workspace} && HOME=/home/agent claude -p "Reply with exactly: SUCCESS" --output-format text 2>&1`,
      { timeout: 120000 }
    );

    clearInterval(memInterval);
    const promptMs = performance.now() - promptStart;
    const e2eMs = performance.now() - e2eStart;
    const success = promptResult.stdout.includes('SUCCESS');

    const finalMemory = getDockerMemory(containerId);
    if (finalMemory && finalMemory > peakMemory) peakMemory = finalMemory;

    console.log(`Startup: ${startupMs.toFixed(0)}ms`);
    console.log(`Prompt: ${promptMs.toFixed(0)}ms`);
    console.log(`E2E: ${e2eMs.toFixed(0)}ms`);
    console.log(`Peak Memory: ${peakMemory.toFixed(1)} MiB`);
    console.log(`Result: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);

    results.push({ provider: 'Docker Sandbox', startupMs, promptMs, e2eMs, peakMemoryMib: peakMemory, success });
    runCommand(`docker stop ${sandboxName}`, { timeout: 10000 });
    runCommand(`docker rm ${sandboxName}`, { timeout: 10000 });
  }

  // 3. BoxLite (with same image)
  console.log('\n' + '─'.repeat(60));
  console.log('Provider: BoxLite');
  console.log('─'.repeat(60));
  try {
    const { BoxLiteProvider } = await import('./packages/sandbox-boxlite/dist/index.js');
    const { generateSandboxId } = await import('./packages/sandbox-core/dist/index.js');

    const id = generateSandboxId('fair-boxlite');
    const mountPath = `/tmp/fair-boxlite-${testId}`;
    mkdirSync(mountPath, { recursive: true });

    const e2eStart = performance.now();
    const startupStart = performance.now();

    const provider = new BoxLiteProvider();
    const sandbox = await provider.create({
      id,
      image: CLAUDE_IMAGE,
      mountPath,
      // Micro-VMs require explicit memory - default is too low for Claude
      memoryMib: 4096,
      cpus: 4,
      env: { CI: 'true', TERM: 'dumb' },
      user: { name: 'agent', uid: 1000, gid: 1000 },
    });
    const startupMs = performance.now() - startupStart;

    // Setup credentials (use /home/agent for claude-code image)
    const userHome = '/home/agent';
    await sandbox.exec('sh', ['-c', `mkdir -p ${userHome}/.claude`]);
    await sandbox.exec('sh', ['-c', `cat > ${userHome}/.claude/.credentials.json << 'EOF'\n${JSON.stringify(credentials)}\nEOF`]);
    await sandbox.exec('sh', ['-c', `cat > ${userHome}/.claude/settings.json << 'EOF'\n${JSON.stringify(settings)}\nEOF`]);

    // Run prompt with stdin fix and full path (claude is at /home/agent/.local/bin/claude)
    const claudePath = '/home/agent/.local/bin/claude';
    const promptStart = performance.now();
    const promptResult = await sandbox.exec('sh', ['-c', `echo "" | HOME=${userHome} ${claudePath} -p "Reply with exactly: SUCCESS" --output-format text 2>&1`]);
    const promptMs = performance.now() - promptStart;
    const e2eMs = performance.now() - e2eStart;
    const success = promptResult.stdout?.includes('SUCCESS');

    // Get memory from sandbox metrics
    const metrics = sandbox.getMetrics();
    const peakMemory = metrics.memoryBytes ? metrics.memoryBytes / (1024 * 1024) : null;

    console.log(`Startup: ${startupMs.toFixed(0)}ms`);
    console.log(`Prompt: ${promptMs.toFixed(0)}ms`);
    console.log(`E2E: ${e2eMs.toFixed(0)}ms`);
    console.log(`Peak Memory: ${peakMemory?.toFixed(1) || 'N/A'} MiB`);
    console.log(`Result: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);

    results.push({ provider: 'BoxLite', startupMs, promptMs, e2eMs, peakMemoryMib: peakMemory, success });
    await sandbox.stop();
  } catch (e) {
    console.log(`Error: ${e.message}`);
    results.push({ provider: 'BoxLite', error: e.message });
  }

  // 4. Apple Container (with same image)
  console.log('\n' + '─'.repeat(60));
  console.log('Provider: Apple Container');
  console.log('─'.repeat(60));
  try {
    const { AppleContainerProvider } = await import('./packages/sandbox-apple-container/dist/index.js');
    const { generateSandboxId } = await import('./packages/sandbox-core/dist/index.js');

    const id = generateSandboxId('fair-apple');
    const mountPath = `/tmp/fair-apple-${testId}`;
    mkdirSync(mountPath, { recursive: true });

    const e2eStart = performance.now();
    const startupStart = performance.now();

    const provider = new AppleContainerProvider();
    const sandbox = await provider.create({
      id,
      image: CLAUDE_IMAGE,
      mountPath,
      // Micro-VMs require explicit memory - default is too low for Claude
      memoryMib: 4096,
      cpus: 4,
      env: { CI: 'true', TERM: 'dumb' },
      // Note: claude-code image runs as 'agent' by default, no user switching needed
    });
    const startupMs = performance.now() - startupStart;

    // Setup credentials
    const userHome = '/home/agent';
    await sandbox.exec('sh', ['-c', `mkdir -p ${userHome}/.claude`]);
    await sandbox.exec('sh', ['-c', `cat > ${userHome}/.claude/.credentials.json << 'EOF'\n${JSON.stringify(credentials)}\nEOF`]);
    await sandbox.exec('sh', ['-c', `cat > ${userHome}/.claude/settings.json << 'EOF'\n${JSON.stringify(settings)}\nEOF`]);

    // Run prompt with stdin fix and full path
    const claudePath = '/home/agent/.local/bin/claude';
    const promptStart = performance.now();
    const promptResult = await sandbox.exec('sh', ['-c', `echo "" | HOME=${userHome} ${claudePath} -p "Reply with exactly: SUCCESS" --output-format text 2>&1`]);
    const promptMs = performance.now() - promptStart;
    const e2eMs = performance.now() - e2eStart;
    const success = promptResult.stdout?.includes('SUCCESS');

    // Get memory from sandbox metrics
    const metrics = sandbox.getMetrics();
    const peakMemory = metrics.memoryBytes ? metrics.memoryBytes / (1024 * 1024) : null;

    console.log(`Startup: ${startupMs.toFixed(0)}ms`);
    console.log(`Prompt: ${promptMs.toFixed(0)}ms`);
    console.log(`E2E: ${e2eMs.toFixed(0)}ms`);
    console.log(`Peak Memory: ${peakMemory?.toFixed(1) || 'N/A'} MiB`);
    console.log(`Result: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);

    results.push({ provider: 'Apple Container', startupMs, promptMs, e2eMs, peakMemoryMib: peakMemory, success });
    await sandbox.stop();
  } catch (e) {
    console.log(`Error: ${e.message}`);
    results.push({ provider: 'Apple Container', error: e.message });
  }

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('FAIR COMPARISON SUMMARY');
  console.log('═'.repeat(60));
  console.log(`\nImage: ${CLAUDE_IMAGE}\n`);

  console.log('| Provider | Startup | Prompt | E2E | Memory | Result |');
  console.log('|----------|---------|--------|-----|--------|--------|');
  for (const r of results) {
    if (r.error) {
      console.log(`| ${r.provider.padEnd(16)} | ERROR: ${r.error.slice(0, 40)} |`);
    } else {
      const startup = `${Math.round(r.startupMs)}ms`.padEnd(7);
      const prompt = `${Math.round(r.promptMs)}ms`.padEnd(6);
      const e2e = `${Math.round(r.e2eMs)}ms`.padEnd(6);
      const memory = r.peakMemoryMib ? `${r.peakMemoryMib.toFixed(0)}MB`.padEnd(6) : 'N/A'.padEnd(6);
      const result = r.success ? '✅' : '❌';
      console.log(`| ${r.provider.padEnd(16)} | ${startup} | ${prompt} | ${e2e} | ${memory} | ${result}     |`);
    }
  }

  // Save results
  const resultsFile = `results/benchmark-fair-all-${Date.now()}.json`;
  mkdirSync('results', { recursive: true });
  writeFileSync(resultsFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    image: CLAUDE_IMAGE,
    results
  }, null, 2));
  console.log(`\nResults saved to: ${resultsFile}`);
}

main().catch(console.error);
