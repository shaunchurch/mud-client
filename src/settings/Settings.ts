import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export type StatusPosition = "prompt" | "right" | "hidden";
export type TimestampMode = "hidden" | "time" | "datetime";
export type InputMode = "select" | "clear";

export interface AppSettings {
  statusPosition: StatusPosition;
  echoCommands: boolean;
  timestamps: TimestampMode;
  autoReconnect: boolean;
  movementKeys: boolean;
  inputMode: InputMode;
  wordWrap: boolean;
  commPanel: boolean;
  commPanelHeight: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  statusPosition: "right",
  echoCommands: true,
  timestamps: "hidden",
  autoReconnect: false,
  movementKeys: true,
  inputMode: "select",
  wordWrap: false,
  commPanel: true,
  commPanelHeight: 5,
};

const VALID_VALUES: Record<keyof AppSettings, readonly string[]> = {
  statusPosition: ["prompt", "right", "hidden"] as const,
  echoCommands: ["true", "false"] as const,
  timestamps: ["hidden", "time", "datetime"] as const,
  autoReconnect: ["true", "false"] as const,
  movementKeys: ["true", "false"] as const,
  inputMode: ["select", "clear"] as const,
  wordWrap: ["true", "false"] as const,
  commPanel: ["true", "false"] as const,
  commPanelHeight: ["3", "5", "7", "10", "15"] as const,
};

const DESCRIPTIONS: Record<keyof AppSettings, string> = {
  statusPosition: "Where to show username@host (prompt=inline, right=right-aligned, hidden=off)",
  echoCommands: "Show sent commands in the output area",
  timestamps: "Add timestamps to messages (hidden, time, or datetime)",
  autoReconnect: "Automatically reconnect after disconnection",
  movementKeys: "Enable Shift+HJKL roguelike movement shortcuts",
  inputMode: "After sending: select (highlight text) or clear (empty input)",
  wordWrap: "Wrap long lines from the MUD to fit terminal width",
  commPanel: "Show communications panel for tells/says/channels",
  commPanelHeight: "Number of lines for communications panel",
};

export class SettingsManager {
  private settings: AppSettings;
  private configPath: string;

  constructor() {
    const baseDir = join(homedir(), ".config", "mud-client");
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
    }
    this.configPath = join(baseDir, "settings.json");
    this.settings = this.load();
  }

  private load(): AppSettings {
    if (!existsSync(this.configPath)) {
      return { ...DEFAULT_SETTINGS };
    }

    try {
      const content = readFileSync(this.configPath, "utf-8");
      const parsed = JSON.parse(content);
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private save(): void {
    writeFileSync(this.configPath, JSON.stringify(this.settings, null, 2));
  }

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.settings[key];
  }

  set<K extends keyof AppSettings>(key: K, value: string): boolean {
    const validValues = VALID_VALUES[key];
    if (!validValues.includes(value)) {
      return false;
    }
    // Convert string to appropriate type
    const currentValue = this.settings[key];
    if (typeof currentValue === "boolean") {
      (this.settings[key] as boolean) = value === "true";
    } else if (typeof currentValue === "number") {
      (this.settings[key] as number) = parseInt(value, 10);
    } else {
      (this.settings[key] as string) = value;
    }
    this.save();
    return true;
  }

  getAll(): AppSettings {
    return { ...this.settings };
  }

  getValidValues<K extends keyof AppSettings>(key: K): readonly string[] {
    return VALID_VALUES[key];
  }

  isValidKey(key: string): key is keyof AppSettings {
    return key in DEFAULT_SETTINGS;
  }

  getKeys(): string[] {
    return Object.keys(DEFAULT_SETTINGS);
  }

  getDescription<K extends keyof AppSettings>(key: K): string {
    return DESCRIPTIONS[key];
  }
}
