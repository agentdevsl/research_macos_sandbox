# Sandbox Benchmark Results: Quantified Comparison

## Executive Summary

This report presents quantified benchmark results for three macOS sandbox providers validated for running Claude Agent SDK and Claude Code CLI.

| Provider | VM Startup | Exec Latency | Agent SDK | Claude CLI | Isolation |
|----------|------------|--------------|-----------|------------|-----------|
| **BoxLite** | **261ms** | **6.2ms** | ✅ 4.6s install | ✅ 2.9s install | Micro-VM |
| **OrbStack** | 725ms | 12.6ms (SSH) | ✅ Works | ✅ Works | Container |
| **Apple Container** | 1,150ms | 70ms | ✅ Works | ✅ Works | Full VM |

**Recommendation**: BoxLite offers the best performance with micro-VM isolation.

---

## Detailed Benchmark Results

### 1. BoxLite (Micro-VMs) — WITH NPM WORKSPACE FIX

**Provider Info:**
- Version: 0.1.6
- Isolation: Micro-VM (Apple Hypervisor.framework)
- Kernel: Linux 6.12.62 (aarch64)
- Features: hardware-vm, oci-images, volume-mounts, port-forwarding, fast-startup

**Performance Metrics (20 iterations, 3 warmup):**

| Metric | Mean | P50 | P95 | P99 | Min | Max |
|--------|------|-----|-----|-----|-----|-----|
| **Cold Startup** | 261.13ms | 263.28ms | 277.29ms | 283.41ms | 239.40ms | 283.41ms |
| **Exec Latency** | 9.12ms | 6.18ms | 33.54ms | 36.83ms | 5.45ms | 36.83ms |
| **SSH Exec Latency** | 10.89ms | 6.20ms | 28.95ms | 41.75ms | 5.24ms | 41.75ms |
| **Node Invocation** | 11.04ms | 6.06ms | 52.50ms | 58.46ms | 5.60ms | 58.46ms |
| **Claude CLI** | 8.96ms | 6.40ms | 29.17ms | 34.73ms | 5.54ms | 34.73ms |

**Concurrent Instance Creation:**
| Instances | Mean | P50 | P95 |
|-----------|------|-----|-----|
| 3 | 306.62ms | 304.00ms | 325.93ms |
| 5 | 364.19ms | 360.14ms | 389.37ms |

**Claude Agent SDK Validation:**
| Component | Status | Time |
|-----------|--------|------|
| VM Startup | ✅ | 441ms |
| Node.js v24.13.0 | ✅ | ~1s |
| Agent SDK Install | ✅ | 4,606ms |
| Agent SDK Load | ✅ | Verified |
| Claude CLI Install | ✅ | 2,903ms |
| Claude CLI Version | ✅ | 2.1.12 |

**Agent SDK Exports Verified:**
```
query, tool, createSdkMcpServer,
unstable_v2_prompt, unstable_v2_createSession, unstable_v2_resumeSession,
AbortError, EXIT_REASONS, HOOK_EVENTS
```

**Async Generator API Verified:**
```javascript
const q = query({ prompt: 'test', options: { tools: [] } });
// q.constructor.name === 'Query'
// typeof q[Symbol.asyncIterator] === 'function' ✅
```

---

### 2. OrbStack (Docker Containers)

**Provider Info:**
- Version: 29.1.3
- Isolation: Container (cgroups, namespaces)
- Platform: Docker on OrbStack Linux VM

**Performance Metrics (20 iterations):**

| Metric | Mean | P50 | P95 | P99 |
|--------|------|-----|-----|-----|
| Cold Startup | 724.63ms | 693.17ms | 973.33ms | 1,024.72ms |
| SSH Ready | 1,173.55ms | 1,090ms | 1,500ms | 1,923.44ms |
| Exec Latency (Direct) | 269.44ms | 261.72ms | 366.02ms | 464.24ms |
| SSH Exec Latency | 20.60ms | 12.62ms | 70.65ms | 103.47ms |
| Node.js Invocation | 14.51ms | 12.32ms | 24.02ms | 29.37ms |
| Claude CLI Version | 13.59ms | 7.11ms | 36.23ms | 44.49ms |

**Concurrent Instance Creation:**
| Instances | Mean | P50 | P95 |
|-----------|------|-----|-----|
| 5 | 6,588ms | 6,420ms | 12,980ms |
| 10 | 13,073ms | 13,060ms | 15,510ms |

**Claude Agent SDK Validation:**
- Package Install: ~2s
- SDK Version: 0.2.12
- CLI Version: 2.1.12
- Async Generator API: ✅ Working

---

### 3. Apple Container (macOS 26 Native)

**Provider Info:**
- Version: 0.7.1
- Isolation: Full VM per container
- Features: native ssh support, virtiofs mounts
- Networking: Requires `--network default --dns 8.8.8.8`

**Performance Metrics (5 iterations):**

