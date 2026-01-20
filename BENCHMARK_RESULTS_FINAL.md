# Sandbox Provider Benchmark Results

**Date:** 2026-01-20
**Test:** Claude Agent SDK + Claude Code CLI with subscription OAuth token

## Summary

| Provider | SDK | CLI | Startup | 5 Concurrent | Memory/Instance |
|----------|-----|-----|---------|--------------|-----------------|
| **Docker Direct** | ✅ | ✅ | 198ms | ✅ 24s | 17 MB |
| **OrbStack** | ✅ | ✅ | 131ms | ✅ 40s | 146 MB |
| **BoxLite** | ✅ | ❌ | 423ms | ❌ | ~150 MB |
| **AppleContainer** | ✅ | ❌ | 4643ms | ✅ 52s | N/A |

## Detailed Results

### Docker Direct (docker CLI baseline)

**Baseline test using docker CLI directly**

- **Startup:** 198ms
- **SDK Test:** ✅ SUCCESS (exec: 4.3s)
- **CLI Test:** ✅ SUCCESS (exec: 7.2s)
- **5 Concurrent:** ✅ SUCCESS (total: 24s, avg startup: 446ms)
- **Memory:** 17 MB per instance (lower due to measurement timing)

```
Docker version 29.1.3
Image: alpine:latest
```

**Note:** Direct docker CLI benchmark for comparison. Uses same authentication method (credentials file via host mount).

### OrbStack (Docker Container)

**Best overall performance - all tests pass**

- **Startup:** 131ms (fastest)
- **SDK Test:** ✅ SUCCESS (exec: 3.8s)
- **CLI Test:** ✅ SUCCESS (exec: 4.0s)
- **5 Concurrent:** ✅ SUCCESS (total: 40s, avg startup: 668ms)
- **Memory:** 146 MB per instance

```
Provider: orbstack v29.1.3
Image: alpine:latest
```

### BoxLite (libkrun Micro-VM)

**SDK works, CLI hangs**

- **Startup:** 423ms
- **SDK Test:** ✅ SUCCESS (exec: 20s - slower than OrbStack)
- **CLI Test:** ❌ FAILED (hangs/times out at 120s)
- **5 Concurrent:** ❌ FAILED (0/5 succeeded)
- **Memory:** ~150 MB per instance

```
Provider: boxlite v0.1.6
Image: alpine:latest
```

**Note:** The CLI appears to hang when called through BoxLite's exec mechanism. The SDK works but is significantly slower than OrbStack. Concurrent SDK calls all fail (possibly rate limiting).

### Apple Container (macOS 26+ Native)

**SDK works, CLI hangs, slowest startup**

- **Startup:** 4643ms (slowest - full VM boot)
- **SDK Test:** ✅ SUCCESS (exec: 7.9s)
- **CLI Test:** ❌ FAILED (hangs/times out at 120s)
- **5 Concurrent:** ✅ SUCCESS (total: 52s, avg startup: 4.7s)
- **Memory:** N/A (stats not available)

```
Provider: container CLI v0.7.1
Image: node:22-slim
```

**Note:** The long startup time is expected for a full VM. Concurrent instances work well despite high startup time.

## Authentication Method

All tests use the OAuth token workaround:

1. Write credentials to `~/.claude/.credentials.json`
2. Use heredoc for reliable JSON writing
3. Run as non-root user (uid=1000) for `bypassPermissions` mode

See `SDK_AUTH_WORKAROUND.md` for details.

## Configuration

All providers configured with:
- **Memory:** 2048 MiB (single), 1024 MiB (concurrent)
- **CPUs:** 2 (single), 1 (concurrent)
- **User:** sandbox (uid=1000, gid=1000)
- **Environment:** `CI=true`, `TERM=dumb`

## Recommendations

1. **For production use:** OrbStack (fastest, most reliable)
2. **For VM isolation:** Apple Container (slower but full VM)
3. **BoxLite:** SDK-only workloads (CLI has issues)

## Test Files

- `benchmark-all-providers.mjs` - Main benchmark script
- `test-sdk-with-credsfile.mjs` - SDK test template
- `test-sdk-orbstack.mjs` - OrbStack-specific test
- `test-sdk-apple-container.mjs` - Apple Container test

## Raw Results

```json
{
  "DockerDirect": {
    "sdk": { "success": true, "startupMs": 198, "execMs": 4286 },
    "cli": { "success": true, "startupMs": 198, "execMs": 7171 },
    "concurrent": { "success": true, "instances": 5, "totalMs": 23524, "avgMemoryMb": 16.8 }
  },
  "OrbStack": {
    "sdk": { "success": true, "startupMs": 151, "execMs": 3816 },
    "cli": { "success": true, "startupMs": 123, "execMs": 3954 },
    "concurrent": { "success": true, "instances": 5, "totalMs": 39772, "avgMemoryMb": 146.3 }
  },
  "BoxLite": {
    "sdk": { "success": true, "startupMs": 423, "execMs": 20433 },
    "cli": { "success": false, "startupMs": 314, "execMs": 120494 },
    "concurrent": { "success": false, "instances": 5, "totalMs": 10772 }
  },
  "AppleContainer": {
    "sdk": { "success": true, "startupMs": 4643, "execMs": 7945 },
    "cli": { "success": false, "startupMs": 1449, "execMs": 120105 },
    "concurrent": { "success": true, "instances": 5, "totalMs": 52105 }
  }
}
```
