import Anthropic from '@anthropic-ai/sdk';

interface BenchmarkResult {
  apiCallMs: number;
  tokensIn: number;
  tokensOut: number;
  success: boolean;
  error?: string;
}

/**
 * Benchmark agent for measuring API call performance within sandbox
 */
async function runBenchmark(iterations: number = 5): Promise<BenchmarkResult[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY required for benchmark');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });
  const results: BenchmarkResult[] = [];

  console.log(`Running ${iterations} API calls...`);

  for (let i = 0; i < iterations; i++) {
    const startTime = performance.now();

    try {
      const message = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 50,
        messages: [
          {
            role: 'user',
            content: `Echo back: iteration_${i}`,
          },
        ],
      });

      const duration = performance.now() - startTime;

      results.push({
        apiCallMs: duration,
        tokensIn: message.usage.input_tokens,
        tokensOut: message.usage.output_tokens,
        success: true,
      });

      console.log(`  [${i + 1}/${iterations}] ${duration.toFixed(2)}ms`);
    } catch (err) {
      const duration = performance.now() - startTime;
      results.push({
        apiCallMs: duration,
        tokensIn: 0,
        tokensOut: 0,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
      console.log(`  [${i + 1}/${iterations}] FAILED: ${err}`);
    }
  }

  // Calculate stats
  const successful = results.filter(r => r.success);
  if (successful.length > 0) {
    const times = successful.map(r => r.apiCallMs);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const sorted = [...times].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;

    console.log('\nBenchmark Results:');
    console.log(`  Successful: ${successful.length}/${iterations}`);
    console.log(`  Mean: ${mean.toFixed(2)}ms`);
    console.log(`  P50: ${p50.toFixed(2)}ms`);
    console.log(`  P95: ${p95.toFixed(2)}ms`);
  }

  return results;
}

// Run if executed directly
const iterations = parseInt(process.argv[2] || '5', 10);
runBenchmark(iterations).then(results => {
  console.log('\nRaw results:', JSON.stringify(results, null, 2));
});
