import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export type AliasMap = Record<string, string>;

export class AliasStore {
  private aliases: AliasMap;
  private configPath: string;

  constructor() {
    const baseDir = join(homedir(), ".config", "mud-client");
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
    }
    this.configPath = join(baseDir, "aliases.json");
    this.aliases = this.load();
  }

  private load(): AliasMap {
    if (!existsSync(this.configPath)) {
      return {};
    }

    try {
      const content = readFileSync(this.configPath, "utf-8");
      return JSON.parse(content) as AliasMap;
    } catch {
      return {};
    }
  }

  private save(): void {
    writeFileSync(this.configPath, JSON.stringify(this.aliases, null, 2));
  }

  set(name: string, expansion: string): void {
    this.aliases[name] = expansion;
    this.save();
  }

  remove(name: string): boolean {
    if (!(name in this.aliases)) {
      return false;
    }
    delete this.aliases[name];
    this.save();
    return true;
  }

  get(name: string): string | undefined {
    return this.aliases[name];
  }

  getAll(): AliasMap {
    return { ...this.aliases };
  }

  has(name: string): boolean {
    return name in this.aliases;
  }
}
