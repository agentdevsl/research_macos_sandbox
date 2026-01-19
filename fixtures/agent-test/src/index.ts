/**
 * Test agent that validates the Claude Agent SDK works inside the sandbox.
 * Uses the correct async generator API.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

async function main() {
  console.log('=== Claude Agent SDK Test ===');
  console.log(`Node version: ${process.version}`);
  console.log(`Working directory: ${process.cwd()}`);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('ANTHROPIC_API_KEY not set - running validation only');
    // Validate the SDK exports exist
    console.log('SDK query function type:', typeof query);
    console.log('Test completed (no API key)');
    process.exit(0);
  }

  console.log('ANTHROPIC_API_KEY found, running agent query...');

  try {
    const startTime = performance.now();

    // The query() function returns an AsyncGenerator that yields SDKMessages
    const agentQuery = query({
      prompt: 'Respond with exactly: AGENT_SDK_OK',
      options: {
        cwd: process.cwd(),
        // Disable all tools for this simple test
        tools: [],
      },
    });

    let response = '';
    let messageCount = 0;

    // Iterate through the async generator
    for await (const message of agentQuery) {
      messageCount++;

      // Handle different message types
      if (message.type === 'assistant') {
        // Extract text from assistant message
        for (const block of message.message.content) {
          if (block.type === 'text') {
            response += block.text;
          }
        }
      } else if (message.type === 'result') {
        console.log('Query result:', message.subtype);
      }
    }

    const duration = performance.now() - startTime;

    console.log(`Response: ${response}`);
    console.log(`Duration: ${duration.toFixed(2)}ms`);
    console.log(`Messages received: ${messageCount}`);

    const success = response.includes('AGENT_SDK_OK');

    // Output JSON for parsing
    console.log(JSON.stringify({
      success,
      durationMs: duration,
      messageCount,
    }));

    process.exit(success ? 0 : 1);
  } catch (err) {
    console.error('Agent SDK test failed:', err);
    process.exit(1);
  }
}

main();
