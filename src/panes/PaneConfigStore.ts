import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parse, stringify } from "yaml";
import type {
  PanesConfig,
  ClassifiersConfig,
  PaneConfig,
} from "./types";

// Empty defaults - user must create panes.yaml to enable panes
const DEFAULT_CLASSIFIERS: ClassifiersConfig = {
  tell: [],
  say: [],
  channel: [],
  channelContent: [],
};

const DEFAULT_PANES: PaneConfig[] = [];

export class PaneConfigStore {
  private config: PanesConfig;
  private configPath: string;

  constructor() {
    const baseDir = join(homedir(), ".config", "mud-client");
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
    }
    this.configPath = join(baseDir, "panes.yaml");
    this.config = this.load();
  }

  private load(): PanesConfig {
    if (!existsSync(this.configPath)) {
      return this.getDefaults();
    }

    try {
      const content = readFileSync(this.configPath, "utf-8");
      const parsed = parse(content) as Partial<PanesConfig>;
      return this.mergeWithDefaults(parsed);
    } catch (err) {
      console.error("Error loading panes.yaml, using defaults:", err);
      return this.getDefaults();
    }
  }

  private getDefaults(): PanesConfig {
    return {
      classifiers: DEFAULT_CLASSIFIERS,
      panes: DEFAULT_PANES,
    };
  }

  private mergeWithDefaults(parsed: Partial<PanesConfig>): PanesConfig {
    return {
      classifiers: parsed.classifiers || DEFAULT_CLASSIFIERS,
      panes: parsed.panes || DEFAULT_PANES,
    };
  }

  validateConfig(): void {
    for (const type of ["tell", "say"] as const) {
      for (const p of this.config.classifiers[type]) {
        new RegExp(p.pattern);
      }
    }
    for (const p of this.config.classifiers.channel) {
      new RegExp(p.pattern);
    }
    for (const p of this.config.classifiers.channelContent) {
      new RegExp(p.pattern);
    }
  }

  getClassifiers(): ClassifiersConfig {
    return this.config.classifiers;
  }

  getPanes(): PaneConfig[] {
    return this.config.panes;
  }

  getTotalPaneHeight(): number {
    return this.config.panes
      .filter((p) => p.position === "top")
      .reduce((sum, p) => sum + p.height, 0);
  }

  writeDefaultConfig(): void {
    const content = stringify(this.getDefaults());
    writeFileSync(this.configPath, content);
  }

  setPaneEnabled(id: string, enabled: boolean): boolean {
    const pane = this.config.panes.find((p) => p.id === id);
    if (!pane) return false;

    pane.enabled = enabled;
    this.save();
    return true;
  }

  setPaneHeight(id: string, height: number): boolean {
    const pane = this.config.panes.find((p) => p.id === id);
    if (!pane) return false;

    pane.height = height;
    this.save();
    return true;
  }

  setPanePassthrough(id: string, passthrough: boolean): boolean {
    const pane = this.config.panes.find((p) => p.id === id);
    if (!pane) return false;

    pane.passthrough = passthrough;
    this.save();
    return true;
  }

  setPaneMaxMessages(id: string, maxMessages: number): boolean {
    const pane = this.config.panes.find((p) => p.id === id);
    if (!pane) return false;

    pane.maxMessages = maxMessages;
    this.save();
    return true;
  }

  private save(): void {
    const content = stringify(this.config);
    writeFileSync(this.configPath, content);
  }
}
