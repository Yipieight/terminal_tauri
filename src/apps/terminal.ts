/**
 * MiShell - Terminal App
 *
 * XP-styled terminal that sends commands to the Rust virtual filesystem
 * backend via Tauri IPC. Features dynamic prompt and Tab autocomplete.
 */

import { invoke } from "@tauri-apps/api/core";
import type { CommandResult } from "../types";

export function mountTerminal(container: HTMLElement): void {
  // ── Build DOM ─────────────────────────────────────────────
  container.style.flexDirection = "column";
  container.style.display = "flex";

  const terminal = document.createElement("div");
  terminal.className = "terminal-container";

  const output = document.createElement("div");
  output.className = "terminal-output";

  const welcome = document.createElement("pre");
  welcome.className = "system-msg";
  welcome.textContent = `MiShell v2.0 - Virtual OS Shell Emulator
Sandboxed Filesystem | Tauri v2 + Rust Backend
Type "help" for available commands. Press TAB to autocomplete.
${"─".repeat(50)}`;
  output.appendChild(welcome);

  const inputLine = document.createElement("div");
  inputLine.className = "terminal-input-line";

  const prompt = document.createElement("span");
  prompt.className = "terminal-prompt";
  prompt.textContent = "user@MiShell-PC:~$ ";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "terminal-input";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.autofocus = true;

  // Autocomplete suggestions display
  const autocompleteHint = document.createElement("div");
  autocompleteHint.className = "terminal-autocomplete";

  inputLine.appendChild(prompt);
  inputLine.appendChild(input);

  terminal.appendChild(output);
  terminal.appendChild(autocompleteHint);
  terminal.appendChild(inputLine);
  container.appendChild(terminal);

  // ── State ─────────────────────────────────────────────────
  let historyCache: string[] = [];
  let historyIndex = -1;
  let currentInput = "";
  let tabCompletions: string[] = [];
  let tabIndex = -1;

  // ── Helpers ───────────────────────────────────────────────
  function appendText(text: string, className: string): void {
    const pre = document.createElement("pre");
    pre.className = className;
    pre.textContent = text;
    output.appendChild(pre);
    output.scrollTop = output.scrollHeight;
  }

  async function updatePrompt(): Promise<void> {
    try {
      const cwd: string = await invoke("get_cwd");
      // Shorten home directory to ~
      const display = cwd.replace(/^\/home\/user/, "~");
      prompt.textContent = `user@MiShell-PC:${display}$ `;
    } catch {
      prompt.textContent = "user@MiShell-PC:~$ ";
    }
  }

  async function refreshHistory(): Promise<void> {
    try {
      historyCache = await invoke("get_history");
    } catch {
      historyCache = [];
    }
  }

  function clearAutocomplete(): void {
    autocompleteHint.textContent = "";
    autocompleteHint.style.display = "none";
    tabCompletions = [];
    tabIndex = -1;
  }

  async function executeCommand(rawInput: string): Promise<void> {
    const trimmed = rawInput.trim();
    if (!trimmed) return;

    // Get current prompt text for the echoed command line
    appendText(`${prompt.textContent}${trimmed}`, "command-line");

    // Frontend-only commands
    if (trimmed === "clear") {
      output.innerHTML = "";
      return;
    }

    if (trimmed === "help") {
      appendText(
        `Available commands:
  ls [path]           List directory contents
  cd [path]           Change directory
  pwd                 Print working directory
  mkdir [-p] <path>   Create directory
  touch <file>        Create empty file
  cat <file>          Read file content
  echo <text>         Print text
  echo <text> > file  Write text to file
  rm [-r] <path>      Remove file or directory
  cp <src> <dst>      Copy file
  mv <src> <dst>      Move/rename
  find [path] [name]  Search for files
  grep <pat> [file]   Search text (supports pipes)
  wc [-l|-w|-c]       Word/line/char count
  head [-n N] [file]  Show first N lines
  tail [-n N] [file]  Show last N lines
  sort [file]         Sort lines
  uniq                Remove duplicate lines
  whoami              Show current user
  hostname            Show hostname
  uname               Show OS info
  date                Show current date
  history             Show command history
  clear               Clear terminal
  help                Show this help
  cmd1 | cmd2         Pipe commands
  cmd > file          Redirect output to file

  TAB                 Autocomplete commands and paths
  Arrow Up/Down       Navigate command history`,
        "system-msg"
      );
      return;
    }

    // Send to Rust backend
    try {
      const result: CommandResult = await invoke("execute_command", {
        input: trimmed,
      });

      if (result.stdout) {
        appendText(result.stdout, "stdout");
      }
      if (result.stderr) {
        appendText(result.stderr, "stderr");
      }
    } catch (error) {
      appendText(`Error: ${error}`, "stderr");
    }

    // Update prompt after command (cwd may have changed)
    await updatePrompt();
  }

  // ── Tab Autocomplete ────────────────────────────────────────
  async function handleTab(): Promise<void> {
    const currentValue = input.value;

    if (tabCompletions.length > 0 && tabIndex >= 0) {
      // Cycle through existing completions
      tabIndex = (tabIndex + 1) % tabCompletions.length;
      input.value = tabCompletions[tabIndex];
      return;
    }

    // Fetch new completions from Rust
    try {
      const completions: string[] = await invoke("autocomplete", {
        input: currentValue,
      });

      if (completions.length === 0) {
        return;
      }

      if (completions.length === 1) {
        // Single match — fill it in directly
        input.value = completions[0];
        // Add space after commands (not paths ending in /)
        if (!completions[0].endsWith("/")) {
          input.value += " ";
        }
        clearAutocomplete();
      } else {
        // Multiple matches — show them and start cycling
        tabCompletions = completions;
        tabIndex = 0;
        input.value = completions[0];

        // Show all options
        autocompleteHint.textContent = completions.join("  ");
        autocompleteHint.style.display = "block";
      }
    } catch {
      // Silently fail
    }
  }

  // ── Event handlers ────────────────────────────────────────
  input.addEventListener("keydown", async (e: KeyboardEvent) => {
    if (e.key === "Tab") {
      e.preventDefault();
      await handleTab();
      return;
    }

    // Any key other than Tab clears autocomplete state
    if (e.key !== "Shift" && e.key !== "Control" && e.key !== "Alt") {
      clearAutocomplete();
    }

    if (e.key === "Enter") {
      const val = input.value;
      input.value = "";
      historyIndex = -1;
      currentInput = "";
      clearAutocomplete();
      await executeCommand(val);
      await refreshHistory();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (historyCache.length === 0) await refreshHistory();

      if (historyIndex === -1) {
        currentInput = input.value;
      }
      if (historyIndex < historyCache.length - 1) {
        historyIndex++;
        input.value = historyCache[historyCache.length - 1 - historyIndex];
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex > 0) {
        historyIndex--;
        input.value = historyCache[historyCache.length - 1 - historyIndex];
      } else if (historyIndex === 0) {
        historyIndex = -1;
        input.value = currentInput;
      }
    }
  });

  // Focus input when clicking terminal area
  terminal.addEventListener("click", () => {
    input.focus();
  });

  // Initialize prompt with current directory
  updatePrompt();

  // Auto focus
  setTimeout(() => input.focus(), 100);
}
