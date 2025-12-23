import * as fs from "fs";
import { TelnetClient } from "../connection/TelnetClient";
import { CommandHistory } from "../input/CommandHistory";
import { TabCompletion } from "../input/TabCompletion";
import { CharacterManager } from "../character/CharacterManager";
import type { ConnectionConfig } from "../character/Connection";
import type { CharacterConfig } from "../character/Character";
import { Menu, type MenuItem } from "./Menu";
import { TextPrompt } from "./TextPrompt";
import { SettingsManager } from "../settings/Settings";

// ANSI escape codes
const ESC = "\x1b";
const CSI = `${ESC}[`;
const CLEAR_LINE = `${CSI}2K`;
const CLEAR_SCREEN = `${CSI}2J`;
const CURSOR_HOME = `${CSI}H`;
const CURSOR_TO_COL = (n: number) => `${CSI}${n}G`;
const CURSOR_TO = (row: number, col: number) => `${CSI}${row};${col}H`;
const SET_SCROLL_REGION = (top: number, bottom: number) => `${CSI}${top};${bottom}r`;
const RESET_SCROLL_REGION = `${CSI}r`;
const SAVE_CURSOR = `${CSI}s`;
const RESTORE_CURSOR = `${CSI}u`;

type AppState = "menu" | "client";

class MudClient {
  private client: TelnetClient;
  private history: CommandHistory;
  private tabCompletion: TabCompletion;
  private charManager: CharacterManager;
  private settings: SettingsManager;
  private menu: Menu;
  private prompt: TextPrompt;

  private input = "";
  private cursorPos = 0;
  private inputSelected = false; // Entire input is selected (after sending command)
  private wordBuffer: Set<string> = new Set();
  private connected = false;
  private promptText = "> ";
  private appState: AppState = "menu";

  // Output buffering to avoid display corruption
  private outputBuffer = "";
  private outputTimer: ReturnType<typeof setTimeout> | null = null;
  private lastColorState = ""; // Track last SGR sequence for color continuity

  // Waiting for user to acknowledge disconnect
  private waitingForDisconnectAck = false;

  // Reverse search state
  private inReverseSearch = false;
  private searchQuery = "";
  private searchResults: string[] = [];
  private searchIndex = 0;
  private savedInput = "";

  // Current connection/character
  private currentConnection: ConnectionConfig | null = null;
  private currentCharacter: CharacterConfig | null = null;

  // Debug mode - logs raw data to file
  private debugMode = false;
  private debugLogStream: fs.WriteStream | null = null;

  // Last session for reconnect
  private lastConnection: ConnectionConfig | null = null;
  private lastCharacter: CharacterConfig | null = null;

  constructor() {
    this.client = new TelnetClient();
    this.history = new CommandHistory();
    this.tabCompletion = new TabCompletion();
    this.charManager = new CharacterManager(this.history);
    this.settings = new SettingsManager();
    this.menu = new Menu();
    this.prompt = new TextPrompt();

    this.setupTelnet();
    this.setupInput();
    this.setupResizeHandler();
  }

  private setupResizeHandler(): void {
    process.stdout.on("resize", () => {
      if (this.appState === "client") {
        // Re-establish scroll region with new terminal size
        this.setupScrollRegion();
        this.redrawInput();
      }
    });
  }

  async start(autoHost?: string, autoPort?: number): Promise<void> {
    if (autoHost) {
      // Auto-connect mode: skip menu
      this.appState = "client";
      this.setupScrollRegion();
      this.echo(`Connecting to ${autoHost}:${autoPort || 23}...`);
      this.client.connect(autoHost, autoPort || 23);
      this.redrawInput();
    } else {
      // Show connection menu
      await this.showConnectionMenu();
    }
  }

  private async showConnectionMenu(): Promise<void> {
    this.appState = "menu";
    // Reset scroll region when returning to menu
    this.resetScrollRegion();
    const connections = this.charManager.listConnections();

    const items: MenuItem[] = [];

    // Add reconnect option at the top if available
    if (this.lastConnection && this.lastCharacter) {
      items.push({
        label: `↻ Reconnect: ${this.lastCharacter.name}@${this.lastConnection.host}`,
        value: "__reconnect__",
      });
    }

    // Add existing connections
    for (const conn of connections) {
      items.push({
        label: `${conn.name} (${conn.host}:${conn.port})`,
        value: conn.id,
      });
    }

    const result = await this.menu.show("Select Connection", items, {
      showNew: true,
      newLabel: "+ New connection",
      allowDelete: connections.length > 0,
    });

    if (result.action === "quit") {
      this.cleanup();
      process.exit(0);
    } else if (result.action === "new") {
      await this.createNewConnection();
    } else if (result.action === "delete") {
      await this.confirmDeleteConnection(result.value);
    } else if (result.action === "select") {
      if (result.value === "__reconnect__") {
        await this.reconnect();
      } else {
        this.charManager.selectConnection(result.value);
        this.currentConnection = this.charManager.getCurrentConnection();
        await this.showCharacterMenu();
      }
    }
  }

  private async reconnect(): Promise<void> {
    if (!this.lastConnection || !this.lastCharacter) {
      await this.showConnectionMenu();
      return;
    }

    this.currentConnection = this.lastConnection;
    this.currentCharacter = this.lastCharacter;

    // Select in manager to set up history etc
    this.charManager.selectConnection(this.lastConnection.id);
    this.charManager.selectCharacter(this.lastCharacter.id);

    await this.connectAndStart();
  }

