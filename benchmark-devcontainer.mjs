#!/usr/bin/env node
/**
 * Devcontainer Benchmark
 * Tests devcontainer CLI as a sandbox provider
 */
import { execSync, spawnSync } from 'node:child_process';
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

function runCommand(cmd, options = {}) {
  const timeout = options.timeout || 120000;
  try {
    const result = execSync(cmd, {
      encoding: 'utf-8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      cwd: options.cwd,
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
  console.log('║     Devcontainer Benchmark                                 ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  console.log(`\nImage: ${CLAUDE_IMAGE}`);
  console.log(`Token: ${authToken.slice(0, 25)}...`);

  const testId = randomUUID().slice(0, 8);
  const workspace = `/tmp/devcontainer-bench-${testId}`;

  // Create workspace with devcontainer config
  mkdirSync(`${workspace}/.devcontainer`, { recursive: true });
  writeFileSync(`${workspace}/.devcontainer/devcontainer.json`, JSON.stringify({
    name: "Claude Benchmark",
    image: CLAUDE_IMAGE,
    remoteUser: "agent",
    containerEnv: {
      CI: "true",
      TERM: "dumb"
    }
  }, null, 2));

  console.log('\n' + '─'.repeat(60));
  console.log('Provider: Devcontainer');
  console.log('─'.repeat(60));

  const e2eStart = performance.now();
  const startupStart = performance.now();

  // Start devcontainer
  const upResult = runCommand(`devcontainer up --workspace-folder ${workspace}`, { timeout: 120000 });
  const startupMs = performance.now() - startupStart;

  if (upResult.exitCode !== 0) {
    console.log(`Error starting devcontainer: ${upResult.stderr}`);
    rmSync(workspace, { recursive: true, force: true });
    return;
  }

  // Parse container ID from output
  const outputMatch = upResult.stdout.match(/"containerId":"([^"]+)"/);
  const containerId = outputMatch ? outputMatch[1] : null;
  console.log(`Container ID: ${containerId?.slice(0, 12) || 'unknown'}`);

  // Setup credentials using devcontainer exec
  const userHome = '/home/agent';
  runCommand(`devcontainer exec --workspace-folder ${workspace} sh -c "mkdir -p ${userHome}/.claude"`, { timeout: 30000 });

  // Write credentials and settings to workspace, then copy inside container
  writeFileSync(`${workspace}/.credentials.json`, JSON.stringify(credentials));
  writeFileSync(`${workspace}/.settings.json`, JSON.stringify(settings));

  // Copy credentials from workspace mount to .claude directory
  runCommand(`devcontainer exec --workspace-folder ${workspace} sh -c "cp /workspaces/devcontainer-bench-${testId}/.credentials.json ${userHome}/.claude/.credentials.json"`, { timeout: 30000 });
  runCommand(`devcontainer exec --workspace-folder ${workspace} sh -c "chmod 600 ${userHome}/.claude/.credentials.json"`, { timeout: 30000 });
  runCommand(`devcontainer exec --workspace-folder ${workspace} sh -c "cp /workspaces/devcontainer-bench-${testId}/.settings.json ${userHome}/.claude/settings.json"`, { timeout: 30000 });

  // Run Claude CLI with stdin fix
  const claudePath = '/home/agent/.local/bin/claude';
  const promptStart = performance.now();

  // Track peak memory during execution
  let peakMemory = 0;
  const memInterval = containerId ? setInterval(() => {
    const mem = getDockerMemory(containerId);
    if (mem && mem > peakMemory) peakMemory = mem;
  }, 100) : null;

  const promptResult = runCommand(
    `devcontainer exec --workspace-folder ${workspace} sh -c "echo '' | HOME=${userHome} ${claudePath} -p 'Reply with exactly: SUCCESS' --output-format text 2>&1"`,
    { timeout: 120000 }
  );

  if (memInterval) clearInterval(memInterval);
  const promptMs = performance.now() - promptStart;
  const e2eMs = performance.now() - e2eStart;

  // Final memory reading
  if (containerId) {
    const finalMemory = getDockerMemory(containerId);
    if (finalMemory && finalMemory > peakMemory) peakMemory = finalMemory;
  }

  const success = promptResult.stdout.includes('SUCCESS');

  console.log(`Startup: ${startupMs.toFixed(0)}ms`);
  console.log(`Prompt: ${promptMs.toFixed(0)}ms`);
  console.log(`E2E: ${e2eMs.toFixed(0)}ms`);
  console.log(`Peak Memory: ${peakMemory > 0 ? peakMemory.toFixed(1) : 'N/A'} MiB`);
  console.log(`Result: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);

  if (!success) {
    console.log(`Output: ${promptResult.stdout.slice(-500)}`);
    console.log(`Stderr: ${promptResult.stderr.slice(-200)}`);
  }

  // Cleanup
  if (containerId) {
    runCommand(`docker rm -f ${containerId}`, { timeout: 10000 });
  }
  rmSync(workspace, { recursive: true, force: true });

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('DEVCONTAINER BENCHMARK RESULT');
  console.log('═'.repeat(60));
  console.log(`\nImage: ${CLAUDE_IMAGE}`);
  console.log(`Isolation: Container (same as Docker Direct)`);
  console.log(`\n| Metric | Value |`);
  console.log(`|--------|-------|`);
  console.log(`| Startup | ${startupMs.toFixed(0)}ms |`);
  console.log(`| Prompt | ${promptMs.toFixed(0)}ms |`);
  console.log(`| E2E | ${e2eMs.toFixed(0)}ms |`);
  console.log(`| Memory | ${peakMemory > 0 ? peakMemory.toFixed(0) + ' MiB' : 'N/A'} |`);
  console.log(`| Result | ${success ? '✅ SUCCESS' : '❌ FAILED'} |`);

  // Save results
  const resultsFile = `results/benchmark-devcontainer-${Date.now()}.json`;
  mkdirSync('results', { recursive: true });
  writeFileSync(resultsFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    image: CLAUDE_IMAGE,
    provider: 'Devcontainer',
    isolation: 'Container',
    startupMs,
    promptMs,
    e2eMs,
    peakMemoryMib: peakMemory > 0 ? peakMemory : null,
    success
  }, null, 2));
  console.log(`\nResults saved to: ${resultsFile}`);
}

main().catch(console.error);
