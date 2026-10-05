export function retryableExecutionContractError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^seed (?:task|has no tasks block|not found)/i.test(message)
    || /^coding cascade enforce requires FACTORY_CODING_CASCADE_VALIDATION_COMMANDS for direct campaigns$/i.test(message)
    || /^FACTORY_CODING_CASCADE_VALIDATION_COMMANDS is invalid JSON:/i.test(message)
    || /validation commands (?:are missing|must contain|entry)/i.test(message)
    || /validation command\[\d+\] (?:must be an object|requires label, command, and string\[\] args|timeout_ms must be a positive integer)/i.test(message)
    || /requires label, command, and string\[\] args/i.test(message);
}
