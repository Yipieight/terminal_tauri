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

    // Send to Rust backend
    try {
      const result: CommandResult = await invoke("execute_command", {
        input: trimmed,
      });

      // Handle special signals from backend
      if (result.stdout === "\x1B[CLEAR]") {
        output.innerHTML = "";
      } else if (result.stdout.startsWith("\x1B[SIM:")) {
        // Launch simulation: \x1B[SIM:mode:param]
        const match = result.stdout.match(/\x1B\[SIM:(\w+):(\d+)\]/);
        if (match) {
          const mode = match[1];
          const param = parseInt(match[2]);
          try {
            const { launchSimulation } = await import("../desktop");
            launchSimulation(mode as any, param);
            appendText(`Simulacion '${mode}' abierta (param=${param})`, "system-msg");
          } catch {
            appendText("Error al abrir simulacion", "stderr");
          }
        }
      } else if (result.stdout === "\x1B[PS]") {
        // List ALL open windows
        const { getWindows } = await import("../windowManager");
        const wins = getWindows();
        if (wins.size === 0) {
          appendText("No hay ventanas abiertas.", "stdout");
        } else {
          const lines = ["  ID                    TITLE                   TYPE"];
          const divider = "  " + "-".repeat(62);
          lines.push(divider);
          for (const [id, win] of wins) {
            const title = win.title.padEnd(24);
            const type = (win.appType || "unknown").padEnd(16);
            lines.push(`  ${id.padEnd(22)}${title}${type}`);
          }
          appendText(lines.join("\n"), "stdout");
        }
      } else if (result.stdout.startsWith("\x1B[KILL:")) {
        const target = result.stdout.replace("\x1B[KILL:", "").replace("]", "");
        const { getWindows, closeWindow } = await import("../windowManager");
        const wins = getWindows();
        const win = wins.get(target);
        if (win) {
          closeWindow(target);
          appendText(`Ventana '${target}' cerrada.`, "system-msg");
        } else {
          appendText(`kill: no se encontro '${target}'. Usa 'ps' para ver las ventanas abiertas.`, "stderr");
        }
      } else if (result.stdout.startsWith("\x1B[OPEN:")) {
        const app = result.stdout.replace("\x1B[OPEN:", "").replace("]", "");
        try {
          const desktop = await import("../desktop");
          switch (app) {
            case "terminal":
              desktop.launchTerminal();
              break;
            case "explorer":
              desktop.launchFileExplorer();
              break;
            case "taskmanager":
              desktop.launchTaskManager();
              break;
            case "calculator":
              desktop.launchCalculator();
              break;
          }
          appendText(`Aplicacion '${app}' abierta.`, "system-msg");
        } catch {
          appendText(`Error al abrir '${app}'.`, "stderr");
        }
      } else {
        if (result.stdout) {
          appendText(result.stdout, "stdout");
        }
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
