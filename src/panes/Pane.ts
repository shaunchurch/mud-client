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
  private messages: PaneMessage[] = [];
  private maxMessages: number;
  private height: number;
  private originalHeight: number;
  private topRow: number = 0;

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

    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
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

  render(): void {
    if (this.topRow === 0) return;

    const termWidth = process.stdout.columns || 80;
    const visible = this.messages.slice(-this.height);
    const startRow = this.topRow + (this.height - visible.length);

    // Clear all lines in pane
    for (let i = 0; i < this.height; i++) {
      const row = this.topRow + i;
      process.stdout.write(CURSOR_TO(row, 1) + CLEAR_LINE);
    }

    // Write visible messages (bottom-aligned)
    for (let i = 0; i < visible.length; i++) {
      const msg = visible[i];
      const row = startRow + i;

      let text = msg.text;
      const visibleLen = text.replace(/\x1b\[[0-9;]*m/g, "").length;
      if (visibleLen > termWidth) {
        text = text.slice(0, termWidth - 3) + "...";
      }

      process.stdout.write(CURSOR_TO(row, 1) + text);
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
