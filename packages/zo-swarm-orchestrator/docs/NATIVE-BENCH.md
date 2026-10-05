# VPS native swarm benchmark

This bench tests the installed production modules in `/opt/zouroboros/repo` against synthetic files. It is an on-demand diagnostic, not a model promotion job. A failed case exits nonzero; the report distinguishes task correctness, selected-model evidence, and native delegation evidence.

## Run

```bash
sudo /opt/zouroboros/repo/deploy/vps/swarm-bench/run.sh
# Narrow diagnosis without spending on the entire matrix:
sudo /opt/zouroboros/repo/deploy/vps/swarm-bench/run.sh --only offline
sudo /opt/zouroboros/repo/deploy/vps/swarm-bench/run.sh --only models
sudo /opt/zouroboros/repo/deploy/vps/swarm-bench/run.sh --case executor-gemini --only executor
sudo /opt/zouroboros/repo/deploy/vps/swarm-bench/run.sh --only subagents --harness claude-code
sudo /opt/zouroboros/repo/deploy/vps/swarm-bench/run.sh --only executor --harness codex --model gpt-6-astra
```

The launcher prints the transient systemd unit and report path. Use `systemctl status UNIT`, `journalctl -u UNIT`, and `cat OUTPUT/report.json`. Stop with `systemctl stop UNIT`; systemd kills the entire process group. It does not install or enable a recurring timer. Credentials are loaded privately from the VPS's native environment files as the `zouroboros` service account. Existing paused services, model qualification ledgers, operator choices, and catalog contents are unchanged.

From an already provisioned native service environment, `cd packages/swarm && bun run bench:native --workspace /opt/zouroboros/repo` is equivalent. Do not run provider cases in a credential-less login shell and interpret resulting authentication failures as provider outages.

## Test case and acceptance

Each case receives a fresh Git directory, empty MCP configuration, synthetic JSON inputs and isolated SQLite state. The ledger task must create two TypeScript modules with a real cross-file import, calculate charges minus refunds, reject invalid inputs, and emit a correct summary. Bun imports the generated modules and executes eight behavioral assertions. Correct prose or file existence alone is insufficient. A clean worker exit, completed harness response, passing assertions and matching harness-reported model are required. Model identifiers are compared after trimming surrounding whitespace.

| Layer | Live test or regression coverage |
|---|---|
| Model routing | All registered executors at light/mid/heavy; concrete identifier resolution; retired Cursor rejection; automatic choice must belong to qualified shared-catalog routes |
| Installed transports | Seven executor entries using their actual registry transport and model-selection contract |
| Shell compatibility | Six declared bridges explicitly tested, separately reported; OpenCode has no bridge and is marked unsupported |
| Campaign CLI | Actual `scripts/orchestrate-v5.ts` entry point runs the ledger task through the Claude bridge |
| DAG | Two independent roots on Gemini and Pi; an automatic join waits for both and imports their outputs to compute 42 |
| Recovery | Inject one primary transport failure before any provider call; production fallback must execute the real task through Pi |
| Native subagents | Claude and Hermes must invoke two native delegation tools, children create disjoint files, parent joins to compute 42 |
| Regression | Routing, selector, ACP, DAG, hierarchical accounting/validation, budget governor, fallback and bridge authority tests |
| Benchmark integrity | Reject stale output directories; reject a crash/timeout after an early success receipt; reject parent claims or duplicate native tool events as delegation |

The worker imports production `SwarmOrchestrator`, `createTransport`, model router, circuit breaker and delegation parser. It does not replace the execution engine with a benchmark-only implementation. The recovery case is the only deliberate transport stub, limited to one named primary task; its fallback remains a real provider call. Registry adapter arguments and bridge paths are made absolute in a per-case copy so changing the working directory does not change the code under test. Production seed, postflight and trace checks remain enabled. The separate harness-smoke hook is disabled because the synthetic project is not the production repository.

## Evidence and limits

`report.json` contains the runtime path, source/registry hashes, limits, durations, result metadata and pass/fail categories. Individual directories contain `receipt.json`, tool-event records, generated files and private diagnostic logs. Do not publish raw provider error bodies or event logs: upstream tools may include configuration, model instructions or sensitive context. Publish compact sanitized summaries instead.

The full plan reserves 36 task slots within a default 36-slot / $10 *scheduling reservation*. The $0.25/slot allowance is an estimate, **not an enforceable provider billing cap**. One harness task or subagent can make multiple model requests. Provider-side limits remain authoritative. Orchestrated cases also use the existing $3 estimated budget governor; individual tool loops have wall-clock deadlines. Maximum parallelism is two, inside the DAG. Systemd adds a one-hour overall timeout, 4 GiB memory limit and cgroup cleanup. Synthetic working directories are not a security sandbox; the harnesses run under their normal native account permissions.

Harness `modelUsed` metadata proves the harness's reported selection, not an independently attested provider billing model. Missing metadata fails the model-evidence criterion even when the code is correct. Environment-only adapters may still ignore their model environment variable; provider rejection or contradictory session evidence must override a claimed pass. Static tier resolution is not live qualification of every light/heavy provider model.

Native delegation requires structured Agent/Task/delegate_task/subagent invocations for at least two children plus working child outputs. Hermes can batch both requests in one native tool invocation. Report parent-supplied child reports separately from production child records. The test does not assume that two model names imply different families. It does not promote models, expose repository content to new families, reconsider excluded healer routes, modify healer health deadlines, resume consensus/Factory holds, or claim to test private production workloads. Memory learning is disabled for synthetic jobs; native memory was consulted separately to recover earlier bench lessons.

## Existing benchmarks

`scripts/swarm-bench.ts` is the older direct-bridge benchmark. `src/standalone/swarm-bench.ts` is the Trifecta benchmark: it defaults to forced bridges unless `--acp` is requested, and does not propagate the central resolved-model environment in the same way as production. `src/standalone/benchmark.ts` simulates memory strategies and is not a live executor bench. These remain available for historical comparisons. Native memory records warn that an earlier bench continued testing obsolete code after modularization and awarded partial scores to broken imports. Those failures motivate the production imports and executable acceptance oracle here.

## Rollback

The benchmark is additive and runs only when invoked. Stop its transient systemd unit to abort a run. Removing `bench:native`, its four script files, this document and `deploy/vps/swarm-bench/run.sh` restores the prior command surface. No model-catalog rollback or production service restart is required. Keep completed result directories as evidence; each new run requires a new or empty directory.

The orchestrated fixture uses the production default deadline configuration. The implicit 30-second recursive guard applies to child chains; ordinary top-level dependencies use their task deadlines. An explicitly supplied chain timeout still applies at any depth. This repairs the baseline failure in which a normal join was rejected after slower root tasks. The launcher uses a native flock to prevent overlapping benchmark runs.

Coding-task deadlines are separate from the healer's 10-second completed-response health target. These runs do not modify that health target or promote candidates.
