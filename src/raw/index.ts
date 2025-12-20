import { TelnetClient } from "../connection/TelnetClient";
import { CommandHistory } from "../input/CommandHistory";
import { TabCompletion } from "../input/TabCompletion";
import { CharacterManager } from "../character/CharacterManager";
import type { ConnectionConfig } from "../character/Connection";
import type { CharacterConfig } from "../character/Character";
import { Menu, type MenuItem } from "./Menu";
import { TextPrompt } from "./TextPrompt";

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
  private menu: Menu;
  private prompt: TextPrompt;

  private input = "";
  private cursorPos = 0;
  private wordBuffer: Set<string> = new Set();
  private connected = false;
  private promptText = "> ";
  private appState: AppState = "menu";

  // Output buffering to avoid display corruption
  private outputBuffer = "";
  private outputTimer: ReturnType<typeof setTimeout> | null = null;

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

  // Last session for reconnect
  private lastConnection: ConnectionConfig | null = null;
  private lastCharacter: CharacterConfig | null = null;

  constructor() {
    this.client = new TelnetClient();
    this.history = new CommandHistory();
    this.tabCompletion = new TabCompletion();
    this.charManager = new CharacterManager(this.history);
    this.menu = new Menu();
    this.prompt = new TextPrompt();

    this.setupTelnet();
    this.setupInput();
  }

  async start(autoHost?: string, autoPort?: number): Promise<void> {
    if (autoHost) {
      // Auto-connect mode: skip menu
      this.appState = "client";
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
    // Set scroll region to all but the last line
    process.stdout.write(SET_SCROLL_REGION(1, termHeight - 1));
    // Move cursor to top of scroll region
    process.stdout.write(CURSOR_HOME);
  }

  private resetScrollRegion(): void {
    process.stdout.write(RESET_SCROLL_REGION);
  }

  private updatePrompt(): void {
    // Simple prompt - status shown on right side
    this.promptText = "> ";
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
    process.stdout.write("\x1b[33m(disconnected) Press Enter to continue...\x1b[0m");
  }

  private flushOutput(): void {
    if (!this.outputBuffer) return;

    const termHeight = process.stdout.rows || 24;

    // Save cursor, move to scroll region, output, restore cursor
    process.stdout.write(SAVE_CURSOR);

    // Move to bottom of scroll region (row termHeight-1)
    // The scroll region will auto-scroll when we write
    process.stdout.write(CURSOR_TO(termHeight - 1, 1));

    // Write output - let terminal handle scrolling within the region
    process.stdout.write(this.outputBuffer);

    // Ensure we end on a new line
    if (!this.outputBuffer.endsWith("\n") && !this.outputBuffer.endsWith("\r")) {
      process.stdout.write("\r\n");
    }

    // Clear buffer
    this.outputBuffer = "";
    this.outputTimer = null;

    // Restore cursor and redraw input on the last line
    process.stdout.write(RESTORE_CURSOR);
    this.redrawInput();
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
        this.showDisconnectPrompt();
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

    // Ctrl+U - clear line
    if (key === "\x15") {
      this.input = "";
      this.cursorPos = 0;
      this.redrawInput();
      return;
    }

    // Ctrl+W - delete word
    if (key === "\x17") {
      const beforeCursor = this.input.slice(0, this.cursorPos);
      const afterCursor = this.input.slice(this.cursorPos);
      const trimmed = beforeCursor.trimEnd();
      const lastSpace = trimmed.lastIndexOf(" ");
      this.input = (lastSpace === -1 ? "" : trimmed.slice(0, lastSpace + 1)) + afterCursor;
      this.cursorPos = lastSpace === -1 ? 0 : lastSpace + 1;
      this.redrawInput();
      return;
    }

    // Enter
    if (key === "\r" || key === "\n") {
      process.stdout.write("\r\n");
      this.handleCommand(this.input);
      this.input = "";
      this.cursorPos = 0;
      this.redrawInput();
      return;
    }

    // Backspace
    if (key === "\x7f" || key === "\b") {
      if (this.cursorPos > 0) {
        this.input = this.input.slice(0, this.cursorPos - 1) + this.input.slice(this.cursorPos);
        this.cursorPos--;
        this.redrawInput();
      }
      return;
    }

    // Tab - completion
    if (key === "\t") {
      const words = Array.from(this.wordBuffer);
      const completed = this.tabCompletion.complete(this.input, words);
      if (completed !== this.input) {
        this.input = completed;
        this.cursorPos = this.input.length;
        this.redrawInput();
      }
      return;
    }

    // Escape sequences (arrows, etc.)
    if (key.startsWith("\x1b[") || key.startsWith("\x1bO")) {
      const seq = key.slice(2);

      // Up arrow - history previous
      if (seq === "A") {
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
        const next = this.history.next();
        this.input = next || "";
        this.cursorPos = this.input.length;
        this.redrawInput();
        return;
      }

      // Left arrow
      if (seq === "D") {
        if (this.cursorPos > 0) {
          this.cursorPos--;
          this.redrawInput();
        }
        return;
      }

      // Right arrow
      if (seq === "C") {
        if (this.cursorPos < this.input.length) {
          this.cursorPos++;
          this.redrawInput();
        }
        return;
      }

      // Home
      if (seq === "H" || seq === "1~") {
        this.cursorPos = 0;
        this.redrawInput();
        return;
      }

      // End
      if (seq === "F" || seq === "4~") {
        this.cursorPos = this.input.length;
        this.redrawInput();
        return;
      }

      // Delete
      if (seq === "3~") {
        if (this.cursorPos < this.input.length) {
          this.input = this.input.slice(0, this.cursorPos) + this.input.slice(this.cursorPos + 1);
          this.redrawInput();
        }
        return;
      }

      return;
    }

    // Regular printable character
    if (code >= 32 && code < 127) {
      this.input = this.input.slice(0, this.cursorPos) + key + this.input.slice(this.cursorPos);
      this.cursorPos++;
      this.redrawInput();
    }
  }

  private enterReverseSearch(): void {
    this.inReverseSearch = true;
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
    if (!trimmed) return;

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
        this.echo("  /clear - Clear screen");
        this.echo("  /exit - Exit client");
        this.echo("");
        this.echo("Keyboard shortcuts:");
        this.echo("  Ctrl+R - Reverse search history");
        this.echo("  Tab - Word completion");
        this.echo("  Up/Down - Navigate history");
        this.echo("  Ctrl+L - Clear screen");
        this.echo("  Ctrl+C - Disconnect (or exit if disconnected)");
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

  private redrawInput(): void {
    if (this.appState !== "client") return;

    const termWidth = process.stdout.columns || 80;
    const termHeight = process.stdout.rows || 24;
    const statusText = this.getStatusText();
    const statusCol = termWidth - statusText.length;

    // Move to last row and clear it
    process.stdout.write(CURSOR_TO(termHeight, 1) + CLEAR_LINE);

    // Write prompt + input
    const inputLine = this.promptText + this.input;
    process.stdout.write(inputLine);

    // Write right-aligned status in gray
    process.stdout.write(CURSOR_TO_COL(statusCol));
    process.stdout.write(`\x1b[90m${statusText}\x1b[0m`);

    // Move cursor back to correct position in input
    const cursorCol = this.promptText.length + this.cursorPos + 1;
    process.stdout.write(CURSOR_TO(termHeight, cursorCol));
  }

  private echo(message: string): void {
    if (this.appState !== "client") return;

    const termHeight = process.stdout.rows || 24;

    // Save cursor, move to scroll region, print message
    process.stdout.write(SAVE_CURSOR);
    process.stdout.write(CURSOR_TO(termHeight - 1, 1));
    process.stdout.write("\x1b[36m[Client]\x1b[0m " + message + "\r\n");
    process.stdout.write(RESTORE_CURSOR);
    this.redrawInput();
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
