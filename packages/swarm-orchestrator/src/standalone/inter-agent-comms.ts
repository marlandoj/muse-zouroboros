#!/usr/bin/env bun
/**
 * Inter-Agent Communication Hub
 * Enables real-time message passing between swarm agents
 */

import { writeFile, readFile, mkdir, access } from "fs/promises";
import { existsSync, watch } from "fs";
import { join } from "path";
import { EventEmitter } from "events";

// Types
interface Message {
  id: string;
  from: string;
  to: string | "broadcast";
  type: MessageType;
  content: string;
  timestamp: number;
  threadId?: string;
  replyTo?: string;
  metadata?: Record<string, any>;
}

type MessageType = 
  | "finding"      // Share intermediate finding
  | "question"     // Ask for clarification/info
  | "response"     // Reply to a question
  | "conflict"     // Flag disagreement with another agent
  | "consensus"    // Signal agreement/support
  | "request-review" // Ask another agent to review work
  | "status"       // Progress update
  | "final";       // Final output ready

interface ConversationThread {
  id: string;
  topic: string;
  participants: string[];
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

interface AgentPresence {
  persona: string;
  status: "idle" | "working" | "blocked" | "completed";
  currentTask?: string;
  lastActivity: number;
}

interface CommHubConfig {
  swarmId: string;
  messageDir: string;
  enablePersistence: boolean;
  timeoutSeconds: number;
  requireAck: boolean;
}

// Message Bus Implementation
class InterAgentBus extends EventEmitter {
  private config: CommHubConfig;
  private threads: Map<string, ConversationThread> = new Map();
  private presence: Map<string, AgentPresence> = new Map();
  private messageQueue: Message[] = [];
  private isRunning = false;

  constructor(config: Partial<CommHubConfig> = {}) {
    super();
    this.config = {
      swarmId: config.swarmId || `swarm-${Date.now()}`,
      messageDir: config.messageDir || `/tmp/swarm-${Date.now()}`,
      enablePersistence: config.enablePersistence ?? true,
      timeoutSeconds: config.timeoutSeconds || 60,
      requireAck: config.requireAck ?? false,
    };
  }

  async initialize(): Promise<void> {
    if (this.config.enablePersistence) {
      await mkdir(this.config.messageDir, { recursive: true });
      await mkdir(join(this.config.messageDir, "threads"), { recursive: true });
      await mkdir(join(this.config.messageDir, "presence"), { recursive: true });
    }
    this.isRunning = true;
    this.startMessageProcessor();
    this.emit("ready");
  }

  // Agent registration
  async registerAgent(persona: string): Promise<void> {
    const presence: AgentPresence = {
      persona,
      status: "idle",
      lastActivity: Date.now(),
    };
    this.presence.set(persona, presence);
    
    if (this.config.enablePersistence) {
      await this.savePresence(persona, presence);
    }
    
    this.emit("agent:joined", { persona, timestamp: Date.now() });
  }

  // Update agent status
  async updateStatus(
    persona: string, 
    status: AgentPresence["status"], 
    currentTask?: string
  ): Promise<void> {
    const presence = this.presence.get(persona);
    if (presence) {
      presence.status = status;
      presence.currentTask = currentTask;
      presence.lastActivity = Date.now();
      
      if (this.config.enablePersistence) {
        await this.savePresence(persona, presence);
      }
      
      this.emit("agent:status-change", { persona, status, currentTask });
    }
  }

  // Send message
  async send(message: Omit<Message, "id" | "timestamp">): Promise<string> {
    const fullMessage: Message = {
      ...message,
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
    };

    this.messageQueue.push(fullMessage);
    
    if (this.config.enablePersistence) {
      await this.persistMessage(fullMessage);
    }
    
    this.emit("message:sent", fullMessage);
    return fullMessage.id;
  }

  // Quick message helpers
  async broadcast(from: string, type: MessageType, content: string, metadata?: any): Promise<string> {
    return this.send({ from, to: "broadcast", type, content, metadata });
  }

  async ask(from: string, to: string, question: string, threadId?: string): Promise<string> {
    return this.send({ from, to, type: "question", content: question, threadId });
  }

  async reply(from: string, to: string, replyTo: string, content: string): Promise<string> {
    return this.send({ from, to, type: "response", content, replyTo });
  }

