/**
 * MessageClassifier - Identifies communication messages from MUD output
 *
 * Classifies lines as tells, channel messages, or other output.
 * Patterns are configurable via panes.yaml.
 * Supports continuation lines (e.g., indented lines that belong to previous message).
 */

import type { ClassifiersConfig } from "../panes/types";

export type MessageType = "tell" | "channel" | "say" | "other";

export interface ClassifiedMessage {
  type: MessageType;
  raw: string;
  channel?: string;
  sender?: string;
  isOutgoing?: boolean;
  isContinuation?: boolean;
}

interface CompiledTellPattern {
  pattern: RegExp;
  senderGroup: number;
  isOutgoing: boolean;
}

interface CompiledChannelPattern {
  pattern: RegExp;
  channelGroup: number;
  contentGroup: number;
}

interface CompiledContentPattern {
  pattern: RegExp;
  senderGroup: number;
}

export class MessageClassifier {
  private tellPatterns: CompiledTellPattern[] = [];
  private sayPatterns: CompiledTellPattern[] = [];
  private channelPatterns: CompiledChannelPattern[] = [];
  private channelContentPatterns: CompiledContentPattern[] = [];
  private continuationPattern: RegExp | null = null;

  // Track last classification for continuation support
  private lastClassification: ClassifiedMessage | null = null;

  constructor(config?: ClassifiersConfig) {
    if (config) {
      this.loadFromConfig(config);
    } else {
      this.loadDefaults();
    }
  }

  loadFromConfig(config: ClassifiersConfig): void {
    this.tellPatterns = config.tell.map((p) => ({
      pattern: new RegExp(p.pattern),
      senderGroup: p.sender,
      isOutgoing: p.outgoing,
    }));

    this.sayPatterns = config.say.map((p) => ({
      pattern: new RegExp(p.pattern),
      senderGroup: p.sender,
      isOutgoing: p.outgoing,
    }));

    this.channelPatterns = config.channel.map((p) => ({
      pattern: new RegExp(p.pattern),
      channelGroup: p.channel,
      contentGroup: p.content,
    }));

    this.channelContentPatterns = config.channelContent.map((p) => ({
      pattern: new RegExp(p.pattern),
      senderGroup: p.sender,
    }));

    if (config.continuation) {
      this.continuationPattern = new RegExp(config.continuation);
    }
  }

  private loadDefaults(): void {
    this.tellPatterns = [
      { pattern: /^(\w+) tells you : .+$/, isOutgoing: false, senderGroup: 1 },
      { pattern: /^You tell (\w+): .+$/, isOutgoing: true, senderGroup: 1 },
      { pattern: /^(\w+) replies: .+$/, isOutgoing: false, senderGroup: 1 },
      { pattern: /^You reply to (\w+): .+$/, isOutgoing: true, senderGroup: 1 },
    ];

    this.sayPatterns = [
      { pattern: /^(\w+) says ?: .+$/, isOutgoing: false, senderGroup: 1 },
      { pattern: /^You say ?: .+$/, isOutgoing: true, senderGroup: 0 },
    ];

    this.channelPatterns = [
      { pattern: /^\[(\*?\w+\*?)\] (.+)$/, channelGroup: 1, contentGroup: 2 },
    ];

    this.channelContentPatterns = [
      { pattern: /^(\w+) : .+$/, senderGroup: 1 },
      { pattern: /^(?:[\w\s]+\s)?(\w+) has (?:logged in|logged out|gone idle|returned)\.$/, senderGroup: 1 },
      { pattern: /^(\w+) \w+/, senderGroup: 1 },
    ];

    // Default: lines starting with whitespace are continuations
    this.continuationPattern = /^\s+\S/;
  }

  classify(line: string): ClassifiedMessage {
    // Check for continuation first (if we have a previous non-other classification)
    if (
      this.continuationPattern &&
      this.lastClassification &&
      this.lastClassification.type !== "other" &&
      this.continuationPattern.test(line)
    ) {
      const result: ClassifiedMessage = {
        type: this.lastClassification.type,
        raw: line,
        channel: this.lastClassification.channel,
        sender: this.lastClassification.sender,
        isOutgoing: this.lastClassification.isOutgoing,
        isContinuation: true,
      };
      // Don't update lastClassification - keep tracking the original message
      return result;
    }

    // Check for tells
    for (const p of this.tellPatterns) {
      const match = line.match(p.pattern);
      if (match) {
        const result: ClassifiedMessage = {
          type: "tell",
          raw: line,
          sender: p.senderGroup > 0 ? match[p.senderGroup] : undefined,
          isOutgoing: p.isOutgoing,
        };
        this.lastClassification = result;
        return result;
      }
    }

    // Check for says
    for (const p of this.sayPatterns) {
      const match = line.match(p.pattern);
      if (match) {
        const result: ClassifiedMessage = {
          type: "say",
          raw: line,
          sender: p.senderGroup > 0 ? match[p.senderGroup] : undefined,
          isOutgoing: p.isOutgoing,
        };
        this.lastClassification = result;
        return result;
      }
    }

    // Check for channel messages
    for (const cp of this.channelPatterns) {
      const match = line.match(cp.pattern);
      if (match) {
        const channel = match[cp.channelGroup];
        const content = match[cp.contentGroup];

        // Try to extract sender from content
        let sender: string | undefined;
        for (const contentP of this.channelContentPatterns) {
          const contentMatch = content.match(contentP.pattern);
          if (contentMatch) {
            sender = contentMatch[contentP.senderGroup];
            break;
          }
        }

        const result: ClassifiedMessage = {
          type: "channel",
          raw: line,
          channel,
          sender,
        };
        this.lastClassification = result;
        return result;
      }
    }

    // Default to "other" - reset continuation tracking
    this.lastClassification = null;
    return {
      type: "other",
      raw: line,
    };
  }

  // Reset continuation tracking (call between separate message batches if needed)
  resetContinuation(): void {
    this.lastClassification = null;
  }

  classifyLines(text: string): ClassifiedMessage[] {
    const lines = text.split("\n");
    return lines.map((line) => this.classify(line));
  }
}
