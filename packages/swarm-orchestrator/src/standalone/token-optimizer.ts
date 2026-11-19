#!/usr/bin/env bun
/**
 * Token Optimizer Module
 * 
 * Integrates token compression strategies inspired by:
 * - prompt-refiner: SchemaCompressor, ResponseCompressor
 * - Agent Memory Playground: Sliding window, hierarchical memory
 * 
 * Features:
 * - HTML stripping and whitespace normalization
 * - Deduplication of content
 * - Sliding window memory management
 * - Hierarchical working + long-term memory
 */

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export type TextCleaner = (text: string) => string;

export interface MemoryStrategy {
  workingMemorySize: number;      // Number of recent items in working memory
  longTermMemorySize: number;     // Number of items to retrieve from LTM
  enableDeduplication: boolean;
  enableHTMLStripping: boolean;
  maxTokens: number;              // Target max tokens for context
}

export interface MemoryItem {
  id: string;
  content: string;
  timestamp: number;
  metadata: {
    sourceAgent: string;
    category?: string;
    priority?: string;
  };
}

// ============================================================================
// TEXT CLEANERS (inspired by prompt-refiner)
// ============================================================================

export function stripHTML(text: string): string {
  // Remove HTML tags but preserve text content
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function normalizeWhitespace(text: string): string {
  // Normalize line breaks and remove excessive whitespace
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function fixUnicode(text: string): string {
  // Fix common unicode issues
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u00A0]/g, ' ');
}

export function deduplicate(text: string): string {
  const lines = text.split('\n');
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const normalized = line.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(line);
  }

  return result.join('\n');
}

export function composeCleaners(...cleaners: TextCleaner[]): TextCleaner {
  return (text: string) => {
    let result = text;
    for (const cleaner of cleaners) {
      result = cleaner(result);
    }
    return result;
  };
}

// ============================================================================
// HIERARCHICAL MEMORY MANAGEMENT (inspired by Agent-Memory-Playground)
// ============================================================================

export class HierarchicalMemory {
  private workingMemory: MemoryItem[] = [];
  private longTermMemory: Map<string, MemoryItem> = new Map();
  private strategy: MemoryStrategy;
  private cleaners: TextCleaner;

  constructor(strategy: Partial<MemoryStrategy> = {}) {
    this.strategy = {
      workingMemorySize: 2,
      longTermMemorySize: 3,
      enableDeduplication: true,
      enableHTMLStripping: true,
      maxTokens: 8000,
      ...strategy,
    };

    // Build cleaner pipeline
    const cleaners: TextCleaner[] = [];
    if (this.strategy.enableHTMLStripping) cleaners.push(stripHTML);
    cleaners.push(normalizeWhitespace, fixUnicode);
    if (this.strategy.enableDeduplication) cleaners.push(deduplicate);
    this.cleaners = composeCleaners(...cleaners);
  }

  /**
   * Add content to memory
   */
  add(item: Omit<MemoryItem, 'id' | 'timestamp'>): MemoryItem {
    const cleaned = this.cleaners(item.content);
    const memoryItem: MemoryItem = {
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      content: cleaned,
      timestamp: Date.now(),
      metadata: item.metadata,
    };

    // Add to working memory
    this.workingMemory.unshift(memoryItem);

    // Trim working memory if needed
    if (this.workingMemory.length > this.strategy.workingMemorySize) {
      // Move excess to long-term memory
      const excess = this.workingMemory.splice(this.strategy.workingMemorySize);
      for (const item of excess) {
        this.longTermMemory.set(item.id, item);
      }
    }

    // Trim long-term memory if needed
    if (this.longTermMemory.size > 100) {
      const sorted = [...this.longTermMemory.entries()]
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = sorted.slice(0, this.longTermMemory.size - 100);
      for (const [id] of toRemove) {
        this.longTermMemory.delete(id);
      }
    }

    return memoryItem;
  }

  /**
   * Get relevant context (working + long-term memory)
   */
  getContext(): MemoryItem[] {
    // Working memory (most recent)
    const workingItems = [...this.workingMemory];

    // Long-term memory (retrieve by recency)
    const ltmItems = [...this.longTermMemory.values()]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, this.strategy.longTermMemorySize);

    return [...workingItems, ...ltmItems];
  }

  /**
   * Get context as formatted string for agent
   */
  getContextString(): string {
    const items = this.getContext();
    if (items.length === 0) return '';

    const sections = items.map(item => {
      const meta = item.metadata;
      const header = [
        `Source: ${meta.sourceAgent}`,
        meta.category ? `Category: ${meta.category}` : '',
        meta.priority ? `Priority: ${meta.priority}` : '',
        `Time: ${new Date(item.timestamp).toLocaleString()}`,
      ].filter(Boolean).join(' | ');

      return `---\n${header}\n${item.content}\n---`;
    });

    return `## Swarm Memory Context (Hierarchical)\n\nRecent working memory + relevant long-term memory:\n\n${sections.join('\n\n')}\n`;
  }

  /**
   * Estimate token count (rough approximation: ~4 chars per token)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Get memory statistics
   */
  getStats() {
    const totalTokens = this.estimateTokens(
      this.getContext().map(i => i.content).join('\n')
    );

    return {
      workingMemorySize: this.workingMemory.length,
      longTermMemorySize: this.longTermMemory.size,
      totalContextSize: this.getContext().length,
      estimatedTokens: totalTokens,
      tokenBudget: this.strategy.maxTokens,
      budgetUtilization: totalTokens / this.strategy.maxTokens,
    };
  }

  /**
   * Clear all memory
   */
  clear(): void {
    this.workingMemory = [];
    this.longTermMemory.clear();
  }
}

