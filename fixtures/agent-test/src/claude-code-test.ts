/**
 * Test script that validates Claude Code CLI works inside the sandbox.
 * This runs the actual claude CLI command to verify it functions properly.
 */
import { execSync, spawn } from 'node:child_process';

async function main() {
  const startTime = performance.now();

  console.log('=== Claude Code CLI Test ===');
  console.log(`Node version: ${process.version}`);
  console.log(`Working directory: ${process.cwd()}`);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ERROR: ANTHROPIC_API_KEY not set');
    process.exit(1);
  }

  // Test 1: Version check
  console.log('\n--- Test 1: Version Check ---');
  try {
    const versionStart = performance.now();
    const version = execSync('claude --version', { encoding: 'utf-8' }).trim();
    const versionDuration = performance.now() - versionStart;
    console.log(`Claude CLI version: ${version}`);
    console.log(`Version check duration: ${versionDuration.toFixed(2)}ms`);
  } catch (err) {
    console.error('Version check failed:', err);
    process.exit(1);
  }

  // Test 2: Simple prompt execution
  console.log('\n--- Test 2: Simple Prompt ---');
  try {
    const promptStart = performance.now();

    // Run claude with a simple prompt in non-interactive mode
    const result = execSync(
      'claude -p "Respond with exactly: CLAUDE_CODE_OK" --max-turns 1 --output-format text 2>&1',
      {
        encoding: 'utf-8',
        env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
        timeout: 60000,
      }
    );

    const promptDuration = performance.now() - promptStart;
    console.log(`Response: ${result.substring(0, 200)}`);
    console.log(`Prompt duration: ${promptDuration.toFixed(2)}ms`);

    const success = result.includes('CLAUDE_CODE_OK');
    console.log(`Success: ${success}`);

    const totalDuration = performance.now() - startTime;

    // Output JSON for parsing
    console.log(JSON.stringify({
      success,
      promptDurationMs: promptDuration,
      totalDurationMs: totalDuration,
    }));

    process.exit(success ? 0 : 1);
  } catch (err) {
    console.error('Prompt execution failed:', err);
    process.exit(1);
  }
}

main();