  private async confirmDeleteConnection(connectionId: string): Promise<void> {
    // Can't delete the reconnect option
    if (connectionId === "__reconnect__") {
      await this.showConnectionMenu();
      return;
    }

    const connections = this.charManager.listConnections();
    const conn = connections.find((c) => c.id === connectionId);
    if (!conn) {
      await this.showConnectionMenu();
      return;
    }

    const result = await this.menu.show(
      `Delete ${conn.name}?`,
      [
        { label: "No, keep connection", value: "no" },
        { label: "Yes, delete permanently", value: "yes" },
      ],
      { showBack: true }
    );

    if (result.action === "select" && result.value === "yes") {
      this.charManager.deleteConnection(connectionId);
    }

    await this.showConnectionMenu();
  }

  private async createNewConnection(): Promise<void> {
    // Get host
    const hostResult = await this.prompt.show("New Connection", "Host (e.g., mud.example.com):");
    if (hostResult.action === "cancel") {
      await this.showConnectionMenu();
      return;
    }

    const host = hostResult.value.trim();
    if (!host) {
      await this.showConnectionMenu();
      return;
    }

    // Get port
    const portResult = await this.prompt.show("New Connection", "Port:", { defaultValue: "23" });
    if (portResult.action === "cancel") {
      await this.showConnectionMenu();
      return;
    }

    const port = parseInt(portResult.value.trim() || "23", 10);
    if (isNaN(port) || port <= 0 || port > 65535) {
      await this.showConnectionMenu();
      return;
    }

    // Create connection
    const conn = this.charManager.createConnection(host, host, port);
    this.charManager.selectConnection(conn.id);
    this.currentConnection = conn;
    await this.showCharacterMenu();
  }

  private async showCharacterMenu(): Promise<void> {
    if (!this.currentConnection) {
      await this.showConnectionMenu();
      return;
    }

    const characters = this.charManager.listCharacters();

    const items: MenuItem[] = characters.map((char) => ({
      label: char.name,
      value: char.id,
    }));

    const result = await this.menu.show(
      `Characters on ${this.currentConnection.name}`,
      items,
      {
        showBack: true,
        showNew: true,
        newLabel: "+ New character",
        allowDelete: characters.length > 0,
      }
    );

    if (result.action === "quit") {
      this.cleanup();
      process.exit(0);
    } else if (result.action === "back") {
      this.currentConnection = null;
      await this.showConnectionMenu();
    } else if (result.action === "new") {
      await this.createNewCharacter();
    } else if (result.action === "delete") {
      await this.confirmDeleteCharacter(result.value);
    } else if (result.action === "select") {
      this.charManager.selectCharacter(result.value);
      this.currentCharacter = this.charManager.getCurrentCharacter();
      await this.connectAndStart();
    }
  }

  private async confirmDeleteCharacter(characterId: string): Promise<void> {
    if (!this.currentConnection) {
      await this.showConnectionMenu();
      return;
    }

    const characters = this.charManager.listCharacters();
    const char = characters.find((c) => c.id === characterId);
    if (!char) {
      await this.showCharacterMenu();
      return;
    }

    const result = await this.menu.show(
      `Delete ${char.name}?`,
      [
        { label: "No, keep character", value: "no" },
        { label: "Yes, delete permanently", value: "yes" },
      ],
      { showBack: true }
    );

    if (result.action === "select" && result.value === "yes") {
      this.charManager.deleteCharacter(characterId);
    }

    await this.showCharacterMenu();
  }

  private async createNewCharacter(): Promise<void> {
    // Get name
    const nameResult = await this.prompt.show("New Character", "Character name:");
    if (nameResult.action === "cancel") {
      await this.showCharacterMenu();
      return;
    }

    const name = nameResult.value.trim();
    if (!name) {
      await this.showCharacterMenu();
      return;
    }

    // Get password (optional)
    const pwResult = await this.prompt.show("New Character", "Password (optional):", {
      isPassword: true,
    });
    const password = pwResult.action === "submit" ? pwResult.value : undefined;

    // Create character
    const char = this.charManager.createCharacter(name, password || undefined);
    if (char) {
      this.charManager.selectCharacter(char.id);
      this.currentCharacter = char;
      await this.connectAndStart();
    } else {
      await this.showCharacterMenu();
    }
  }

  private async connectAndStart(): Promise<void> {
    if (!this.currentConnection || !this.currentCharacter) {
      await this.showConnectionMenu();
      return;
    }

    this.appState = "client";

    // Set up scroll region: all but the last line
    this.setupScrollRegion();

    // Clear screen and show connection info
    process.stdout.write(CLEAR_SCREEN + CURSOR_HOME);
    this.echo(`Character: ${this.currentCharacter.name}`);
    this.echo(`Connecting to ${this.currentConnection.host}:${this.currentConnection.port}...`);

    // Update prompt with character name
    this.updatePrompt();

    // Connect
    this.client.connect(this.currentConnection.host, this.currentConnection.port);
    this.redrawInput();
  }

  private setupScrollRegion(): void {
    const termHeight = process.stdout.rows || 24;
    // Set scroll region to all but the last 2 lines (divider + input)
    // Divider at termHeight-1 is outside scroll region and won't scroll
    process.stdout.write(SET_SCROLL_REGION(1, termHeight - 2));
    // Move cursor to top of scroll region
    process.stdout.write(CURSOR_HOME);
  }

  private resetScrollRegion(): void {
    process.stdout.write(RESET_SCROLL_REGION);
  }

  private updatePrompt(): void {
    if (this.settings.get("statusPosition") === "prompt") {
      const status = this.getStatusText();
      this.promptText = status ? `${status} > ` : "> ";
    } else {
      this.promptText = "> ";
    }
  }