| Metric | Mean | P50 | P95 |
|--------|------|-----|-----|
| Cold Startup | 1,150ms | 1,110ms | 1,380ms |
| Exec Latency (container exec) | 70.35ms | 71.79ms | 75.53ms |

**Claude Agent SDK Validation:**
- Package Install: ~2s
- SDK Version: 0.2.12
- CLI Version: 2.1.12
- Async Generator API: ✅ Working
- Note: Requires `--network default --dns 8.8.8.8` for API calls

---

## Claude Agent SDK API

All three providers successfully run the Claude Agent SDK using the async generator API:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const agentQuery = query({
  prompt: 'Your task here',
  options: {
    cwd: process.cwd(),
    tools: [], // or specific tools
  },
});

// Consume the async generator
for await (const message of agentQuery) {
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'text') {
        console.log(block.text);
      }
    }
  } else if (message.type === 'result') {
    console.log('Query completed:', message.subtype);
  }
}
```

**Package Versions Tested:**
- `@anthropic-ai/claude-agent-sdk`: 0.2.12
- `@anthropic-ai/claude-code`: 2.1.12
- Node.js: v22.x (OrbStack/Apple) / v24.x (BoxLite Alpine)

---

## Claude Code CLI

All three providers successfully run Claude Code CLI:

```bash
# Version check
claude --version
# Output: 2.1.12 (Claude Code)

# Simple prompt execution
claude -p "Your prompt" --max-turns 1 --output-format text
```

---

## Comparative Analysis

### Startup Performance

```
BoxLite:         ██████░░░░░░░░░░░░░░░░░░░░  261ms  (fastest)
OrbStack:        ██████████████████░░░░░░░░  725ms
Apple Container: ██████████████████████████ 1150ms  (slowest)
```

### Exec Latency (P50)

```
BoxLite:         █░░░░░░░░░░░░░░░░░░░░░░░░░  6.2ms  (fastest)
OrbStack SSH:    ██░░░░░░░░░░░░░░░░░░░░░░░░  12.6ms
Apple Container: ████████████████░░░░░░░░░░  70ms   (slowest)
```

### Concurrent Scaling (5 instances)

```
BoxLite:         ████░░░░░░░░░░░░░░░░░░░░░░  364ms  (fastest)
OrbStack:        ██████████████████████████  6588ms (slowest)
```

### Isolation Level

| Provider | Type | Security | Overhead |
|----------|------|----------|----------|
| BoxLite | Micro-VM | High | Low |
| Apple Container | Full VM | Highest | Medium |
| OrbStack | Container | Medium | Medium |

---

## BoxLite NPM Workspace Fix

BoxLite's Alpine rootfs is limited (~220MB). The provider now automatically configures npm to use the mounted `/workspace` volume:

```typescript
// Automatic configuration on sandbox creation
await sandbox.initializeNpm();

// Helper methods for package installation
await sandbox.npmInstall('@anthropic-ai/claude-agent-sdk');      // local to /workspace
await sandbox.npmInstall('@anthropic-ai/claude-code', true);     // global to /workspace/.npm-global

// Run commands with npm PATH configured
await sandbox.execWithNpmPath('claude --version');
await sandbox.execWithNpmPath('cd /workspace && node app.js');
```

**Directory Structure:**
```
/workspace/                      # Mounted host volume
├── node_modules/               # Local packages
├── .npm-global/                # Global packages
│   └── bin/                    # Global binaries (claude, etc.)
└── package.json                # Created by npm init
```

---

## Resource Usage

### Memory Per Instance

| Provider | Base Memory | With Node.js | With Agent SDK |
|----------|-------------|--------------|----------------|
| BoxLite | ~128MB | ~200MB | ~350MB |
| OrbStack | ~64MB | ~150MB | ~280MB |
| Apple Container | ~256MB | ~320MB | ~450MB |

### Disk Space

| Component | Size |
|-----------|------|
| Alpine base image | ~7MB |
| Node.js 24 | ~85MB |
| @anthropic-ai/claude-agent-sdk | ~72MB |
| @anthropic-ai/claude-code | ~15MB |

---

## Recommendations

### For Development/Testing
**OrbStack** - Good balance of ease-of-use and performance with familiar Docker tooling.

### For Production Workloads
**BoxLite** - Best performance (261ms startup, 6.2ms exec) with micro-VM isolation. Use the npm workspace fix for package management.

### For Maximum Security
**Apple Container** - Full VM isolation with Apple-supported implementation (macOS 26+ only).

---

## Test Environment

- **Hardware**: Apple Silicon Mac (arm64)
- **OS**: macOS 26 (Tahoe)
- **Node.js**: v22+ (containers), v24+ (Alpine)
- **Date**: January 2026

---

## Files Generated

- `results/benchmark-*.json` - Raw benchmark data
- `packages/sandbox-*/` - Provider implementations
- `fixtures/agent-test/` - Agent SDK test scripts
- `apps/benchmark/` - Benchmark CLI tool
