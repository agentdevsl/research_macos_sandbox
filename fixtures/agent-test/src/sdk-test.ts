/**
 * Test script that validates Claude Agent SDK works inside the sandbox.
 * Uses the async generator query API correctly.
 */
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

async function main() {
  const startTime = performance.now();

  console.log('=== Claude Agent SDK Test ===');
  console.log(`Node version: ${process.version}`);
  console.log(`Working directory: ${process.cwd()}`);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ERROR: ANTHROPIC_API_KEY not set');
    process.exit(1);
  }

  console.log('API key found, running Agent SDK query...');

  try {
    const queryStart = performance.now();

    // query() returns an AsyncGenerator<SDKMessage>
    const agentQuery = query({
      prompt: 'Respond with exactly: AGENT_SDK_OK',
      options: {
        cwd: process.cwd(),
        tools: [], // No tools needed for simple response
      },
    });

    let response = '';
    let resultSubtype = '';

    // Consume the async generator
    for await (const message of agentQuery) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') {
            response += block.text;
          }
        }
      } else if (message.type === 'result') {
        resultSubtype = message.subtype;
      }
    }

    const queryDuration = performance.now() - queryStart;
    const totalDuration = performance.now() - startTime;

    console.log(`Response: ${response}`);
    console.log(`Result: ${resultSubtype}`);
    console.log(`Query duration: ${queryDuration.toFixed(2)}ms`);
    console.log(`Total duration: ${totalDuration.toFixed(2)}ms`);

    const success = response.includes('AGENT_SDK_OK');

    // Output JSON for parsing
    console.log(JSON.stringify({
      success,
      queryDurationMs: queryDuration,
      totalDurationMs: totalDuration,
      resultSubtype,
    }));

    process.exit(success ? 0 : 1);
  } catch (err) {
    console.error('Agent SDK test failed:', err);
    process.exit(1);
  }
}

main();
