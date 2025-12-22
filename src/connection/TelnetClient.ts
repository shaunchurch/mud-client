import { Socket } from "net";
import { EventEmitter } from "events";

// Telnet commands
const IAC = 255; // Interpret As Command
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250; // Subnegotiation Begin
const SE = 240; // Subnegotiation End

// Common telnet options
const OPT_ECHO = 1;
const OPT_SGA = 3; // Suppress Go Ahead
const OPT_TTYPE = 24; // Terminal Type
const OPT_NAWS = 31; // Window Size

export type TelnetState = "disconnected" | "connecting" | "connected";

export interface TelnetClientEvents {
  data: (data: string) => void;
  connect: () => void;
  close: () => void;
  error: (error: Error) => void;
  stateChange: (state: TelnetState) => void;
}

export class TelnetClient extends EventEmitter {
  private socket: Socket | null = null;
  private host = "";
  private port = 23;
  private state: TelnetState = "disconnected";
  private buffer = Buffer.alloc(0);
  private debug = false;

  setDebug(enabled: boolean): void {
    this.debug = enabled;
  }

  private normalizeLineEndings(text: string): string {
    // Only normalize complete CRLF -> LF
    // Don't touch bare CR (may be split CRLF or intentional overwrite)
    return text.replace(/\r\n/g, "\n");
  }

  getState(): TelnetState {
    return this.state;
  }

  getHost(): string {
    return this.host;
  }

  getPort(): number {
    return this.port;
  }

  connect(host: string, port = 23): void {
    if (this.socket) {
      this.disconnect();
    }

    this.host = host;
    this.port = port;
    this.setState("connecting");

    this.socket = new Socket();
    this.socket.setKeepAlive(true);

    this.socket.on("connect", () => {
      this.setState("connected");
      this.emit("connect");
    });

    this.socket.on("data", (data: Buffer) => {
      this.handleData(data);
    });

    this.socket.on("close", () => {
      this.setState("disconnected");
      this.socket = null;
      this.emit("close");
    });

    this.socket.on("error", (error: Error) => {
      this.emit("error", error);
    });

    this.socket.connect(port, host);
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.setState("disconnected");
    }
  }

  send(data: string): void {
    if (this.socket && this.state === "connected") {
      this.socket.write(data + "\r\n");
    }
  }

  sendRaw(data: Buffer): void {
    if (this.socket && this.state === "connected") {
      this.socket.write(data);
    }
  }

  private setState(state: TelnetState): void {
    if (this.state !== state) {
      this.state = state;
      this.emit("stateChange", state);
    }
  }

  private handleData(data: Buffer): void {
    // Debug logging - output raw bytes to stderr
    if (this.debug) {
      const hex = data.toString("hex");
      const readable = data.toString("utf8").replace(/[\x00-\x1f]/g, ".");
      process.stderr.write(`[TELNET RAW] ${hex} | ${readable}\n`);
    }

    // Concatenate with existing buffer
    this.buffer = Buffer.concat([this.buffer, data]);

    let textStart = 0;
    let i = 0;

    while (i < this.buffer.length) {
      if (this.buffer[i] === IAC && i + 1 < this.buffer.length) {
        // Emit any text before this telnet command
        if (i > textStart) {
          const text = this.normalizeLineEndings(
            this.buffer.slice(textStart, i).toString("utf8")
          );
          if (text) {
            this.emit("data", text);
          }
        }

        const cmd = this.buffer[i + 1];

        if (cmd === IAC) {
          // Escaped IAC, emit as literal 255
          this.emit("data", String.fromCharCode(255));
          i += 2;
          textStart = i;
        } else if (cmd === WILL || cmd === WONT || cmd === DO || cmd === DONT) {
          if (i + 2 < this.buffer.length) {
            this.handleNegotiation(cmd, this.buffer[i + 2]);
            i += 3;
            textStart = i;
          } else {
            // Incomplete command, wait for more data
            break;
          }
        } else if (cmd === SB) {
          // Find SE
          let seIndex = -1;
          for (let j = i + 2; j < this.buffer.length - 1; j++) {
            if (this.buffer[j] === IAC && this.buffer[j + 1] === SE) {
              seIndex = j;
              break;
            }
          }

          if (seIndex !== -1) {
            // Handle subnegotiation if needed
            i = seIndex + 2;
            textStart = i;
          } else {
            // Incomplete subnegotiation
            break;
          }
        } else {
          // Other command, skip
          i += 2;
          textStart = i;
        }
      } else {
        i++;
      }
    }

    // Emit remaining text
    if (textStart < this.buffer.length) {
      const text = this.normalizeLineEndings(
        this.buffer.slice(textStart).toString("utf8")
      );
      if (text) {
        this.emit("data", text);
      }
      this.buffer = Buffer.alloc(0);
    } else {
      this.buffer = Buffer.alloc(0);
    }
  }

  private handleNegotiation(cmd: number, option: number): void {
    // Telnet negotiation handling
    if (cmd === DO) {
      // Server is asking if we WILL do something
      if (option === OPT_SGA) {
        // Accept Suppress Go Ahead
        this.sendNegotiation(WILL, option);
      } else if (option === OPT_TTYPE) {
        // Accept terminal type negotiation
        this.sendNegotiation(WILL, option);
      } else if (option === OPT_ECHO) {
        // Refuse to echo - we don't want to echo what we send
        this.sendNegotiation(WONT, option);
      } else {
        // Refuse everything else
        this.sendNegotiation(WONT, option);
      }
    } else if (cmd === DONT) {
      // Server telling us not to do something - acknowledge
      this.sendNegotiation(WONT, option);
    } else if (cmd === WILL) {
      // Server is offering to do something
      if (option === OPT_SGA) {
        // Accept Suppress Go Ahead
        this.sendNegotiation(DO, option);
      } else if (option === OPT_ECHO) {
        // IMPORTANT: Accept server echo - server will NOT echo our input
        // When server says WILL ECHO, it means "I will control echo"
        // We say DO ECHO to let server handle echo (which means no echo for password prompts etc)
        // But since we display locally, we want NO server echo
        this.sendNegotiation(DONT, option);
      } else {
        // Refuse everything else
        this.sendNegotiation(DONT, option);
      }
    } else if (cmd === WONT) {
      // Server telling us it won't do something - acknowledge
      this.sendNegotiation(DONT, option);
    }
  }

  private sendNegotiation(cmd: number, option: number): void {
    const response = Buffer.from([IAC, cmd, option]);
    this.sendRaw(response);
  }
}