  private getStatusText(): string {
    if (this.currentCharacter && this.currentConnection) {
      const status = this.connected ? "" : " (disconnected)";
      return `${this.currentCharacter.name}@${this.currentConnection.host}${status}`;
    } else if (this.connected) {
      return "connected";
    } else {
      return "disconnected";
    }
  }

  private showDisconnectPrompt(): void {
    this.waitingForDisconnectAck = true;
    process.stdout.write("\r\n");
    process.stdout.write("\x1b[33m(disconnected) Press Enter to continue or Esc to exit...\x1b[0m");
  }

  private flushOutput(): void {
    if (!this.outputBuffer) return;

    // Only flush complete lines - find last newline
    const lastNewline = this.outputBuffer.lastIndexOf("\n");
    if (lastNewline === -1) {
      // No complete lines yet, keep buffering
      this.outputTimer = null;
      return;
    }

    // Split into complete lines, keep partial remainder for next flush
    let toFlush = this.outputBuffer.slice(0, lastNewline + 1);
    this.outputBuffer = this.outputBuffer.slice(lastNewline + 1);
    this.outputTimer = null;

    // Debug: log raw buffer content before processing
    if (this.debugMode && this.debugLogStream) {
      const hex = Buffer.from(toFlush).toString("hex");
      const readable = toFlush.replace(/[\x00-\x1f]/g, (c) => `<${c.charCodeAt(0).toString(16)}>`);
      this.debugLogStream.write(`[FLUSH RAW] len=${toFlush.length}\n`);
      this.debugLogStream.write(`[FLUSH HEX] ${hex}\n`);
      this.debugLogStream.write(`[FLUSH TXT] ${readable}\n`);
    }

    // Add timestamps if enabled
    const timestampMode = this.settings.get("timestamps");
    if (timestampMode !== "hidden") {
      toFlush = this.addTimestamps(toFlush, timestampMode);
    }

    // Word wrap if enabled
    if (this.settings.get("wordWrap")) {
      const termWidth = process.stdout.columns || 80;
      toFlush = this.wrapMudOutput(toFlush, termWidth);
    }

    const termHeight = process.stdout.rows || 24;

    // Ensure scroll region is correct (defensive - prevents drift)
    process.stdout.write(SET_SCROLL_REGION(1, termHeight - 2));

    // Save cursor, move to scroll region, output, restore cursor
    process.stdout.write(SAVE_CURSOR);

    // Move to bottom of scroll region (row termHeight-2)
    process.stdout.write(CURSOR_TO(termHeight - 2, 1));

    // Scroll first by writing a newline, so new content appears below existing
    process.stdout.write("\n");

    // Strip trailing newlines since we handle scrolling ourselves
    toFlush = toFlush.replace(/\n+$/, "");

    // Restore previous color state before writing
    if (this.lastColorState) {
      process.stdout.write(this.lastColorState);
    }

    // Strip bare CR characters - they cause display corruption with scroll regions
    // (CRLF has already been normalized to LF by TelnetClient)
    toFlush = toFlush.replace(/\r/g, "");

    // Strip ANSI cursor positioning sequences that would break scroll region layout
    // Keep SGR (color/style) sequences ending in 'm', strip positioning ones:
    // - ESC[H, ESC[;H, ESC[row;colH - cursor position
    // - ESC[nA/B/C/D - cursor up/down/forward/back
    // - ESC[nG - cursor to column
    // - ESC[s/u - save/restore cursor (conflicts with our own)
    // - ESC[nJ/K - erase display/line
    // - ESC[r, ESC[n;mr - scroll region (would corrupt our layout)
    toFlush = toFlush.replace(/\x1b\[[0-9;]*[HABCDGJKsur]/g, "");

    // Debug: log after stripping
    if (this.debugMode && this.debugLogStream) {
      this.debugLogStream.write(`[FLUSH OUT] len=${toFlush.length}\n`);
      this.debugLogStream.write(`---\n`);
    }

    // Write output - let terminal handle scrolling within the region
    process.stdout.write(toFlush);

    // Extract and save last SGR (color) sequence for next flush
    const sgrMatches = toFlush.match(/\x1b\[[0-9;]*m/g);
    if (sgrMatches) {
      this.lastColorState = sgrMatches[sgrMatches.length - 1];
    }

    // Restore cursor and redraw input on the last line
    process.stdout.write(RESTORE_CURSOR);
    this.redrawInput();
  }

  private addTimestamps(text: string, mode: "time" | "datetime"): string {
    const now = new Date();
    let timestamp: string;
    if (mode === "time") {
      timestamp = now.toLocaleTimeString("en-US", { hour12: false });
    } else {
      timestamp = now.toLocaleString("en-US", {
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    }
    const prefix = `\x1b[90m[${timestamp}]\x1b[0m `;

    // Split by newline, prepend timestamp to non-empty lines
    const lines = text.split("\n");
    return lines
      .map((line, i) => {
        // Don't add timestamp to the last empty element after final newline
        if (i === lines.length - 1 && line === "") return line;
        // Don't add timestamp to blank lines
        const stripped = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
        if (!stripped) return line;
        return prefix + line;
      })
      .join("\n");
  }

  private wrapMudOutput(text: string, maxWidth: number): string {
    const lines = text.split("\n");
    const wrappedLines: string[] = [];

    for (const line of lines) {
      // Calculate visible length (excluding ANSI codes)
      const visibleLen = line.replace(/\x1b\[[0-9;]*m/g, "").length;

      if (visibleLen <= maxWidth) {
        wrappedLines.push(line);
        continue;
      }

      // Parse line into segments (text and ANSI codes)
      const segments: { text: string; ansi: string }[] = [];
      let currentAnsi = "";
      let remaining = line;

      while (remaining.length > 0) {
        const ansiMatch = remaining.match(/^\x1b\[[0-9;]*m/);
        if (ansiMatch) {
          currentAnsi = ansiMatch[0];
          remaining = remaining.slice(ansiMatch[0].length);
          continue;
        }

        // Find next space or ANSI code
        const nextSpace = remaining.indexOf(" ");
        const nextAnsi = remaining.search(/\x1b\[/);

        let wordEnd: number;
        if (nextSpace === -1 && nextAnsi === -1) {
          wordEnd = remaining.length;
        } else if (nextSpace === -1) {
          wordEnd = nextAnsi;
        } else if (nextAnsi === -1) {
          wordEnd = nextSpace + 1; // Include the space
        } else {
          wordEnd = Math.min(nextSpace + 1, nextAnsi);
        }

        segments.push({ text: remaining.slice(0, wordEnd), ansi: currentAnsi });
        remaining = remaining.slice(wordEnd);
      }

      // Build wrapped lines from segments
      let currentLine = "";
      let currentVisibleLen = 0;
      let lastAnsi = "";

      for (const seg of segments) {
        const segVisibleLen = seg.text.length;

        // If this segment would overflow, wrap first
        if (currentVisibleLen + segVisibleLen > maxWidth && currentVisibleLen > 0) {
          wrappedLines.push(currentLine);
          currentLine = lastAnsi; // Restore color state
          currentVisibleLen = 0;
        }

        // Add ANSI code if different from current
        if (seg.ansi && seg.ansi !== lastAnsi) {
          currentLine += seg.ansi;
          lastAnsi = seg.ansi;
        }

        currentLine += seg.text;
        currentVisibleLen += segVisibleLen;
      }

      if (currentLine.length > 0) {
        wrappedLines.push(currentLine);
      }
    }

    return wrappedLines.join("\n");
  }

  private setupTelnet(): void {
    this.client.on("data", (data: string) => {
      if (this.appState !== "client") return;

      // Buffer output and flush after a short delay to avoid display corruption
      this.outputBuffer += data;

      // Extract words for tab completion
      this.extractWords(data);

      // Reset timer on each chunk
      if (this.outputTimer) {
        clearTimeout(this.outputTimer);
      }

      // Flush after 50ms of no new data
      this.outputTimer = setTimeout(() => {
        this.flushOutput();
      }, 50);
    });

    this.client.on("connect", () => {
      this.connected = true;
      this.updatePrompt();
      if (this.appState === "client") {
        this.echo("Connected!");
        this.redrawInput();

        // Auto-login: send character name and password
        if (this.currentCharacter) {
          setTimeout(() => {
            if (this.connected && this.currentCharacter) {
              this.client.send(this.currentCharacter.name);
              // Send password after a short delay if set
              if (this.currentCharacter.password) {
                setTimeout(() => {
                  if (this.connected && this.currentCharacter?.password) {
                    this.client.send(this.currentCharacter.password);
                  }
                }, 500);
              }
            }
          }, 300);
        }
      }
    });

    this.client.on("close", () => {
      this.connected = false;
      this.updatePrompt();
      if (this.appState === "client") {
        // Save last session for reconnect
        if (this.currentConnection && this.currentCharacter) {
          this.lastConnection = this.currentConnection;
          this.lastCharacter = this.currentCharacter;
        }

        this.echo("Disconnected.");

        // Auto-reconnect if enabled and we have a connection to reconnect to
        if (this.settings.get("autoReconnect") && this.currentConnection) {
          this.echo("Reconnecting in 3 seconds...");
          setTimeout(() => {
            if (this.currentConnection && !this.connected) {
              this.client.connect(this.currentConnection.host, this.currentConnection.port);
            }
          }, 3000);
        } else {
          this.showDisconnectPrompt();
        }
      }
    });

    this.client.on("error", (err: Error) => {
      if (this.appState === "client") {
        this.echo(`Error: ${err.message}`);
      }
    });

    this.client.on("stateChange", (state) => {
      this.connected = state === "connected";
      this.updatePrompt();
      if (this.appState === "client") {
        this.redrawInput();
      }
    });
  }

  private setupInput(): void {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    process.stdin.on("data", (key: string) => {
      this.handleKey(key);
    });

    process.on("SIGINT", () => {
      this.cleanup();
      process.exit(0);
    });
  }

  private handleKey(key: string): void {
    // Route to menu/prompt if active
    if (this.menu.isActive()) {
      this.menu.handleKey(key);
      return;
    }

    if (this.prompt.isActive()) {
      this.prompt.handleKey(key);
      return;
    }

    // Waiting for user to acknowledge disconnect
    if (this.waitingForDisconnectAck) {
      if (key === "\r" || key === "\n" || key === " ") {
        this.waitingForDisconnectAck = false;
        this.showConnectionMenu();
      } else if (key === "\x1b") {
        // Escape - clear screen and exit
        process.stdout.write(CLEAR_SCREEN + CURSOR_HOME);
        this.cleanup();
        process.exit(0);
      }
      return;
    }

    // Handle reverse search mode
    if (this.inReverseSearch) {
      this.handleReverseSearchKey(key);
      return;
    }

    const code = key.charCodeAt(0);

    // Ctrl+R - enter reverse search
    if (key === "\x12") {
      this.enterReverseSearch();
      return;
    }

    // Ctrl+C
    if (key === "\x03") {
      if (this.connected) {
        this.client.disconnect();
      } else {
        this.cleanup();
        process.exit(0);
      }
      return;
    }

    // Ctrl+D - disconnect/exit
    if (key === "\x04") {
      if (this.connected) {
        this.client.disconnect();
      } else {
        this.cleanup();
        process.exit(0);
      }
      return;
    }

    // Ctrl+L - clear screen
    if (key === "\x0c") {
      process.stdout.write(CLEAR_SCREEN + CURSOR_HOME);
      this.redrawInput();
      return;
    }

    // Ctrl+A - start of line
    if (key === "\x01") {
      this.cursorPos = 0;
      this.inputSelected = false;
      this.redrawInput();
      return;
    }

    // Ctrl+E - end of line
    if (key === "\x05") {
      this.cursorPos = this.input.length;
      this.inputSelected = false;
      this.redrawInput();
      return;
    }

    // Ctrl+K - kill to end of line
    if (key === "\x0b") {
      this.input = this.input.slice(0, this.cursorPos);
      this.redrawInput();
      return;
    }

    // Ctrl+U - clear line
    if (key === "\x15") {
      this.clearInput();
      this.redrawInput();
      return;
    }

    // Ctrl+W - delete word
    if (key === "\x17") {
      if (this.inputSelected) {
        this.clearInput();
      } else {
        const beforeCursor = this.input.slice(0, this.cursorPos);
        const afterCursor = this.input.slice(this.cursorPos);
        const trimmed = beforeCursor.trimEnd();
        const lastSpace = trimmed.lastIndexOf(" ");
        this.input = (lastSpace === -1 ? "" : trimmed.slice(0, lastSpace + 1)) + afterCursor;
        this.cursorPos = lastSpace === -1 ? 0 : lastSpace + 1;
      }
      this.redrawInput();
      return;
    }

    // Enter
    if (key === "\r" || key === "\n") {
      if (this.input.trim()) {
        this.echoCommand(this.input);
      }
      this.handleCommand(this.input);
      if (this.input) {
        if (this.settings.get("inputMode") === "clear") {
          this.clearInput();
        } else {
          this.inputSelected = true;
          this.cursorPos = this.input.length;
        }
      }
      this.redrawInput();
      return;
    }

    // Backspace
    if (key === "\x7f" || key === "\b") {
      if (this.inputSelected) {
        this.clearInput();
        this.redrawInput();
      } else if (this.cursorPos > 0) {
        this.input = this.input.slice(0, this.cursorPos - 1) + this.input.slice(this.cursorPos);
        this.cursorPos--;
        this.redrawInput();
      }
      return;
    }

    // Tab - completion
    if (key === "\t") {
      this.inputSelected = false;

      // Special case: "/set [key]" - cycle through setting keys
      const setKeysMatch = this.input.match(/^\/set\s+(\S*)$/);
      if (setKeysMatch) {
        const keys = this.settings.getKeys();
        const currentKey = setKeysMatch[1] || "";
        const completed = this.tabCompletion.cycle("/set ", keys, currentKey, this.input);
        this.input = completed;
        this.cursorPos = this.input.length;
        this.redrawInput();
        return;
      }

      // Special case: "/set <key> [value]" - cycle through valid values
      const setValueMatch = this.input.match(/^\/set\s+(\S+)\s+(\S*)$/);
      if (setValueMatch && this.settings.isValidKey(setValueMatch[1])) {
        const settingKey = setValueMatch[1] as keyof import("../settings/Settings").AppSettings;
        const values = [...this.settings.getValidValues(settingKey)];
        const currentValue = setValueMatch[2] || "";
        const completed = this.tabCompletion.cycle(
          `/set ${setValueMatch[1]} `,
          values,
          currentValue,
          this.input
        );
        this.input = completed;
        this.cursorPos = this.input.length;
        this.redrawInput();
        return;
      }

      // Default word completion
      const words = this.getCompletionWords();
      const completed = this.tabCompletion.complete(this.input, words);
      this.input = completed;
      this.cursorPos = this.input.length;
      this.redrawInput();
      return;
    }

    // Escape sequences (arrows, etc.)
    if (key.startsWith("\x1b[") || key.startsWith("\x1bO")) {
      const seq = key.slice(2);

      // Up arrow - history previous
      if (seq === "A") {
        this.inputSelected = false;
        const prev = this.history.previous();
        if (prev !== null) {
          this.input = prev;
          this.cursorPos = this.input.length;
          this.redrawInput();
        }
        return;
      }

      // Down arrow - history next
      if (seq === "B") {
        this.inputSelected = false;
        const next = this.history.next();
        this.input = next || "";
        this.cursorPos = this.input.length;
        this.redrawInput();
        return;
      }

      // Left arrow
      if (seq === "D") {
        if (this.inputSelected) {
          this.inputSelected = false;
          this.cursorPos = 0; // Move to start when deselecting
          this.redrawInput();
        } else if (this.cursorPos > 0) {
          this.cursorPos--;
          this.redrawInput();
        }
        return;
      }

      // Right arrow
      if (seq === "C") {
        if (this.inputSelected) {
          this.inputSelected = false;
          this.cursorPos = this.input.length; // Move to end when deselecting
          this.redrawInput();
        } else if (this.cursorPos < this.input.length) {
          this.cursorPos++;
          this.redrawInput();
        }
        return;
      }

      // Home
      if (seq === "H" || seq === "1~") {
        this.inputSelected = false;
        this.cursorPos = 0;
        this.redrawInput();
        return;
      }

      // End
      if (seq === "F" || seq === "4~") {
        this.inputSelected = false;
        this.cursorPos = this.input.length;
        this.redrawInput();
        return;
      }

      // Delete
      if (seq === "3~") {
        if (this.inputSelected) {
          this.clearInput();
          this.redrawInput();
        } else if (this.cursorPos < this.input.length) {
          this.input = this.input.slice(0, this.cursorPos) + this.input.slice(this.cursorPos + 1);
          this.redrawInput();
        }
        return;
      }

      return;
    }

    // Shift+roguelike movement keys (classic NetHack/Vim layout)
    // H=west, L=east, K=north, J=south
    // Y=nw, U=ne, B=sw, N=se
    // < >= up/down, . = look
    if (this.settings.get("movementKeys")) {
      const movementMap: Record<string, string> = {
        H: "w",
        L: "e",
        K: "n",
        J: "s",
        Y: "nw",
        U: "ne",
        B: "sw",
        N: "se",
        "<": "u",
        ">": "d",
        ":": "look",
      };
      const movement = movementMap[key];
      if (movement && this.connected) {
        this.sendAndEcho(movement);
        return;
      }
    }

    // Regular printable character
    if (code >= 32 && code < 127) {
      if (this.inputSelected) {
        // Replace entire input when selected
        this.input = key;
        this.cursorPos = 1;
        this.inputSelected = false;
      } else {
        this.input = this.input.slice(0, this.cursorPos) + key + this.input.slice(this.cursorPos);
        this.cursorPos++;
      }
      this.redrawInput();
    }
  }

  private enterReverseSearch(): void {
    this.inReverseSearch = true;
    this.inputSelected = false;
    this.savedInput = this.input;
    this.searchQuery = "";
    this.searchResults = this.history.getAll().slice(-50).reverse();
    this.searchIndex = 0;
    this.redrawSearch();
  }

  private exitReverseSearch(accept: boolean, execute: boolean = false): void {
    this.inReverseSearch = false;
    if (accept && this.searchQuery && this.searchResults.length > 0) {
      this.input = this.searchResults[this.searchIndex] || "";
      this.cursorPos = this.input.length;

      if (execute && this.input) {
        process.stdout.write("\r\n");
        this.handleCommand(this.input);
        this.input = "";
        this.cursorPos = 0;
      }
    } else {
      this.input = this.savedInput;
      this.cursorPos = this.input.length;
    }
    this.redrawInput();
  }

  private updateSearch(): void {
    if (!this.searchQuery) {
      this.searchResults = this.history.getAll().slice(-50).reverse();
    } else {
      this.searchResults = this.history.search(this.searchQuery);
    }
    this.searchIndex = 0;
    this.redrawSearch();
  }

  private handleReverseSearchKey(key: string): void {
    const code = key.charCodeAt(0);

    if (key === "\x12") {
      if (this.searchResults.length > 0) {
        this.searchIndex = (this.searchIndex + 1) % this.searchResults.length;
        this.redrawSearch();
      }
      return;
    }

    if (key === "\x03" || key === "\x07" || key === "\x1b") {
      this.exitReverseSearch(false);
      return;
    }

    if (key === "\r" || key === "\n") {
      this.exitReverseSearch(true, true);
      return;
    }

    if (key === "\x7f" || key === "\b") {
      if (this.searchQuery.length > 0) {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this.updateSearch();
      }
      return;
    }

    if (key.startsWith("\x1b[") && key.slice(2) === "A") {
      if (this.searchIndex < this.searchResults.length - 1) {
        this.searchIndex++;
        this.redrawSearch();
      }
      return;
    }

    if (key.startsWith("\x1b[") && key.slice(2) === "B") {
      if (this.searchIndex > 0) {
        this.searchIndex--;
        this.redrawSearch();
      }
      return;
    }

    if (code >= 32 && code < 127) {
      this.searchQuery += key;
      this.updateSearch();
    }
  }

  private redrawSearch(): void {
    const match = this.searchQuery ? (this.searchResults[this.searchIndex] || "") : "";
    const line = `\x1b[36m(reverse-i-search)\x1b[0m\`${this.searchQuery}': ${match}`;
    process.stdout.write(CLEAR_LINE + "\r" + line);
  }

  private handleCommand(cmd: string): void {
    const trimmed = cmd.trim();

    // Allow blank lines to be sent to MUD (but don't add to history)
    if (!trimmed) {
      if (this.connected) {
        this.client.send("");
      }
      return;
    }

    this.history.add(trimmed);
    this.history.reset();

    // Client commands
    if (trimmed.startsWith("/")) {
      const parts = trimmed.slice(1).split(/\s+/);
      const command = parts[0]?.toLowerCase();

      if (command === "connect" && parts[1]) {
        const host = parts[1];
        const port = parseInt(parts[2] || "23", 10);
        this.echo(`Connecting to ${host}:${port}...`);
        this.client.connect(host, port);
      } else if (command === "disconnect" || command === "quit") {
        this.client.disconnect();
      } else if (command === "reconnect") {
        if (this.currentConnection) {
          this.echo(`Reconnecting to ${this.currentConnection.host}:${this.currentConnection.port}...`);
          this.client.connect(this.currentConnection.host, this.currentConnection.port);
        } else {
          this.echo("No connection to reconnect to.");
        }
      } else if (command === "menu") {
        this.client.disconnect();
        this.showConnectionMenu();
      } else if (command === "exit") {
        this.cleanup();
        process.exit(0);
      } else if (command === "clear") {
        process.stdout.write(CLEAR_SCREEN + CURSOR_HOME);
      } else if (command === "alias" && parts[1] && parts[2]) {
        const name = parts[1];
        const expansion = parts.slice(2).join(" ");
        if (this.charManager.setAlias(name, expansion)) {
          this.echo(`Alias set: ${name} = ${expansion}`);
        } else {
          this.echo("No character selected.");
        }
      } else if (command === "unalias" && parts[1]) {
        if (this.charManager.removeAlias(parts[1])) {
          this.echo(`Alias removed: ${parts[1]}`);
        } else {
          this.echo("No character selected or alias not found.");
        }
      } else if (command === "aliases") {
        const aliases = this.charManager.getAliases();
        const entries = Object.entries(aliases);
        if (entries.length === 0) {
          this.echo("No aliases defined.");
        } else {
          this.echo("Aliases:");
          for (const [name, expansion] of entries) {
            this.echo(`  ${name} = ${expansion}`);
          }
        }
      } else if (command === "help") {
        this.echo("Commands:");
        this.echo("  /connect <host> [port] - Connect to a MUD");
        this.echo("  /disconnect - Disconnect from current MUD");
        this.echo("  /reconnect - Reconnect to last connection");
        this.echo("  /menu - Return to connection/character menu");
        this.echo("  /alias <name> <expansion> - Create alias");
        this.echo("  /unalias <name> - Remove alias");
        this.echo("  /aliases - List all aliases");
        this.echo("  /config - Show all settings");
        this.echo("  /set <key> <value> - Change a setting");
        this.echo("  /clear - Clear screen");
        this.echo("  /debug - Toggle debug logging to /tmp/mud-client-debug.log");
        this.echo("  /exit - Exit client");
        this.echo("");
        this.echo("Keyboard shortcuts:");
        this.echo("  Ctrl+R - Reverse search history");
        this.echo("  Tab - Word completion");
        this.echo("  Up/Down - Navigate history");
        this.echo("  Ctrl+L - Clear screen");
        this.echo("  Ctrl+C - Disconnect (or exit if disconnected)");
        this.echo("");
        this.echo("Movement (Shift+key, roguelike layout):");
        this.echo("  H/L/K/J - West/East/North/South");
        this.echo("  Y/U/B/N - NW/NE/SW/SE");
        this.echo("  </> - Up/Down, ; = look");
      } else if (command === "config") {
        this.echo("Settings:");
        const settings = this.settings.getAll();
        for (const [key, value] of Object.entries(settings)) {
          const settingKey = key as keyof typeof settings;
          const description = this.settings.getDescription(settingKey);
          const validValues = this.settings.getValidValues(settingKey);
          this.echo(`  ${key} = ${value}`);
          this.echo(`    ${description}`);
          this.echo(`    Values: ${validValues.join(", ")}`);
        }
      } else if (command === "debug") {
        this.debugMode = !this.debugMode;
        if (this.debugMode) {
          const logPath = "/tmp/mud-client-debug.log";
          this.debugLogStream = fs.createWriteStream(logPath, { flags: "a" });
          this.debugLogStream.write(`\n=== Debug session started: ${new Date().toISOString()} ===\n`);
          this.client.setDebug(true, this.debugLogStream);
          this.echo(`Debug mode ON - logging to ${logPath}`);
        } else {
          this.client.setDebug(false);
          if (this.debugLogStream) {
            this.debugLogStream.write(`=== Debug session ended: ${new Date().toISOString()} ===\n`);
            this.debugLogStream.end();
            this.debugLogStream = null;
          }
          this.echo("Debug mode OFF");
        }
      } else if (command === "set") {
        const key = parts[1];
        const value = parts[2];
        if (!key) {
          this.echo(`Usage: /set <key> [value]`);
          this.echo(`Use /config to see available settings.`);
        } else if (!this.settings.isValidKey(key)) {
          this.echo(`Unknown setting: ${key}`);
          this.echo(`Use /config to see available settings.`);
        } else if (!value) {
          const currentValue = this.settings.get(key);
          const validValues = this.settings.getValidValues(key);
          const description = this.settings.getDescription(key);
          this.echo(`${key} = ${currentValue}`);
          this.echo(`  ${description}`);
          this.echo(`  Values: ${validValues.join(", ")}`);
        } else if (this.settings.set(key as keyof import("../settings/Settings").AppSettings, value)) {
          this.echo(`Setting updated: ${key} = ${value}`);
          this.updatePrompt();
          this.redrawInput();
        } else {
          const validValues = this.settings.getValidValues(key);
          this.echo(`Invalid value: ${value}`);
          this.echo(`Valid values: ${validValues.join(", ")}`);
        }
      } else {
        this.echo(`Unknown command: ${command}`);
      }
      return;
    }

    // Expand aliases
    const expanded = this.charManager.expandAlias(trimmed);

    // Send to MUD
    if (this.connected) {
      this.client.send(expanded);
    } else {
      this.echo("Not connected. Use /connect <host> [port] or /menu");
    }
  }

  // Helper: echo command to scroll region with > prefix
  private echoCommand(cmd: string): void {
    if (!this.settings.get("echoCommands")) return;
    const termHeight = process.stdout.rows || 24;
    process.stdout.write(SET_SCROLL_REGION(1, termHeight - 2));
    process.stdout.write(SAVE_CURSOR);
    process.stdout.write(CURSOR_TO(termHeight - 2, 1));
    process.stdout.write("\n"); // Scroll first
    process.stdout.write("\x1b[90m> " + cmd + "\x1b[0m"); // Dark grey
    process.stdout.write(RESTORE_CURSOR);
    this.redrawInput();
  }

  // Helper: clear input and deselect
  private clearInput(): void {
    this.input = "";
    this.cursorPos = 0;
    this.inputSelected = false;
  }

  // Helper: send command, echo it, update input state
  private sendAndEcho(cmd: string): void {
    this.echoCommand(cmd);
    this.client.send(cmd);
    if (this.settings.get("inputMode") === "clear") {
      this.clearInput();
    } else {
      this.input = cmd;
      this.cursorPos = cmd.length;
      this.inputSelected = true;
    }
    this.redrawInput();
  }

  private redrawInput(): void {
    if (this.appState !== "client") return;

    const termWidth = process.stdout.columns || 80;
    const termHeight = process.stdout.rows || 24;

    // Draw thin dark grey divider line on line termHeight-1
    process.stdout.write(CURSOR_TO(termHeight - 1, 1));
    process.stdout.write(`\x1b[38;5;238m${"─".repeat(termWidth)}\x1b[0m`);

    // Move to last row and clear it
    process.stdout.write(CURSOR_TO(termHeight, 1) + CLEAR_LINE);

    // Write prompt in dark grey + input (with reverse video if selected)
    process.stdout.write(`\x1b[38;5;238m${this.promptText}\x1b[0m`);
    if (this.inputSelected && this.input) {
      // Reverse video for selected text
      process.stdout.write(`\x1b[7m${this.input}\x1b[27m`);
    } else {
      process.stdout.write(this.input);
    }

    // Write right-aligned status in gray (only if statusPosition is 'right')
    if (this.settings.get("statusPosition") === "right") {
      const statusText = this.getStatusText();
      const statusCol = termWidth - statusText.length;
      process.stdout.write(CURSOR_TO_COL(statusCol));
      process.stdout.write(`\x1b[90m${statusText}\x1b[0m`);
    }

    // Move cursor back to correct position in input
    const cursorCol = this.promptText.length + this.cursorPos + 1;
    process.stdout.write(CURSOR_TO(termHeight, cursorCol));
  }

  private echo(message: string): void {
    if (this.appState !== "client") return;

    const termWidth = process.stdout.columns || 80;
    const termHeight = process.stdout.rows || 24;
    const prefix = "\x1b[36m[Client]\x1b[0m ";
    const prefixLen = 10; // "[Client] " visible length
    const availableWidth = termWidth - prefixLen;

    // Word wrap the message
    const lines = this.wordWrap(message, availableWidth);

    // Ensure scroll region is set, save cursor, move to scroll region bottom
    process.stdout.write(SET_SCROLL_REGION(1, termHeight - 2));
    process.stdout.write(SAVE_CURSOR);
    process.stdout.write(CURSOR_TO(termHeight - 2, 1));

    // Print first line with prefix, continuation lines with indent
    for (let i = 0; i < lines.length; i++) {
      if (i === 0) {
        process.stdout.write(prefix + lines[i] + "\n");
      } else {
        process.stdout.write(" ".repeat(prefixLen) + lines[i] + "\n");
      }
    }

    process.stdout.write(RESTORE_CURSOR);
    this.redrawInput();
  }

  private wordWrap(text: string, maxWidth: number): string[] {
    // Preserve leading indentation
    const leadingSpaces = text.match(/^(\s*)/)?.[1] || "";
    const indent = leadingSpaces.length;
    const content = text.slice(indent);

    if (text.length <= maxWidth) {
      return [text];
    }

    const lines: string[] = [];
    const words = content.split(" ");
    let currentLine = leadingSpaces;
    const continuationIndent = " ".repeat(indent);

    for (const word of words) {
      if (currentLine.length === indent) {
        // First word on line
        currentLine += word;
      } else if (currentLine.length + 1 + word.length <= maxWidth) {
        currentLine += " " + word;
      } else {
        lines.push(currentLine);
        currentLine = continuationIndent + word;
      }
    }

    if (currentLine.length > 0) {
      lines.push(currentLine);
    }

    return lines.length > 0 ? lines : [text];
  }

  private extractWords(text: string): void {
    const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
    const words = stripped.match(/\b[a-zA-Z][a-zA-Z0-9_'-]*\b/g);
    if (words) {
      for (const word of words) {
        if (word.length >= 2) {
          this.wordBuffer.add(word.toLowerCase());
          if (this.wordBuffer.size > 5000) {
            const first = this.wordBuffer.values().next().value;
            if (first) this.wordBuffer.delete(first);
          }
        }
      }
    }
  }

  private getCompletionWords(): string[] {
    const input = this.input.trimStart();

    // Command completion (e.g., /s -> /set, /con -> /connect)
    if (input.startsWith("/") && !input.includes(" ")) {
      return [
        "/connect",
        "/disconnect",
        "/reconnect",
        "/menu",
        "/alias",
        "/unalias",
        "/aliases",
        "/config",
        "/set",
        "/clear",
        "/debug",
        "/exit",
        "/help",
      ];
    }

    // /set command completion
    if (input.startsWith("/set ")) {
      const afterSet = input.slice(5);
      const parts = afterSet.split(/\s+/).filter(Boolean);
      const endsWithSpace = afterSet.endsWith(" ") || afterSet === "";

      if (parts.length === 0 || (parts.length === 1 && !endsWithSpace)) {
        // Completing setting key (e.g., "/set " or "/set stat")
        return this.settings.getKeys();
      } else if (parts.length >= 1 && this.settings.isValidKey(parts[0])) {
        // Completing setting value (e.g., "/set statusPosition " or "/set statusPosition pro")
        return [...this.settings.getValidValues(parts[0])];
      }
    }

    // Default: use word buffer
    return Array.from(this.wordBuffer);
  }

  private cleanup(): void {
    // Reset scroll region before exiting
    this.resetScrollRegion();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    this.client.disconnect();
    this.charManager.save();
    process.stdout.write("\r\n");
  }
}

// Parse args
const args = process.argv.slice(2);
let host: string | undefined;
let port: number | undefined;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (!arg.startsWith("-") && !host) {
    const parts = arg.split(":");
    host = parts[0];
    port = parts[1] ? parseInt(parts[1], 10) : undefined;
  }
}

// Start
const client = new MudClient();
client.start(host, port);
