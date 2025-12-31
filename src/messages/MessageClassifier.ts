/**
 * MessageClassifier - Identifies communication messages from MUD output
 *
 * Classifies lines as tells, channel messages, or other output.
 * Patterns configurable for future user customization.
 */

export type MessageType = "tell" | "channel" | "say" | "other";

export interface ClassifiedMessage {
  type: MessageType;
  raw: string;
  channel?: string;      // channel name if type="channel"
  sender?: string;       // who sent it (for tells/channels)
  isOutgoing?: boolean;  // true if "You tell..." vs "X tells you..."
}

interface TellPattern {
  pattern: RegExp;
  isOutgoing: boolean;
  senderGroup: number;
}

interface ChannelPattern {
  pattern: RegExp;
  channelGroup: number;
  contentGroup: number;
}

export class MessageClassifier {
  // Tell patterns - order matters, first match wins
  private tellPatterns: TellPattern[] = [
    // "Xal tells you : hey hey, what's up"
    { pattern: /^(\w+) tells you : .+$/, isOutgoing: false, senderGroup: 1 },
    // "You tell Xal: hey hey"
    { pattern: /^You tell (\w+): .+$/, isOutgoing: true, senderGroup: 1 },
    // "Xal replies: sup?"
    { pattern: /^(\w+) replies: .+$/, isOutgoing: false, senderGroup: 1 },
    // "You reply to Xal: yoyoyo"
    { pattern: /^You reply to (\w+): .+$/, isOutgoing: true, senderGroup: 1 },
  ];

  // Say patterns - same structure as tells
  private sayPatterns: TellPattern[] = [
    // "Xal says : hello there" (space before colon like tells)
    { pattern: /^(\w+) says ?: .+$/, isOutgoing: false, senderGroup: 1 },
    // "You say: hello"
    { pattern: /^You say ?: .+$/, isOutgoing: true, senderGroup: 0 },
  ];

  // Channel patterns
  private channelPattern: ChannelPattern = {
    // Matches [chaos], [*mortal*], etc.
    pattern: /^\[(\*?\w+\*?)\] (.+)$/,
    channelGroup: 1,
    contentGroup: 2,
  };

  // Patterns to extract sender from channel content - order matters, first match wins
  private channelContentPatterns = [
    // "<name> : <message>" - standard channel message
    /^(\w+) : .+$/,
    // "Renowned Warrior Cleric Blizz has logged in." - status messages (must be before emote)
    /^(?:[\w\s]+\s)?(\w+) has (?:logged in|logged out|gone idle|returned)\.$/,
    // "<name> <emote>" - channel emote (name followed by verb) - catch-all, must be last
    /^(\w+) \w+/,
  ];

  /**
   * Classify a single line of MUD output
   */
  classify(line: string): ClassifiedMessage {
    // Check for tells first
    for (const tellPattern of this.tellPatterns) {
      const match = line.match(tellPattern.pattern);
      if (match) {
        return {
          type: "tell",
          raw: line,
          sender: match[tellPattern.senderGroup],
          isOutgoing: tellPattern.isOutgoing,
        };
      }
    }

    // Check for says
    for (const sayPattern of this.sayPatterns) {
      const match = line.match(sayPattern.pattern);
      if (match) {
        return {
          type: "say",
          raw: line,
          sender: sayPattern.senderGroup > 0 ? match[sayPattern.senderGroup] : undefined,
          isOutgoing: sayPattern.isOutgoing,
        };
      }
    }

    // Check for channel messages
    const channelMatch = line.match(this.channelPattern.pattern);
    if (channelMatch) {
      const channel = channelMatch[this.channelPattern.channelGroup];
      const content = channelMatch[this.channelPattern.contentGroup];

      // Try to extract sender from content
      let sender: string | undefined;
      for (const contentPattern of this.channelContentPatterns) {
        const contentMatch = content.match(contentPattern);
        if (contentMatch) {
          sender = contentMatch[1];
          break;
        }
      }

      return {
        type: "channel",
        raw: line,
        channel,
        sender,
      };
    }

    // Default to "other"
    return {
      type: "other",
      raw: line,
    };
  }

  /**
   * Split text by newlines and classify each line
   */
  classifyLines(text: string): ClassifiedMessage[] {
    const lines = text.split("\n");
    return lines.map((line) => this.classify(line));
  }
}
