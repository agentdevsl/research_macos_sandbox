# Sandbox Provider Benchmark Results

**Date:** 2026-01-20
**Test:** Claude Agent SDK + Claude Code CLI with subscription OAuth token
**Docker Runtime:** Docker Desktop v29.1.3 (VMM backend)
**SDK:** dockerode (for Docker provider)

## Summary

### Fair Comparison (Same Image: `docker/sandbox-templates:claude-code`)

#### SDK-based (Recommended)

| Provider | Startup | Prompt | E2E* | Memory | Isolation | Result |
|----------|---------|--------|------|--------|-----------|--------|
| **Docker*** | **137ms** | 3243ms | **3559ms** | 3 MB | Container | ✅ |
| **Apple Container** | 1402ms | 3703ms | 5351ms | N/A | Full VM | ✅ |
| **BoxLite** | 1216ms | 4159ms | 6701ms | N/A | Micro-VM | ✅ |

*Tested with Docker Desktop v29.1.3. Works with any Docker-compatible runtime via dockerode SDK.

#### CLI-based (Legacy)

| Provider | Startup | Prompt | E2E* | Memory | Isolation | Result |
|----------|---------|--------|------|--------|-----------|--------|
| **Docker Direct** | 252ms | 3831ms | 4608ms | 2 MB | Container | ✅ |
| **BoxLite** | 811ms | 3780ms | 5627ms | N/A | Micro-VM | ✅ |
| **Docker Sandbox** | 1458ms | 3982ms | 5965ms | 58 MB | Container | ✅ |
| **Apple Container** | 1437ms | 4414ms | 6134ms | N/A | Full VM | ✅ |
| **Devcontainer** | 1022ms | 4174ms | 7867ms | 2 MB | Container | ✅ |

*E2E = End-to-end time from container start to first successful API response

**Resource Configuration:**
- Docker/Devcontainer: No explicit limits (use host resources)
- BoxLite/Apple Container: 4GB RAM, 4 CPUs (micro-VMs require explicit allocation)
- Docker Engine: Docker VMM (Virtual Machine Monitor)

**SDK vs CLI Performance:**
- Docker with **dockerode SDK is ~25% faster** than CLI (3.6s vs 4.6s E2E)
- SDK eliminates process spawn overhead for each Docker command

**Notes:**
- All providers use the same pre-built image with Claude Code installed
- **Docker (dockerode SDK) is fastest at 3.6s E2E** - use this for container isolation
- Apple Container (5.4s E2E) provides full VM isolation with good performance
- BoxLite (6.7s E2E) provides micro-VM isolation but slower than Apple Container
- **Docker Sandbox/Devcontainer provide NO additional isolation** - avoid these
- BoxLite requires `user` option and full path to claude binary
- claude-code image runs as `agent` user by default (no user switching needed for Docker)

### Full Provider Comparison

| Provider | SDK | CLI | E2E (SDK) | E2E (CLI) | Isolation | Notes |
|----------|-----|-----|-----------|-----------|-----------|-------|
| **Docker*** | ✅ | ✅ | **3.6s** | 4.6s | Container | Fastest, use dockerode SDK |
| **Apple Container** | ✅ | ✅ | 5.4s | 6.1s | Full VM | Best isolation/performance ratio |
| **BoxLite** | ✅ | ✅ | 6.7s | 5.6s | Micro-VM | Separate kernel via libkrun |
| **Docker Sandbox** | N/A | ✅ | N/A | 6.0s | Container | Avoid - no security benefit |
| **Devcontainer** | N/A | ✅ | N/A | 7.9s | Container | Avoid - slowest, no security benefit |

*Docker provider uses dockerode SDK. Tested with Docker Desktop v29.1.3.

**Isolation Levels:**
- **Container** (Docker Direct/Sandbox/Devcontainer): Namespace isolation, shared host kernel. No additional security in Docker Sandbox or Devcontainer vs plain Docker.
- **Micro-VM** (BoxLite): Lightweight VM with separate kernel via libkrun/KVM. Hardware-level isolation.
- **Full VM** (Apple Container): Complete VM with full kernel separation. Strongest security boundary.

**CLI Workarounds Required:**
- BoxLite: Use full path `/home/agent/.local/bin/claude` and stdin fix `echo "" | claude ...`
- Apple Container: Use stdin fix `echo "" | claude ...`

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

### OrbStack (Docker Container) - Historical

**Note:** This was from earlier testing with OrbStack. Current tests use Docker Desktop.

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

**SDK works, CLI works with stdin fix**

- **Startup:** 423ms
- **SDK Test:** ✅ SUCCESS (exec: 20s - slower than OrbStack)
- **CLI Test:** ✅ SUCCESS (with stdin workaround, exec: 4s)
- **5 Concurrent:** ✅ SUCCESS (with stdin workaround)
- **Memory:** ~150 MB per instance

```
Provider: boxlite v0.1.6
Image: alpine:latest
```

**Root Cause:** BoxLite's exec keeps stdin open, causing Claude CLI to wait indefinitely.

**Fix:** Pipe empty input to close stdin:
```bash
echo "" | claude -p "prompt" --output-format text
```

**Note:** The SDK works but is slower than Docker-based providers. With the stdin fix, CLI also works.

### Apple Container (macOS 26+ Native)

**SDK works, CLI works with stdin fix**

- **Startup:** 1607ms (VM boot)
- **SDK Test:** ✅ SUCCESS (exec: 7.9s)
- **CLI Test:** ✅ SUCCESS (with stdin workaround, exec: 3.7s)
- **5 Concurrent:** ✅ SUCCESS (total: 52s, avg startup: 4.7s)
- **Memory:** N/A (stats not available)

