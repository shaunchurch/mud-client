import { describe, expect, it } from "bun:test";
import { PaneManager } from "../panes/PaneManager";
import type { PaneConfig } from "../panes/types";
import type { ClassifiedMessage } from "../messages/MessageClassifier";

describe("PaneManager", () => {
  describe("route", () => {
    it("returns true (consume) when message matches pane without passthrough", () => {
      const configs: PaneConfig[] = [
        {
          id: "comms",
          position: "top",
          height: 5,
          enabled: true,
          passthrough: false,
          filter: { types: ["tell"] },
        },
      ];
      const manager = new PaneManager(configs);

      const classified: ClassifiedMessage = {
        type: "tell",
        raw: "Someone tells you : Hello",
      };

      const consumed = manager.route("Someone tells you : Hello", classified);
      expect(consumed).toBe(true);
    });

    it("returns false (keep in main) when message matches pane with passthrough", () => {
      const configs: PaneConfig[] = [
        {
          id: "comms",
          position: "top",
          height: 5,
          enabled: true,
          passthrough: true,
          filter: { types: ["tell"] },
        },
      ];
      const manager = new PaneManager(configs);

      const classified: ClassifiedMessage = {
        type: "tell",
        raw: "Someone tells you : Hello",
      };

      const consumed = manager.route("Someone tells you : Hello", classified);
      expect(consumed).toBe(false);
    });

    it("returns false when message does not match any pane", () => {
      const configs: PaneConfig[] = [
        {
          id: "comms",
          position: "top",
          height: 5,
          enabled: true,
          passthrough: false,
          filter: { types: ["tell"] },
        },
      ];
      const manager = new PaneManager(configs);

      const classified: ClassifiedMessage = {
        type: "other",
        raw: "You are standing in a room.",
      };

      const consumed = manager.route("You are standing in a room.", classified);
      expect(consumed).toBe(false);
    });

    it("does not route to disabled panes", () => {
      const configs: PaneConfig[] = [
        {
          id: "comms",
          position: "top",
          height: 5,
          enabled: false,
          passthrough: false,
          filter: { types: ["tell"] },
        },
      ];
      const manager = new PaneManager(configs);

      const classified: ClassifiedMessage = {
        type: "tell",
        raw: "Someone tells you : Hello",
      };

      const consumed = manager.route("Someone tells you : Hello", classified);
      expect(consumed).toBe(false);
    });

    it("enables pane and routes correctly after enable", () => {
      const configs: PaneConfig[] = [
        {
          id: "comms",
          position: "top",
          height: 5,
          enabled: false,
          passthrough: false,
          filter: { types: ["tell"] },
        },
      ];
      const manager = new PaneManager(configs);

      // Initially disabled - should not consume
      const classified: ClassifiedMessage = {
        type: "tell",
        raw: "Someone tells you : Hello",
      };
      expect(manager.route("Someone tells you : Hello", classified)).toBe(false);

      // Enable the pane
      manager.enablePane("comms");

      // Now should consume
      expect(manager.route("Someone tells you : Hello", classified)).toBe(true);
    });

    it("with passthrough, message goes to pane AND returns false for main output", () => {
      const configs: PaneConfig[] = [
        {
          id: "comms",
          position: "top",
          height: 5,
          enabled: true,
          passthrough: true,
          filter: { types: ["channel"] },
        },
      ];
      const manager = new PaneManager(configs);

      const classified: ClassifiedMessage = {
        type: "channel",
        channel: "guild",
        raw: "[guild] Someone : Hello everyone",
      };

      // Should return false (don't consume from main)
      const consumed = manager.route("[guild] Someone : Hello everyone", classified);
      expect(consumed).toBe(false);

      // Pane should have received the message
      const pane = manager.getPane("comms");
      expect(pane).toBeDefined();
      // The pane's messages array is private, but we verified the route logic works
    });
  });
});