  async shareFinding(from: string, finding: string, confidence?: number): Promise<string> {
    return this.broadcast(from, "finding", finding, { confidence });
  }

  async flagConflict(from: string, withAgent: string, reason: string): Promise<string> {
    return this.send({
      from,
      to: withAgent,
      type: "conflict",
      content: reason,
    });
  }

  // Get messages for an agent
  getMessagesFor(agent: string, since?: number): Message[] {
    return this.messageQueue.filter(
      m => (m.to === agent || m.to === "broadcast" || m.from === agent) &&
           (!since || m.timestamp > since)
    );
  }

  // Get unread messages
  getUnread(agent: string, lastReadTimestamp: number): Message[] {
    return this.getMessagesFor(agent, lastReadTimestamp);
  }

  // Get conversation thread
  getThread(threadId: string): ConversationThread | undefined {
    return this.threads.get(threadId);
  }

  // Create new thread
  async createThread(topic: string, participants: string[]): Promise<string> {
    const thread: ConversationThread = {
      id: `thread-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      topic,
      participants,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    this.threads.set(thread.id, thread);
    
    if (this.config.enablePersistence) {
      await this.saveThread(thread);
    }
    
    this.emit("thread:created", thread);
    return thread.id;
  }

  // Get all agents
  getAllAgents(): string[] {
    return Array.from(this.presence.keys());
  }

  // Get active agents (not completed/failed)
  getActiveAgents(): string[] {
    return Array.from(this.presence.entries())
      .filter(([, p]) => p.status !== "completed")
      .map(([name]) => name);
  }

  // Wait for response to a specific message
  async waitForResponse(
    messageId: string, 
    fromAgent: string, 
    timeoutMs?: number
  ): Promise<Message | null> {
    const timeout = timeoutMs || this.config.timeoutSeconds * 1000;
    const startTime = Date.now();
    
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const response = this.messageQueue.find(
          m => m.replyTo === messageId && m.from === fromAgent
        );
        
        if (response) {
          clearInterval(checkInterval);
          resolve(response);
          return;
        }
        
        if (Date.now() - startTime > timeout) {
          clearInterval(checkInterval);
          resolve(null);
        }
      }, 100);
    });
  }

  // Get conversation summary
  getConversationSummary(): string {
    const lines: string[] = [];
    lines.push(`# Swarm Conversation Summary`);
    lines.push(`**Swarm ID:** ${this.config.swarmId}`);
    lines.push(`**Agents:** ${this.getAllAgents().join(", ")}`);
    lines.push(`**Total Messages:** ${this.messageQueue.length}`);
    lines.push(`**Threads:** ${this.threads.size}`);
    lines.push("");
    
    // Message type breakdown
    const typeCounts = new Map<string, number>();
    this.messageQueue.forEach(m => {
      typeCounts.set(m.type, (typeCounts.get(m.type) || 0) + 1);
    });
    lines.push(`## Message Types`);
    typeCounts.forEach((count, type) => {
      lines.push(`- ${type}: ${count}`);
    });
    lines.push("");
    
    // Chronological message log
    lines.push(`## Message Log`);
    this.messageQueue
      .sort((a, b) => a.timestamp - b.timestamp)
      .forEach(m => {
        const time = new Date(m.timestamp).toISOString().substr(11, 8);
        const target = m.to === "broadcast" ? "📢 ALL" : `→ ${m.to}`;
        lines.push(`[${time}] ${m.from} ${target} [${m.type}]: ${m.content.substring(0, 100)}${m.content.length > 100 ? "..." : ""}`);
      });
    
    return lines.join("\n");
  }

  // Shutdown
  async shutdown(): Promise<void> {
    this.isRunning = false;
    this.emit("shutdown");
    this.removeAllListeners();
  }

  // Private methods
  private startMessageProcessor(): void {
    const process = () => {
      if (!this.isRunning) return;
      // Process any queued actions
      setTimeout(process, 100);
    };
    process();
  }

  private async persistMessage(message: Message): Promise<void> {
    const filePath = join(this.config.messageDir, `msg-${message.id}.json`);
    await writeFile(filePath, JSON.stringify(message, null, 2));
  }

  private async savePresence(persona: string, presence: AgentPresence): Promise<void> {
    const filePath = join(this.config.messageDir, "presence", `${persona}.json`);
    await writeFile(filePath, JSON.stringify(presence, null, 2));
  }

  private async saveThread(thread: ConversationThread): Promise<void> {
    const filePath = join(this.config.messageDir, "threads", `${thread.id}.json`);
    await writeFile(filePath, JSON.stringify(thread, null, 2));
  }
}

// Agent wrapper with communication capabilities
class CommunicatingAgent {
  private bus: InterAgentBus;
  private persona: string;
  private lastReadTimestamp = 0;