```
Provider: container CLI v0.7.1
Image: node:22-slim
```

**Note:** Same stdin issue as BoxLite - use `echo "" | claude -p ...` to fix. Startup time varies (1.6s - 4.6s).

### Docker Sandbox (Official Docker AI Feature)

**Pre-configured Claude environment - convenience wrapper only, no additional isolation**

- **Startup:** 1387ms (sandbox container setup)
- **E2E:** 6736ms (start to first successful response)
- **SDK Test:** N/A (sandbox pre-configures Claude, no SDK access)
- **CLI Test:** ✅ SUCCESS (with `settings.json` bypassPermissions)
  - Simple prompt: ✅ SUCCESS (3.9s)
  - File creation: ✅ SUCCESS (6.7s)
  - Code execution: ✅ SUCCESS (10.4s)
- **5 Concurrent:** ✅ SUCCESS (total: 18s, avg startup: 1.5s)
- **Memory:** N/A (stats not accessible)

```
Docker Sandbox: docker sandbox run claude
Claude Version: 2.1.12 (pre-installed)
User: /home/agent (pre-configured)
```

**Note:** Docker Sandbox is a convenience wrapper, NOT a security enhancement. It provides no additional isolation over plain Docker (same SecurityOpt, CapDrop, no seccomp profile, no AppArmor).

**What Docker Sandbox provides:**
- Pre-configured Claude environment (no Node.js/npm setup needed)
- Automatic workspace mounting
- Persistent data volume at `/mnt/claude-data`
- Uses `/home/agent` user and workspace

**What Docker Sandbox does NOT provide:**
- No additional security over plain Docker
- No seccomp profile, no dropped capabilities
- No resource limits by default
- No network isolation

**Configuration:**
- Auth via credentials file (written via host mount)
- Bypass permissions via `settings.json` with `{"permissions":{"defaultMode":"bypassPermissions"}}`

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

1. **For fastest E2E (container isolation):** Docker with dockerode SDK (3.6s)
2. **For full VM isolation:** Apple Container (5.4s E2E with SDK, best isolation/performance ratio)
3. **For micro-VM isolation:** BoxLite (6.7s E2E with SDK, separate kernel via libkrun)
4. **Avoid:** Docker Sandbox and Devcontainer - no security benefit over plain Docker, just overhead

**Security Recommendation:** For running untrusted agent-generated code, use **Apple Container** (best isolation with good performance) or BoxLite. Docker-based options share the host kernel.

**Implementation Recommendation:** Use **dockerode SDK** instead of CLI commands for ~25% faster performance.

## Key Files

### Provider Implementations
- `packages/sandbox-orbstack/` - Docker provider using **dockerode SDK**
  - `src/provider.ts` - DockerProvider (uses dockerode for container lifecycle)
  - `src/sandbox.ts` - DockerSandbox (exec, metrics, cleanup)
- `packages/sandbox-boxlite/` - BoxLite micro-VM provider (libkrun)
- `packages/sandbox-apple-container/` - Apple Container full VM provider
- `packages/sandbox-core/` - Core interfaces and utilities

### Benchmark Scripts
- `benchmark-providers-sdk.mjs` - **SDK-based benchmark (recommended)**
- `benchmark-fair-all-providers.mjs` - CLI-based fair comparison
- `benchmark-devcontainer.mjs` - Devcontainer CLI benchmark
- `benchmark-dockerode.mjs` - Standalone dockerode benchmark

### Dependencies
- `dockerode` - Docker SDK for Node.js (used by Docker provider)
- `@boxlite-ai/boxlite` - BoxLite micro-VM runtime
- `@anthropic-ai/claude-code` - Claude Code CLI (pre-installed in image)
- `benchmark-memory.mjs` - Memory usage benchmark
- `test-sdk-with-credsfile.mjs` - SDK test template

## Raw Results

### Fair Comparison (Same Image - All Providers, Docker VMM)

```json
{
  "image": "docker/sandbox-templates:claude-code",
  "dockerEngine": "Docker VMM (Virtual Machine Monitor)",
  "resourceConfig": {
    "dockerDirect": "no limits (host resources)",
    "dockerSandbox": "no limits (host resources)",
    "devcontainer": "no limits (host resources)",
    "boxLite": "4GB RAM, 4 CPUs",
    "appleContainer": "4GB RAM, 4 CPUs"
  },
  "DockerDirect": { "startupMs": 252, "promptMs": 3831, "e2eMs": 4608, "memoryMb": 2, "success": true },
  "BoxLite": { "startupMs": 811, "promptMs": 3780, "e2eMs": 5627, "memoryMb": null, "success": true },
  "DockerSandbox": { "startupMs": 1458, "promptMs": 3982, "e2eMs": 5965, "memoryMb": 58, "success": true },
  "AppleContainer": { "startupMs": 1437, "promptMs": 4414, "e2eMs": 6134, "memoryMb": null, "success": true },
  "Devcontainer": { "startupMs": 1022, "promptMs": 4174, "e2eMs": 7867, "memoryMb": 2, "success": true }
}
```

### Full Provider Results (with setup)

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
  },
  "DockerSandbox": {
    "sdk": null,
    "e2eMs": 6736,
    "cli": { "success": true, "startupMs": 1387, "promptMs": 3892, "fileCreateMs": 6695, "codeExecMs": 10429 },
    "concurrent": { "success": true, "instances": 5, "totalMs": 17995, "avgStartupMs": 1520 }
  }
}
```
