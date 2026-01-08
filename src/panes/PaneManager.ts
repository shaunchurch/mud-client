/**
 * PaneManager - Manages multiple stacking panes and message routing
 */

import type { PaneConfig } from "./types";
import type { ClassifiedMessage } from "../messages/MessageClassifier";
import { Pane } from "./Pane";

export class PaneManager {
  private panes: Pane[] = [];

  constructor(configs: PaneConfig[]) {
    for (const config of configs) {
      if (config.position === "top") {
        this.panes.push(new Pane(config));
      }
    }
  }

  private getEnabledPanes(): Pane[] {
    return this.panes.filter((p) => p.enabled);
  }

  getTotalHeight(): number {
    return this.getEnabledPanes().reduce((sum, pane) => sum + pane.getHeight(), 0);
  }

  getPaneCount(): number {
    return this.getEnabledPanes().length;
  }

  getPaneIds(): string[] {
    return this.panes.map((p) => p.id);
  }

  getPaneStatus(): Array<{ id: string; enabled: boolean }> {
    return this.panes.map((p) => ({ id: p.id, enabled: p.enabled }));
  }

  enablePane(id: string): boolean {
    const pane = this.panes.find((p) => p.id === id);
    if (pane) {
      pane.setEnabled(true);
      return true;
    }
    return false;
  }

  disablePane(id: string): boolean {
    const pane = this.panes.find((p) => p.id === id);
    if (pane) {
      pane.setEnabled(false);
      return true;
    }
    return false;
  }

  layoutPanes(startRow: number = 1): void {
    let currentRow = startRow;
    for (const pane of this.getEnabledPanes()) {
      pane.setPosition(currentRow, pane.getHeight());
      currentRow += pane.getHeight();
    }
  }

  route(text: string, classified: ClassifiedMessage): boolean {
    let matched = false;
    let anyPassthrough = false;

    for (const pane of this.getEnabledPanes()) {
      if (pane.accepts(classified)) {
        pane.addMessage(text, classified);
        matched = true;
        if (pane.passthrough) {
          anyPassthrough = true;
        }
      }
    }

    // Consume (remove from main) only if matched and no pane wants passthrough
    return matched && !anyPassthrough;
  }

  renderAll(): void {
    for (const pane of this.getEnabledPanes()) {
      pane.render();
    }
  }

  clearAll(): void {
    for (const pane of this.getEnabledPanes()) {
      pane.clear();
    }
  }

  getPane(id: string): Pane | undefined {
    return this.panes.find((p) => p.id === id);
  }
}