// ============================================================================
// SLIDING WINDOW MEMORY (simpler alternative)
// ============================================================================

export class SlidingWindowMemory {
  private window: MemoryItem[] = [];
  private windowSize: number;
  private cleaners: TextCleaner;

  constructor(windowSize: number = 4) {
    this.windowSize = windowSize;
    this.cleaners = composeCleaners(stripHTML, normalizeWhitespace, fixUnicode, deduplicate);
  }

  add(item: Omit<MemoryItem, 'id' | 'timestamp'>): MemoryItem {
    const cleaned = this.cleaners(item.content);
    const memoryItem: MemoryItem = {
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      content: cleaned,
      timestamp: Date.now(),
      metadata: item.metadata,
    };

    this.window.unshift(memoryItem);

    // Trim to window size
    if (this.window.length > this.windowSize) {
      this.window = this.window.slice(0, this.windowSize);
    }

    return memoryItem;
  }

  getContext(): MemoryItem[] {
    return [...this.window];
  }

  getContextString(): string {
    const items = this.getContext();
    if (items.length === 0) return '';

    const sections = items.map(item => {
      const header = `Source: ${item.metadata.sourceAgent} | Time: ${new Date(item.timestamp).toLocaleString()}`;
      return `---\n${header}\n${item.content}\n---`;
    });

    return `## Recent Swarm Context (Last ${items.length} items)\n\n${sections.join('\n\n')}\n`;
  }

  clear(): void {
    this.window = [];
  }

  getStats() {
    const totalTokens = this.getContext().map(i => i.content).join('\n').length / 4;
    return {
      workingMemorySize: this.window.length,
      longTermMemorySize: 0,
      totalContextSize: this.window.length,
      estimatedTokens: Math.ceil(totalTokens),
      tokenBudget: this.windowSize * 1000,
      budgetUtilization: totalTokens / (this.windowSize * 1000),
    };
  }
}

// ============================================================================
// SEQUENTIAL MEMORY (Full History - for comparison)
// ============================================================================

export class SequentialMemory {
  private history: MemoryItem[] = [];
  private cleaners: TextCleaner;

  constructor() {
    this.cleaners = composeCleaners(stripHTML, normalizeWhitespace, fixUnicode, deduplicate);
  }

  add(item: Omit<MemoryItem, 'id' | 'timestamp'>): MemoryItem {
    const cleaned = this.cleaners(item.content);
    const memoryItem: MemoryItem = {
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      content: cleaned,
      timestamp: Date.now(),
      metadata: item.metadata,
    };

    this.history.push(memoryItem);
    return memoryItem;
  }

  getContext(): MemoryItem[] {
    return [...this.history];
  }

  getContextString(): string {
    const items = this.getContext();
    if (items.length === 0) return '';

    const sections = items.map(item => {
      const header = `Source: ${item.metadata.sourceAgent} | Time: ${new Date(item.timestamp).toLocaleString()}`;
      return `---\n${header}\n${item.content}\n---`;
    });

    return `## Full Conversation History (${items.length} items)\n\n${sections.join('\n\n')}\n`;
  }

  clear(): void {
    this.history = [];
  }

  getStats() {
    const totalTokens = this.estimateTokens(this.history.map(i => i.content).join('\n'));
    return {
      workingMemorySize: this.history.length,
      longTermMemorySize: 0,
      totalContextSize: this.history.length,
      estimatedTokens: totalTokens,
      tokenBudget: Infinity,
      budgetUtilization: 0,
    };
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export function summarizeText(text: string, maxLength: number = 200): string {
  if (text.length <= maxLength) return text;
  
  const truncated = text.substring(0, maxLength);
  const lastSentenceEnd = truncated.lastIndexOf('. ');
  const lastParagraphEnd = truncated.lastIndexOf('\n\n');
  
  if (lastSentenceEnd > maxLength * 0.7) {
    return truncated.substring(0, lastSentenceEnd + 1) + ' [...]';
  }
  if (lastParagraphEnd > maxLength * 0.7) {
    return truncated.substring(0, lastParagraphEnd) + '\n[...]';
  }
  
  return truncated + ' [...]';
}

export function extractKeyPoints(text: string, maxPoints: number = 5): string[] {
  const sentences = text
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => s.length > 20);
  
  return sentences.slice(0, maxPoints);
}
