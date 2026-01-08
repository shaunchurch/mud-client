import { describe, test, expect } from "bun:test";
import { MessageClassifier, ClassifiedMessage } from "../messages/MessageClassifier";

describe("MessageClassifier", () => {
  const classifier = new MessageClassifier();

  describe("tells", () => {
    test("incoming tell: 'Xal tells you : hey hey, what's up'", () => {
      const result = classifier.classify("Xal tells you : hey hey, what's up");
      expect(result.type).toBe("tell");
      expect(result.sender).toBe("Xal");
      expect(result.isOutgoing).toBe(false);
      expect(result.raw).toBe("Xal tells you : hey hey, what's up");
    });

    test("outgoing tell: 'You tell Xal: hey hey'", () => {
      const result = classifier.classify("You tell Xal: hey hey");
      expect(result.type).toBe("tell");
      expect(result.sender).toBe("Xal");
      expect(result.isOutgoing).toBe(true);
    });

    test("incoming reply: 'Xal replies: sup?'", () => {
      const result = classifier.classify("Xal replies: sup?");
      expect(result.type).toBe("tell");
      expect(result.sender).toBe("Xal");
      expect(result.isOutgoing).toBe(false);
    });

    test("outgoing reply: 'You reply to Xal: yoyoyo'", () => {
      const result = classifier.classify("You reply to Xal: yoyoyo");
      expect(result.type).toBe("tell");
      expect(result.sender).toBe("Xal");
      expect(result.isOutgoing).toBe(true);
    });
  });

  describe("says", () => {
    test("incoming say: 'Xal says : hi there'", () => {
      const result = classifier.classify("Xal says : hi there");
      expect(result.type).toBe("say");
      expect(result.sender).toBe("Xal");
      expect(result.isOutgoing).toBe(false);
    });

    test("outgoing say: 'You say : hello'", () => {
      const result = classifier.classify("You say : hello");
      expect(result.type).toBe("say");
      expect(result.isOutgoing).toBe(true);
    });

    test("say without space before colon: 'Xal says: hi'", () => {
      const result = classifier.classify("Xal says: hi");
      expect(result.type).toBe("say");
      expect(result.sender).toBe("Xal");
    });
  });

  describe("channels", () => {
    test("channel message: '[chaos] Blizz : hello i'm blizz'", () => {
      const result = classifier.classify("[chaos] Blizz : hello i'm blizz");
      expect(result.type).toBe("channel");
      expect(result.channel).toBe("chaos");
      expect(result.sender).toBe("Blizz");
    });

    test("channel with asterisks: '[*mortal*] Nof : ello I'm nof'", () => {
      const result = classifier.classify("[*mortal*] Nof : ello I'm nof");
      expect(result.type).toBe("channel");
      expect(result.channel).toBe("*mortal*");
      expect(result.sender).toBe("Nof");
    });

    test("channel emote: '[*mortal*] Nof laughs loudly.'", () => {
      const result = classifier.classify("[*mortal*] Nof laughs loudly.");
      expect(result.type).toBe("channel");
      expect(result.channel).toBe("*mortal*");
      expect(result.sender).toBe("Nof");
    });

    test("channel login status: '[chaos] Renowned Warrior Cleric Blizz has logged in.'", () => {
      const result = classifier.classify("[chaos] Renowned Warrior Cleric Blizz has logged in.");
      expect(result.type).toBe("channel");
      expect(result.channel).toBe("chaos");
      expect(result.sender).toBe("Blizz");
    });
  });

  describe("other", () => {
    test("combat output classified as other", () => {
      const result = classifier.classify("You slash the goblin for 15 damage!");
      expect(result.type).toBe("other");
      expect(result.raw).toBe("You slash the goblin for 15 damage!");
    });

    test("room description classified as other", () => {
      const result = classifier.classify("You are standing in a dark forest.");
      expect(result.type).toBe("other");
    });

    test("empty line classified as other", () => {
      const result = classifier.classify("");
      expect(result.type).toBe("other");
      expect(result.raw).toBe("");
    });

    test("random text classified as other", () => {
      const result = classifier.classify("A goblin appears from the shadows.");
      expect(result.type).toBe("other");
    });
  });

  describe("classifyLines", () => {
    test("correctly classifies multiple lines", () => {
      const text = `[chaos] Blizz : hello
You tell Xal: hey
A goblin attacks!`;

      const results = classifier.classifyLines(text);

      expect(results.length).toBe(3);
      expect(results[0].type).toBe("channel");
      expect(results[0].channel).toBe("chaos");
      expect(results[1].type).toBe("tell");
      expect(results[1].isOutgoing).toBe(true);
      expect(results[2].type).toBe("other");
    });

    test("handles empty input", () => {
      const results = classifier.classifyLines("");
      expect(results.length).toBe(1);
      expect(results[0].type).toBe("other");
    });

    test("handles single line", () => {
      const results = classifier.classifyLines("Xal tells you : hi");
      expect(results.length).toBe(1);
      expect(results[0].type).toBe("tell");
    });
  });
});
