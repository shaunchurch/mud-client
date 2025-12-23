import { EventEmitter } from "events";
import type { CharacterConfig } from "./Character";
import type { ConnectionConfig } from "./Connection";
import { CharacterStore } from "./CharacterStore";
import type { CommandHistory } from "../input/CommandHistory";

export class CharacterManager extends EventEmitter {
  private store: CharacterStore;
  private currentConnection: ConnectionConfig | null = null;
  private currentCharacter: CharacterConfig | null = null;
  private history: CommandHistory;

  constructor(history: CommandHistory) {
    super();
    this.store = new CharacterStore();
    this.history = history;
  }

  // === Connection Methods ===

  getCurrentConnection(): ConnectionConfig | null {
    return this.currentConnection;
  }

  listConnections(): ConnectionConfig[] {
    return this.store.listConnections();
  }

  createConnection(name: string, host: string, port: number): ConnectionConfig {
    const conn = this.store.createConnection(name, host, port);
    this.emit("connectionCreated", conn);
    return conn;
  }

  selectConnection(id: string): boolean {
    const conn = this.store.loadConnection(id);
    if (!conn) {
      return false;
    }

    this.currentConnection = conn;
    this.store.updateConnectionLastUsed(id);
    this.emit("connectionSelected", conn);
    return true;
  }

  deleteConnection(id: string): boolean {
    // If deleting the current connection, clear it and character
    if (this.currentConnection?.id === id) {
      if (this.currentCharacter) {
        this.history.close();
        this.currentCharacter = null;
      }
      this.currentConnection = null;
    }

    const result = this.store.deleteConnection(id);
    if (result) {
      this.emit("connectionDeleted", id);
    }
    return result;
  }

  // === Character Methods ===

  getCurrentCharacter(): CharacterConfig | null {
    return this.currentCharacter;
  }

  listCharacters(connectionId?: string): CharacterConfig[] {
    const connId = connectionId || this.currentConnection?.id;
    if (!connId) {
      return [];
    }
    return this.store.listCharacters(connId);
  }

  createCharacter(name: string, password?: string): CharacterConfig | null {
    if (!this.currentConnection) {
      return null;
    }

    const char = this.store.createCharacter(this.currentConnection.id, name, password);
    this.emit("characterCreated", char);
    return char;
  }

  selectCharacter(characterId: string): boolean {
    if (!this.currentConnection) {
      return false;
    }

    const char = this.store.loadCharacter(this.currentConnection.id, characterId);
    if (!char) {
      return false;
    }

    // Close previous history
    if (this.currentCharacter) {
      this.history.close();
    }

    this.currentCharacter = char;
    this.store.updateCharacterLastUsed(this.currentConnection.id, characterId);

    // Initialize history for this character
    const historyPath = this.store.getHistoryDbPath(this.currentConnection.id, characterId);
    this.history.initFromPath(historyPath);

    this.emit("characterSelected", char);
    return true;
  }

  deleteCharacter(characterId: string): boolean {
    if (!this.currentConnection) {
      return false;
    }

    // If deleting the current character, clear it
    if (this.currentCharacter?.id === characterId) {
      this.history.close();
      this.currentCharacter = null;
    }

    const result = this.store.deleteCharacter(this.currentConnection.id, characterId);
    if (result) {
      this.emit("characterDeleted", characterId);
    }
    return result;
  }

  // === Alias Methods ===

  setAlias(name: string, expansion: string): boolean {
    if (!this.currentConnection || !this.currentCharacter) {
      return false;
    }

    this.store.setAlias(this.currentConnection.id, this.currentCharacter.id, name, expansion);
    this.currentCharacter.aliases[name] = expansion;
    this.emit("aliasSet", name, expansion);
    return true;
  }

  removeAlias(name: string): boolean {
    if (!this.currentConnection || !this.currentCharacter) {
      return false;
    }

    this.store.removeAlias(this.currentConnection.id, this.currentCharacter.id, name);
    delete this.currentCharacter.aliases[name];
    this.emit("aliasRemoved", name);
    return true;
  }

  getAliases(): Record<string, string> {
    return this.currentCharacter?.aliases || {};
  }

  expandAlias(input: string): string {
    if (!this.currentCharacter) {
      return input;
    }

    const parts = input.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    const expansion = this.currentCharacter.aliases[cmd];
    if (!expansion) {
      return input;
    }

    // Replace $1, $2, etc. with arguments
    let result = expansion;
    for (let i = 0; i < args.length; i++) {
      result = result.replace(new RegExp(`\\$${i + 1}`, "g"), args[i]);
    }

    // Replace $* with all remaining arguments
    const hadPlaceholders = /\$\d+|\$\*/.test(expansion);
    result = result.replace(/\$\*/g, args.join(" "));

    // Remove unused placeholders
    result = result.replace(/\$\d+/g, "");

    // If no placeholders were in the original expansion, append all arguments
    if (!hadPlaceholders && args.length > 0) {
      result = result + " " + args.join(" ");
    }

    return result.trim();
  }

  save(): void {
    if (this.currentCharacter) {
      this.store.saveCharacter(this.currentCharacter);
    }
  }
}
