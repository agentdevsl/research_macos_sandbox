#!/usr/bin/env node
/**
 * Memory Usage Benchmark
 * Measures total memory consumption across providers
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
  return value; // MiB
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     Memory Usage Benchmark                                 ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  const testId = randomUUID().slice(0, 8);
  const results = [];

  // Get system memory before
  const systemMemBefore = runCommand('vm_stat | grep "Pages free"').stdout;
  console.log(`\nSystem memory (before): ${systemMemBefore}`);

  // 1. Docker Direct with claude-code image
  console.log('\n--- Docker Direct (claude-code image) ---');
  {
    const containerId = `mem-docker-${testId}`;
    const workspace = `/tmp/mem-docker-${testId}`;
    mkdirSync(workspace, { recursive: true });

    runCommand(`docker run -d --name ${containerId} -v ${workspace}:/workspace -e CI=true ${CLAUDE_IMAGE} tail -f /dev/null`);

    // Setup
    writeFileSync(`${workspace}/.credentials.json`, JSON.stringify(credentials));
    writeFileSync(`${workspace}/.settings.json`, JSON.stringify(settings));
    dockerExec(containerId, 'mkdir -p /home/agent/.claude');
    dockerExec(containerId, 'cp /workspace/.credentials.json /home/agent/.claude/.credentials.json');
    dockerExec(containerId, 'chmod 600 /home/agent/.claude/.credentials.json');
    dockerExec(containerId, 'rm -f /home/agent/.claude/settings.json');
    dockerExec(containerId, 'cp /workspace/.settings.json /home/agent/.claude/settings.json');

    // Run prompt
    const promptResult = dockerExec(
      containerId,
      `cd /workspace && HOME=/home/agent claude -p "Reply with exactly: SUCCESS" --output-format text 2>&1`,
      { timeout: 120000 }
    );
    const success = promptResult.stdout.includes('SUCCESS');

    // Measure memory after prompt
    const memoryMib = getDockerMemory(containerId);
    console.log(`Memory: ${memoryMib?.toFixed(1) || 'N/A'} MiB`);
    console.log(`Result: ${success ? '✅' : '❌'}`);

    results.push({ provider: 'Docker Direct', memoryMib, success });
    runCommand(`docker rm -f ${containerId}`);
  }

  // 2. Docker Sandbox
  console.log('\n--- Docker Sandbox ---');
  {
    const sandboxName = `mem-sandbox-${testId}`;
    const workspace = `/tmp/mem-sandbox-${testId}`;
    mkdirSync(workspace, { recursive: true });

    runCommand(`docker sandbox run -d --name ${sandboxName} -w ${workspace} claude`, { timeout: 120000 });
    const containerId = runCommand(`docker ps --filter "name=${sandboxName}" --format "{{.ID}}"`, { timeout: 5000 }).stdout.trim();

    // Setup
    writeFileSync(`${workspace}/.credentials.json`, JSON.stringify(credentials));
    writeFileSync(`${workspace}/.settings.json`, JSON.stringify(settings));
    dockerExec(containerId, 'mkdir -p /home/agent/.claude');
    dockerExec(containerId, `cp ${workspace}/.credentials.json /home/agent/.claude/.credentials.json`);
    dockerExec(containerId, 'chmod 600 /home/agent/.claude/.credentials.json');
    dockerExec(containerId, 'rm -f /home/agent/.claude/settings.json');
    dockerExec(containerId, `cp ${workspace}/.settings.json /home/agent/.claude/settings.json`);

    // Run prompt
    const promptResult = dockerExec(
      containerId,
      `cd ${workspace} && HOME=/home/agent claude -p "Reply with exactly: SUCCESS" --output-format text 2>&1`,
      { timeout: 120000 }
    );
    const success = promptResult.stdout.includes('SUCCESS');

    // Measure memory
    const memoryMib = getDockerMemory(containerId);
    console.log(`Memory: ${memoryMib?.toFixed(1) || 'N/A'} MiB`);
    console.log(`Result: ${success ? '✅' : '❌'}`);

    results.push({ provider: 'Docker Sandbox', memoryMib, success });
    runCommand(`docker stop ${sandboxName}`, { timeout: 10000 });
    runCommand(`docker rm ${sandboxName}`, { timeout: 10000 });
  }

  // 3. Multiple concurrent instances (5x Docker Direct)
  console.log('\n--- 5x Docker Direct (concurrent) ---');
  {
    const containers = [];
    let totalMemory = 0;
    let successCount = 0;

    // Create 5 containers
    for (let i = 0; i < 5; i++) {
      const containerId = `mem-concurrent-${testId}-${i}`;
      const workspace = `/tmp/mem-concurrent-${testId}-${i}`;
      mkdirSync(workspace, { recursive: true });

      runCommand(`docker run -d --name ${containerId} -v ${workspace}:/workspace -e CI=true ${CLAUDE_IMAGE} tail -f /dev/null`);

      writeFileSync(`${workspace}/.credentials.json`, JSON.stringify(credentials));
      writeFileSync(`${workspace}/.settings.json`, JSON.stringify(settings));
      dockerExec(containerId, 'mkdir -p /home/agent/.claude');
      dockerExec(containerId, 'cp /workspace/.credentials.json /home/agent/.claude/.credentials.json');
      dockerExec(containerId, 'chmod 600 /home/agent/.claude/.credentials.json');
      dockerExec(containerId, 'rm -f /home/agent/.claude/settings.json');
      dockerExec(containerId, 'cp /workspace/.settings.json /home/agent/.claude/settings.json');

      containers.push({ id: containerId, workspace });
    }

    // Run prompts concurrently
    const prompts = containers.map((c, i) =>
      new Promise(resolve => {
        const result = dockerExec(
          c.id,
          `cd /workspace && HOME=/home/agent claude -p "Reply: SUCCESS ${i}" --output-format text 2>&1`,
          { timeout: 120000 }
        );
        resolve(result);
      })
    );

    const promptResults = await Promise.all(prompts);
    successCount = promptResults.filter(r => r.stdout.includes('SUCCESS')).length;

    // Measure memory for each
    for (const c of containers) {
      const mem = getDockerMemory(c.id);
      if (mem) totalMemory += mem;
    }

    console.log(`Total Memory (5 instances): ${totalMemory.toFixed(1)} MiB`);
    console.log(`Avg Memory per instance: ${(totalMemory / 5).toFixed(1)} MiB`);
    console.log(`Result: ${successCount}/5 succeeded`);

    results.push({
      provider: '5x Docker Direct',
      totalMemoryMib: totalMemory,
      avgMemoryMib: totalMemory / 5,
      successCount
    });

    // Cleanup
    for (const c of containers) {
      runCommand(`docker rm -f ${c.id}`);
    }
  }

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('MEMORY USAGE SUMMARY');
  console.log('═'.repeat(60));

  console.log('\n| Provider | Memory | Result |');
  console.log('|----------|--------|--------|');
  for (const r of results) {
    const mem = r.totalMemoryMib
      ? `${r.totalMemoryMib.toFixed(0)} MiB total (${r.avgMemoryMib?.toFixed(0)} avg)`
      : `${r.memoryMib?.toFixed(0) || 'N/A'} MiB`;
    const result = r.success !== undefined
      ? (r.success ? '✅' : '❌')
      : `${r.successCount}/5`;
    console.log(`| ${r.provider.padEnd(20)} | ${mem.padEnd(25)} | ${result} |`);
  }

  // Save results
  const resultsFile = `results/benchmark-memory-${Date.now()}.json`;
  mkdirSync('results', { recursive: true });
  writeFileSync(resultsFile, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
  console.log(`\nResults saved to: ${resultsFile}`);
}

main().catch(console.error);
