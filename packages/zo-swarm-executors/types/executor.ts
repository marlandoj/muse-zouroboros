/**
 * Type definitions for the zo-swarm-executors registry.
 *
 * These interfaces define the schema for executor-registry.json
 * and the resolved executor objects used at runtime.
 */

/** Environment variable documentation (name → description). */
export type EnvVarDocs = Record<string, string>;

/** Configuration block for an executor. */
export interface ExecutorConfig {
  /** Default timeout in seconds for bridge invocation. */
  defaultTimeout: number;
  /** Default model identifier (null = executor's own default). */
  model: string | null;
  /** Documented environment variables the bridge respects. */
  envVars: EnvVarDocs;
}

/** Health check definition for an executor. */
export interface HealthCheck {
  /** Shell command to run (exit 0 = healthy). */
  command: string;
  /** Optional regex pattern expected in stdout. */
  expectedPattern: string;
  /** Human-readable description of what the check verifies. */
  description: string;
}

export interface ACPMcpConfig {
  configPath?: string;
  includeShared?: boolean;
  includeZo?: boolean;
  includeMemoryBriefing?: boolean;
}

export interface ExecutorCapabilities {
  fileRead: boolean;
  fileWrite: boolean;
  shellExec: boolean;
  webResearch: boolean;
  imageGen: boolean;
  mcp: boolean;
  streaming: boolean;
}

/** A single executor entry in the registry. */
export interface ExecutorEntry {
  /** Unique identifier (e.g. "claude-code", "hermes"). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Executor type — "local" for bridge-based executors. */
  executor: "local";
  /** Path to the bridge script, relative to WORKSPACE root. */
  bridge?: string;
  /** Short description of the executor's capabilities. */
  description: string;
  /** Tags describing areas of expertise. */
  expertise: string[];
  /** Human-readable descriptions of ideal use cases. */
  best_for: string[];
  /** Runtime configuration. */
  config: ExecutorConfig;
  /** Health check definition. */
  healthCheck: HealthCheck;
  /** Runtime transport implementation. */
  transport?: "bridge" | "acp" | "mimir";
  /** ACP adapter configuration when transport is acp. */
  acp?: {
    adapterBin?: string;
    adapterArgs?: string[];
    extraEnv?: Record<string, string>;
    allowedTools?: string[];
    mcpConfig?: ACPMcpConfig;
    modelSelection?: {
      method: "env" | "session-config" | "extension";
      envVar?: string;
      configId?: string;
      category?: string;
      extensionMethod?: string;
      providerSeparator?: "/" | ":";
    };
    endpointClass?: string;
    providerTemplates?: Record<string, {
      endpointClass: string;
      credentialEnv: string;
      launchConfig?: {
        envVar: string;
        value: Record<string, unknown>;
      };
    }>;
  };
  /** Truthful runtime capabilities used by selector policy. */
  capabilities?: ExecutorCapabilities;
  /** Shared alias to executor-native model routing metadata. */
  modelRouter?: {
    defaultModel?: string;
    fallbackModel?: string;
    tierMap?: Record<string, string>;
    acceptedPrefixes?: string[];
    rejectPrefixes?: string[];
    stripPrefixes?: string[];
    passthrough?: boolean;
  };
}

/** Top-level executor registry file schema. */
export interface ExecutorRegistry {
  /** Schema version identifier. */
  $schema: string;
  /** Human-readable description. */
  description: string;
  /** List of registered executors. */
  executors: ExecutorEntry[];
}

export type ErrorCategory =
  | "timeout" | "mutation_failed" | "syntax_error" | "runtime_error"
  | "permission_denied" | "rate_limited" | "context_overflow" | "unknown";

export interface ExecutorResult {
  status: "success" | "failure" | "timeout" | "crash";
  output: string;
  metrics?: {
    durationMs?: number;
    promptTokens?: number;
    outputTokens?: number;
    model?: string;
    retries?: number;
  };
  artifacts?: {
    filesCreated?: string[];
    filesModified?: string[];
    filesDeleted?: string[];
  };
  error?: {
    category: ErrorCategory;
    message: string;
    stackTrace?: string;
    retryable: boolean;
  };
  executorId: string;
  taskId: string;
  timestamp: string;
}

/** An executor entry with resolved absolute paths (runtime). */
export interface ResolvedExecutor {
  /** Unique identifier. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Absolute path to the bridge script. */
  bridge?: string;
  /** Runtime configuration. */
  config: ExecutorConfig;
  /** Health check definition. */
  healthCheck: HealthCheck;
}