  constructor(bus: InterAgentBus, persona: string) {
    this.bus = bus;
    this.persona = persona;
  }

  async initialize(): Promise<void> {
    await this.bus.registerAgent(this.persona);
  }

  async startTask(task: string): Promise<void> {
    await this.bus.updateStatus(this.persona, "working", task);
  }

  async completeTask(): Promise<void> {
    await this.bus.updateStatus(this.persona, "completed");
  }

  async shareFinding(finding: string, confidence?: number): Promise<void> {
    await this.bus.shareFinding(this.persona, finding, confidence);
  }

  async ask(agent: string, question: string): Promise<string | null> {
    const messageId = await this.bus.ask(this.persona, agent, question);
    const response = await this.bus.waitForResponse(messageId, agent, 30000);
    return response?.content || null;
  }

  async getCollaborativeContext(): Promise<string> {
    const messages = this.bus.getMessagesFor(this.persona, this.lastReadTimestamp);
    this.lastReadTimestamp = Date.now();
    
    if (messages.length === 0) return "";
    
    return messages
      .filter(m => m.type === "finding" || m.type === "consensus")
      .map(m => `[${m.from}]: ${m.content}`)
      .join("\n");
  }

  async checkForConflicts(): Promise<Array<{from: string; reason: string}>> {
    const messages = this.bus.getMessagesFor(this.persona);
    return messages
      .filter(m => m.type === "conflict" && m.to === this.persona)
      .map(m => ({ from: m.from, reason: m.content }));
  }
}

// Export for use in orchestrator
export { InterAgentBus, CommunicatingAgent, Message, MessageType, ConversationThread };

// CLI for standalone usage
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Inter-Agent Communication Hub

Usage: bun inter-agent-comms.ts <command> [options]

Commands:
  demo              Run a demo of agent communication
  monitor <swarmId> Monitor an active swarm
  export <swarmId>  Export conversation log

Options:
  --swarm-id, -s    Swarm identifier
  --output, -o      Output file path
  --help, -h        Show this help
`);
    process.exit(0);
  }

  const command = args[0];

  if (command === "demo") {
    console.log("🚀 Starting Inter-Agent Communication Demo\n");
    
    const bus = new InterAgentBus({ swarmId: "demo-swarm" });
    await bus.initialize();
    
    // Create agents
    const financial = new CommunicatingAgent(bus, "financial-advisor");
    const research = new CommunicatingAgent(bus, "research-analyst");
    const risk = new CommunicatingAgent(bus, "risk-analyst");
    
    await financial.initialize();
    await research.initialize();
    await risk.initialize();
    
    // Simulate collaboration
    console.log("📊 Agents collaborating on Tesla analysis...\n");
    
    await financial.startTask("Analyze Tesla valuation");
    await research.startTask("Research Tesla market position");
    await risk.startTask("Assess Tesla risks");
    
    // Share findings
    await financial.shareFinding("Tesla P/E ratio is 65x, above industry average of 25x", 0.7);
    await research.shareFinding("Tesla dominates US EV market with 55% share, but competition intensifying", 0.8);
    
    // Cross-agent question
    const financialAsk = await bus.ask("financial-advisor", "research-analyst", 
      "How quickly are competitors gaining market share?");
    
    await bus.reply("research-analyst", "financial-advisor", financialAsk,
      "Competitors gained 8% combined share in 2024. BYD and VW are fastest growing.");
    
    // Risk flags conflict
    await bus.send({
      from: "risk-analyst",
      to: "financial-advisor",
      type: "conflict",
      content: "High valuation multiple doesn't account for regulatory risks in China market",
    });
    
    // Consensus building
    await bus.broadcast("risk-analyst", "consensus", 
      "Agree with research on competitive pressure - this amplifies valuation risk");
    
    await new Promise(r => setTimeout(r, 500));
    
    // Print summary
    console.log(bus.getConversationSummary());
    
    await bus.shutdown();
    console.log("\n✅ Demo complete");
  }
}

if (import.meta.main) {
  main();
}
