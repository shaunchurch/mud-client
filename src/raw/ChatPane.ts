/**
 * ChatPane - Fixed panel for communication messages
 *
 * Renders tells/channel messages in a fixed region of the terminal.
 * Manually managed (no scroll region) - redraws entirely on update.
 */

// ANSI escape codes
const ESC = "\x1b";
const CSI = `${ESC}[`;
const CLEAR_LINE = `${CSI}2K`;
const CURSOR_TO = (row: number, col: number) => `${CSI}${row};${col}H`;

export interface ChatMessage {
  text: string;
  timestamp: Date;
}

export class ChatPane {
  private messages: ChatMessage[] = [];
  private maxMessages: number;
  private height: number;
  private topRow: number = 0;

  constructor(height: number = 5, maxMessages: number = 100) {
    this.height = height;
    this.maxMessages = maxMessages;
  }

  /**
   * Add message to buffer, trim if exceeds maxMessages
   */
  addMessage(text: string): void {
    // Strip ANSI positioning codes, keep colors
    const cleaned = this.stripPositioning(text);

    this.messages.push({
      text: cleaned,
      timestamp: new Date(),
    });

    // Trim oldest if over limit
    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }

    this.render();
  }

  /**
   * Update position/size - called on resize
   */
  setPosition(topRow: number, height: number): void {
    this.topRow = topRow;
    this.height = height;
  }

  /**
   * Render all visible messages to terminal
   * Bottom-aligned: most recent at bottom of panel
   */
  render(): void {
    if (this.topRow === 0) return; // Not positioned yet

    const termWidth = process.stdout.columns || 80;

    // Get last N messages where N = height
    const visible = this.messages.slice(-this.height);

    // Calculate starting row (bottom-align)
    const startRow = this.topRow + (this.height - visible.length);

    // Clear all lines in panel first
    for (let i = 0; i < this.height; i++) {
      const row = this.topRow + i;
      process.stdout.write(CURSOR_TO(row, 1) + CLEAR_LINE);
    }

    // Write visible messages
    for (let i = 0; i < visible.length; i++) {
      const msg = visible[i];
      const row = startRow + i;

      // Truncate if too long
      let text = msg.text;
      const visibleLen = text.replace(/\x1b\[[0-9;]*m/g, "").length;
      if (visibleLen > termWidth) {
        // Simple truncation - could improve to handle ANSI properly
        text = text.slice(0, termWidth - 3) + "...";
      }

      process.stdout.write(CURSOR_TO(row, 1) + text);
    }
  }

  /**
   * Clear message buffer
   */
  clear(): void {
    this.messages = [];
    this.render();
  }

  /**
   * Strip ANSI positioning codes, keep color/style codes
   */
  private stripPositioning(text: string): string {
    // Strip positioning: ESC[H, ESC[;H, ESC[row;colH, ESC[nA/B/C/D/G/J/K/s/u/r
    return text.replace(/\x1b\[[0-9;]*[HABCDGJKsur]/g, "");
  }
}
