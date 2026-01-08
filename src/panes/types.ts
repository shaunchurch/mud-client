/**
 * Type definitions for pane configuration (panes.yaml)
 */

// Classifier pattern configurations
export interface TellPatternConfig {
  pattern: string;
  sender: number;
  outgoing: boolean;
}

export interface SayPatternConfig {
  pattern: string;
  sender: number;
  outgoing: boolean;
}

export interface ChannelPatternConfig {
  pattern: string;
  channel: number;
  content: number;
}

export interface ChannelContentPatternConfig {
  pattern: string;
  sender: number;
}

export interface ClassifiersConfig {
  tell: TellPatternConfig[];
  say: SayPatternConfig[];
  channel: ChannelPatternConfig[];
  channelContent: ChannelContentPatternConfig[];
  continuation?: string; // Pattern for continuation lines (e.g., "^\\s+" for indented lines)
}

// Pane filter configuration
export interface PaneFilter {
  types?: string[];
  channels?: string[];
  excludeChannels?: string[];
  pattern?: string;
}

// Pane configuration
export interface PaneConfig {
  id: string;
  enabled?: boolean; // Defaults to true
  position: "top";
  height: number;
  filter: PaneFilter;
  maxMessages?: number;
  passthrough?: boolean; // If true, message also appears in main output
}

// Root YAML config
export interface PanesConfig {
  classifiers: ClassifiersConfig;
  panes: PaneConfig[];
}
