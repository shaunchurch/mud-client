/**
 * Tab completion with cycling support.
 * Cycles through matches and back to the original input.
 */
export class TabCompletion {
  private originalInput = "";
  private lastInput = "";
  private lastMatches: string[] = [];
  private matchIndex = -1; // -1 means showing original

  /**
   * Complete the last word in the input using available words.
   * Repeatedly calling with the same completed input cycles through matches,
   * then back to the original input.
   */
  complete(input: string, words: string[]): string {
    const trimmed = input.trimEnd();
    const lastSpaceIndex = trimmed.lastIndexOf(" ");
    const prefix = lastSpaceIndex >= 0 ? trimmed.slice(0, lastSpaceIndex + 1) : "";
    const partial = lastSpaceIndex >= 0 ? trimmed.slice(lastSpaceIndex + 1) : trimmed;

    if (!partial) {
      return input;
    }

    // Check if we're cycling through matches
    if (input === this.lastInput && this.lastMatches.length > 0) {
      this.matchIndex++;
      if (this.matchIndex >= this.lastMatches.length) {
        // Cycle back to original
        this.matchIndex = -1;
        this.lastInput = this.originalInput;
        return this.originalInput;
      }
      const match = this.lastMatches[this.matchIndex];
      this.lastInput = prefix + match;
      return this.lastInput;
    }

    // Find new matches
    const lowerPartial = partial.toLowerCase();
    const matches = words
      .filter((word) => word.toLowerCase().startsWith(lowerPartial) && word.toLowerCase() !== lowerPartial)
      .sort((a, b) => {
        if (a.length !== b.length) return a.length - b.length;
        return a.localeCompare(b);
      });

    if (matches.length === 0) {
      return input;
    }

    // Store original and start with first match
    this.originalInput = input;
    this.lastMatches = matches;
    this.matchIndex = 0;
    this.lastInput = prefix + matches[0];

    return this.lastInput;
  }

  /**
   * Cycle through a fixed list of options.
   * Returns the next option, cycling back to original after exhausting all options.
   *
   * @param prefix - The fixed prefix before the cycling part (e.g., "/set ")
   * @param options - Available options to cycle through
   * @param current - Current value being completed/cycled
   * @param fullInput - The complete current input string
   */
  cycle(prefix: string, options: string[], current: string, fullInput: string): string {
    // Check if we're continuing a cycle
    if (fullInput === this.lastInput && this.lastMatches.length > 0) {
      this.matchIndex++;
      if (this.matchIndex >= this.lastMatches.length) {
        // Cycle back to original
        this.matchIndex = -1;
        this.lastInput = this.originalInput;
        return this.originalInput;
      }
      const match = this.lastMatches[this.matchIndex];
      this.lastInput = prefix + match;
      return this.lastInput;
    }

    // Find matching options
    const lowerCurrent = current.toLowerCase();
    let matches: string[];
    let startIndex: number;

    if (current === "") {
      // No current value - show all options
      matches = [...options];
      startIndex = 0;
    } else {
      const exactIndex = options.findIndex((o) => o.toLowerCase() === lowerCurrent);
      if (exactIndex >= 0) {
        // Exact match - start cycling from next option
        matches = [...options];
        startIndex = (exactIndex + 1) % options.length;
      } else {
        // Partial match - filter to matching options
        matches = options.filter((o) => o.toLowerCase().startsWith(lowerCurrent));
        startIndex = 0;
      }
    }

    if (matches.length === 0) {
      return fullInput;
    }

    // Reorder matches to start from startIndex
    if (startIndex > 0 && matches.length === options.length) {
      matches = [...matches.slice(startIndex), ...matches.slice(0, startIndex)];
    }

    // Store original and return first match
    this.originalInput = fullInput;
    this.lastMatches = matches;
    this.matchIndex = 0;
    this.lastInput = prefix + matches[0];

    return this.lastInput;
  }

  /**
   * Reset completion state (call when input changes outside of tab completion)
   */
  reset(): void {
    this.originalInput = "";
    this.lastInput = "";
    this.lastMatches = [];
    this.matchIndex = -1;
  }

  /**
   * Check if currently in a completion cycle
   */
  isActive(): boolean {
    return this.lastMatches.length > 0;
  }
}
