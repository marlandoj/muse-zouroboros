# Swarm Orchestrator Quick Reference

## When to Use What

```
Campaign Size      Command                                      Why
─────────────────  ───────────────────────────────────────────  ────────────────────────
1-5 tasks          bun scripts/orchestrate-v5.ts tasks.json     Fast, no timeout risk

6-10 tasks         bun scripts/orchestrate-v5.ts tasks.json     May timeout, get notified
                   --notify email                               when done

10+ tasks          bun swarm-hybrid-runner.ts tasks.json        Will timeout, need
                   --notify sms                                 graceful handoff

Background         nohup bun scripts/orchestrate-v5.ts          Run fully detached
(any size)         --notify sms > /tmp/swarm.log 2>&1 &        from the start
```

## Essential Commands

```bash
# Check swarm status
bun scripts/orchestrate-v5.ts status <swarm-id>

# Check delegation/routing history
bun scripts/orchestrate-v5.ts history 10

# System health check
bun scripts/orchestrate-v5.ts doctor

# View recent results
ls -lht ~/.swarm/results/ | head -10

# View logs for a specific swarm
cat ~/.swarm/logs/<swarm-id>.ndjson | tail -50

# Check concurrency setting
grep localConcurrency config.json
```

## Status Command Output Guide

```
🏃  Running         Swarm is currently executing
✅  Complete        Swarm finished successfully  
❌  Preflight fail  Swarm failed startup checks
⏸️   Stopped         Swarm not running (may have crashed)
```

For hierarchical runs, `status` also prints:

```text
Delegated: <parent-count> parent / <child-count> child
Artifacts: <artifact-count>
Reroutes: <rerouted-task-count>
Executors: <effective-executor-list>
```

## History Command Output Guide

```text
📚 Swarm Executor History
   DB: ~/.swarm/executor-history.db

   hermes [validation]
     Base: 10/12 (83%) avg 800ms
     Delegation: 6 attempts (83% success)
     Children: 12/14 (86%) avg count 2.3 avg child 160ms
```

Use this to inspect whether delegation is helping a given executor/category pair before tuning routing strategy or task design.

## Notification Behavior

| Flag | When Triggered | What You Get |
|------|---------------|--------------|
| `--notify sms` | Swarm completes (success or fail) | SMS with summary + results path |
| `--notify email` | Swarm completes (success or fail) | Email with summary + results path |
| *(no flag)* | Always | Results file only (no notification) |

## Hybrid Runner Workflow

```
Time     What Happens
─────────────────────────────────────────────────────────────
0:00     ✅ Swarm starts in background
         📊 Progress updates every 10 seconds

0:30     [0m 30s] Progress: 2/20 tasks (10%)
1:00     [1m 0s] Progress: 4/20 tasks (20%)
...      ...

13:00    ⏰ "Approaching timeout — switching to background mode"
         📞 "You'll be notified when complete"
         🔍 "Check status: bun scripts/orchestrate-v5.ts status <swarm-id>"

[later]  📱 SMS: "Swarm complete! 18/20 tasks succeeded (2 failed)"
              "Duration: 24m 15s"
              "Results: ~/.swarm/results/<swarm-id>.json"
```

## Common Issues

### "No progress file found"
**Cause:** Swarm never started or swarm-id is wrong  
**Fix:** Check `ls ~/.swarm/logs/*.json` for actual swarm IDs

### Chat timeout, lost output
**Cause:** Using direct orchestrator for >15 min campaign  
**Fix:** Use hybrid runner: `bun swarm-hybrid-runner.ts tasks.json --notify sms`

### "Campaign already running"
**Cause:** Lock file exists from previous run  
**Fix:** Check `ls /dev/shm/*.lock` and remove stale locks if needed

### All tasks failing with same error
**Cause:** Likely a configuration or executor issue  
**Fix:** Run `bun scripts/orchestrate-v5.ts doctor` to diagnose

## Configuration Cheat Sheet

**Current Settings (config.json):**
```json
{
  "localConcurrency": 8,        ← Max parallel tasks
  "timeoutSeconds": 600,        ← 10 min per task
  "maxRetries": 3,              ← Retry failures 3x
  "memory": {
    "maxTokens": 16000          ← Context window limit
  }
}
```

**Override via CLI:**
```bash
bun scripts/orchestrate-v5.ts tasks.json \
  --concurrency 4 \              # Reduce parallelism
  --timeout 300 \                # 5 min timeout
  --strategy fast                # Optimize for speed
```

## File Locations

```
~/.swarm/
├── results/              ← Final outputs (JSON)
│   └── <swarm-id>.json
├── logs/                 ← Runtime logs & progress
│   ├── <swarm-id>.ndjson
│   └── <swarm-id>_progress.json
└── swarm-memory.db       ← Persistent memory database

/dev/shm/
└── <swarm-id>.lock       ← Active swarm locks (tmpfs)

Skills/zo-swarm-orchestrator/
├── config.json           ← Configuration
└── executor-history.json ← Routing performance data
```

## Performance Benchmarks

**With current config (concurrency=8, tokens=16k):**

```
Campaign Size    Sequential Time    Parallel Time    Speedup
──────────────────────────────────────────────────────────────
5 tasks          10 min             ~3 min           3.3x
10 tasks         20 min             ~5 min           4.0x
20 tasks         40 min             ~10 min          4.0x
50 tasks         100 min            ~20 min          5.0x
```

*Assumes avg 2 min per task. Actual times vary by complexity.*

## Tips & Tricks

1. **Always specify swarm-id for tracking:**
   ```bash
   bun scripts/orchestrate-v5.ts tasks.json --swarm-id commerce-a-sourcing-2026-03-12
   ```

2. **Monitor while running:**
   ```bash
   watch -n 5 'bun scripts/orchestrate-v5.ts status <swarm-id>'
   ```

3. **Compare routing strategies:**
   ```bash
   # Fast: prioritize speed
   bun scripts/orchestrate-v5.ts tasks.json --strategy fast
   
   # Reliable: prioritize success rate
   bun scripts/orchestrate-v5.ts tasks.json --strategy reliable
   ```

4. **Find swarm by approximate time:**
   ```bash
   ls -lt ~/.swarm/results/ | head -20
   ```

5. **Check executor health:**
   ```bash
   bun scripts/orchestrate-v5.ts doctor
   cat ~/.swarm/executor-history.json | jq
   ```
