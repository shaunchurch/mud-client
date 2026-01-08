/**
 * Pane - Generic configurable pane for displaying filtered messages
 */

import type { PaneConfig, PaneFilter } from "./types";
import type { ClassifiedMessage } from "../messages/MessageClassifier";

const ESC = "\x1b";
const CSI = `${ESC}[`;
const CLEAR_LINE = `${CSI}2K`;
const CURSOR_TO = (row: number, col: number) => `${CSI}${row};${col}H`;

export interface PaneMessage {
  text: string;
  classified: ClassifiedMessage;
  timestamp: Date;
}

export class Pane {
  readonly id: string;
  readonly filter: PaneFilter;
  readonly passthrough: boolean;
  private _enabled: boolean;
  private _focused: boolean = false;
  private messages: PaneMessage[] = [];
  private maxMessages: number;
  private height: number;
  private originalHeight: number;
  private topRow: number = 0;
  private scrollOffset: number = 0; // 0 = bottom (most recent), positive = scrolled up
  private _hasNewContent: boolean = false; // New content arrived while scrolled

  constructor(config: PaneConfig) {
    this.id = config.id;
    this.height = config.height;
    this.originalHeight = config.height;
    this.filter = config.filter;
    this.maxMessages = config.maxMessages || 100;
    this.passthrough = config.passthrough ?? false;
    this._enabled = config.enabled ?? true;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  get focused(): boolean {
    return this._focused;
  }

  setFocused(focused: boolean): void {
    this._focused = focused;
  }

  accepts(classified: ClassifiedMessage): boolean {
    const { filter } = this;

    // Check type filter
    if (filter.types && filter.types.length > 0) {
      if (!filter.types.includes(classified.type)) {
        return false;
      }
    }

    // Check channel whitelist
    if (filter.channels && filter.channels.length > 0) {
      if (classified.type === "channel" && classified.channel) {
        const normalizedChannel = classified.channel.replace(/\*/g, "").toLowerCase();
        if (!filter.channels.some((c) => c.toLowerCase() === normalizedChannel)) {
          return false;
        }
      } else if (classified.type === "channel") {
        // Channel type but no channel name - doesn't match whitelist
        return false;
      }
    }

    // Check channel blacklist
    if (filter.excludeChannels && filter.excludeChannels.length > 0) {
      if (classified.type === "channel" && classified.channel) {
        const normalizedChannel = classified.channel.replace(/\*/g, "").toLowerCase();
        if (filter.excludeChannels.some((c) => c.toLowerCase() === normalizedChannel)) {
          return false;
        }
      }
    }

    // Check additional pattern filter
    if (filter.pattern) {
      const regex = new RegExp(filter.pattern);
      if (!regex.test(classified.raw)) {
        return false;
      }
    }

    return true;
  }

  addMessage(text: string, classified: ClassifiedMessage): void {
    const cleaned = this.stripPositioning(text);

    this.messages.push({
      text: cleaned,
      classified,
      timestamp: new Date(),
    });

    // If scrolled up, lock the view by incrementing offset
    if (this.scrollOffset > 0) {
      this.scrollOffset++;
      this._hasNewContent = true;
    }

    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
      // Adjust scroll offset if we removed a message while scrolled
      if (this.scrollOffset > 0) {
        this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      }
    }

    this.render();
  }

  setPosition(topRow: number, height: number): void {
    this.topRow = topRow;
    this.height = height;
  }

  getHeight(): number {
    return this.height;
  }

  setHeight(height: number): void {
    this.height = height;
  }

  restoreOriginalHeight(): void {
    this.height = this.originalHeight;
  }

  setOriginalHeight(height: number): void {
    this.originalHeight = height;
    this.height = height;
  }

  getOriginalHeight(): number {
    return this.originalHeight;
  }

  setPassthrough(passthrough: boolean): void {
    (this as { passthrough: boolean }).passthrough = passthrough;
  }

  setMaxMessages(max: number): void {
    this.maxMessages = max;
  }

  getMaxMessages(): number {
    return this.maxMessages;
  }

  getPassthrough(): boolean {
    return this.passthrough;
  }

  scrollUp(lines: number): void {
    const maxScroll = Math.max(0, this.messages.length - this.height);
    this.scrollOffset = Math.min(maxScroll, this.scrollOffset + lines);
  }

  scrollDown(lines: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - lines);
    // Clear new content indicator when we reach the bottom
    if (this.scrollOffset === 0) {
      this._hasNewContent = false;
    }
  }

  resetScroll(): void {
    this.scrollOffset = 0;
    this._hasNewContent = false;
  }

  hasNewContent(): boolean {
    return this._hasNewContent;
  }

  getScrollOffset(): number {
    return this.scrollOffset;
  }

  getMessageCount(): number {
    return this.messages.length;
  }

  render(): void {
    if (this.topRow === 0) return;

    const termWidth = process.stdout.columns || 80;
    // Calculate visible window with scroll offset
    const endIndex = this.messages.length - this.scrollOffset;
    const startIndex = Math.max(0, endIndex - this.height);
    const visible = this.messages.slice(startIndex, endIndex);
    const startRow = this.topRow + (this.height - visible.length);

    // Focus indicator: yellow left border (single char, no shift when solo)
    const borderChar = this._focused ? "\x1b[33m│\x1b[0m" : "";
    const borderWidth = this._focused ? 1 : 0;
    const contentWidth = termWidth - borderWidth;

    // Clear all lines in pane
    for (let i = 0; i < this.height; i++) {
      const row = this.topRow + i;
      process.stdout.write(CURSOR_TO(row, 1) + CLEAR_LINE);
      if (this._focused) {
        process.stdout.write(borderChar);
      }
    }

    // Write visible messages (bottom-aligned)
    for (let i = 0; i < visible.length; i++) {
      const msg = visible[i];
      const row = startRow + i;

      let text = msg.text;
      const visibleLen = text.replace(/\x1b\[[0-9;]*m/g, "").length;
      if (visibleLen > contentWidth) {
        text = text.slice(0, contentWidth - 3) + "...";
      }

      process.stdout.write(CURSOR_TO(row, 1) + borderChar + text);
    }

    // Show new content indicator at bottom-right when scrolled with new content
    if (this._hasNewContent && this.scrollOffset > 0) {
      const indicator = "\x1b[38;5;242m↓new\x1b[0m"; // Dark grey
      const indicatorLen = 4; // "↓new"
      const bottomRow = this.topRow + this.height - 1;
      const indicatorCol = termWidth - indicatorLen;
      process.stdout.write(CURSOR_TO(bottomRow, indicatorCol) + indicator);
    }
  }

  clear(): void {
    this.messages = [];
    this.render();
  }

  private stripPositioning(text: string): string {
    return text.replace(/\x1b\[[0-9;]*[HABCDGJKsur]/g, "");
  }
}
