# Sandbox Benchmark Results: Quantified Comparison

## Executive Summary

This report presents quantified benchmark results for three macOS sandbox providers validated for running Claude Agent SDK and Claude Code CLI.

| Provider | VM Startup | SSH Ready | Exec Latency | Agent SDK | Claude CLI | Isolation |
|----------|------------|-----------|--------------|-----------|------------|-----------|
| **BoxLite** | **257ms** | 1.6ms | **1.5ms** | ✅ Works | ✅ Works | Micro-VM |
| **OrbStack** | 725ms | 1,174ms | 270ms | ✅ Works | ✅ Works | Container |
| **Apple Container** | 1,150ms | N/A | 70ms | ✅ Works | ✅ Works | Full VM |

**Recommendation**: BoxLite offers the best performance with micro-VM isolation.

---

## Detailed Benchmark Results

### 1. OrbStack (Docker Containers)

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
- Package Install: 2s
- SDK Version: 0.2.12
- CLI Version: 2.1.12
- Async Generator API: ✅ Working

---

### 2. BoxLite (Micro-VMs)

**Provider Info:**
- Version: 0.1.6
- Isolation: Micro-VM (Apple Hypervisor.framework)
- Kernel: Linux 6.12.62 (aarch64)
- Features: hardware-vm, oci-images, volume-mounts, port-forwarding, fast-startup

**Performance Metrics (20 iterations):**

| Metric | Mean | P50 | P95 | P99 |
|--------|------|-----|-----|-----|
| Cold Startup | **257.14ms** | 246.17ms | 350.59ms | 422ms |
| SSH Ready | 1.64ms | 1.49ms | 2.13ms | 3.12ms |
| Exec Latency | **1.49ms** | 1.41ms | 2.01ms | 2.89ms |
| SSH Exec Latency | 1.60ms | 1.52ms | 2.07ms | 2.95ms |
| Node.js Invocation | 45ms | 42ms | 58ms | 72ms |
| Claude CLI Version | 38ms | 35ms | 52ms | 65ms |

**Concurrent Instance Creation:**
| Instances | Mean | P50 | P95 |
|-----------|------|-----|-----|
| 5 | 1,450ms | 1,380ms | 1,820ms |
| 10 | 2,890ms | 2,750ms | 3,420ms |

**Claude Agent SDK Validation:**
- Package Install: 4,389ms
- SDK Version: 0.2.12
- CLI Version: 2.1.12
- Async Generator API: ✅ Working
- VM Memory: 2GB available

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
| SSH Ready | N/A* | N/A* | N/A* |

*Note: SSH plugin not available in version 0.7.1. Use `container exec` instead.

**Claude Agent SDK Validation:**
- Package Install: ~2s
- SDK Version: 0.2.12
- CLI Version: 2.1.12
- Async Generator API: ✅ Working
- Network: Requires explicit DNS configuration

---

## Claude Agent SDK API Validation

All three providers successfully run the Claude Agent SDK using the correct async generator API:

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

## Claude Code CLI Validation

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
BoxLite:         ████████░░░░░░░░░░░░░░░░░░  257ms  (fastest)
OrbStack:        ██████████████████░░░░░░░░  725ms
Apple Container: ██████████████████████████ 1150ms  (slowest)
```

### Exec Latency

```
BoxLite:         █░░░░░░░░░░░░░░░░░░░░░░░░░  1.5ms  (fastest)
Apple Container: ████████████████░░░░░░░░░░   70ms
OrbStack:        ██████████████████████████  270ms  (slowest)
```

### Isolation Level

| Provider | Type | Security | Overhead |
|----------|------|----------|----------|
| BoxLite | Micro-VM | High | Low |
| Apple Container | Full VM | Highest | Medium |
| OrbStack | Container | Medium | Medium |

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
| Node.js 22 | ~85MB |
| @anthropic-ai/claude-agent-sdk | ~72MB |
| @anthropic-ai/claude-code | ~15MB |

---

## Recommendations

### For Development/Testing
**OrbStack** - Good balance of ease-of-use and performance with familiar Docker tooling.

### For Production Workloads
**BoxLite** - Best performance (257ms startup, 1.5ms exec) with micro-VM isolation.

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
