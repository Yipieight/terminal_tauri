/**
 * MiShell - Terminal App
 *
 * XP-styled terminal that sends commands to the Rust virtual filesystem
 * backend via Tauri IPC. Features dynamic prompt and Tab autocomplete.
 *
 * Special sentinels handled by the frontend (not the Rust backend):
 *   \x1B[CLEAR]        → clear screen
 *   \x1B[SIM:mode:N]   → launch thread visualizer
 *   \x1B[SCHED:algo:Q] → launch CPU scheduler
 *   \x1B[PS]           → list open windows
 *   \x1B[KILL:id]      → close a window
 *   \x1B[OPEN:app]     → launch an application
 *   \x1B[AI:prompt]    → query local AI (LM Studio / Ollama)
 */

import { invoke } from "@tauri-apps/api/core";
import type { CommandResult } from "../types";

// ── AI configuration (persisted in localStorage) ─────────────────────────
const AI_URL_KEY = "mishell_ai_url";
function getAIBaseUrl(): string {
  return localStorage.getItem(AI_URL_KEY) ?? "http://127.0.0.1:1234/v1";
}

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

  // ── AI Assistant ───────────────────────────────────────────────────────

  /**
   * Handle `ai <prompt>` — queries a local LLM via OpenAI-compatible API.
   * Streams tokens progressively into a <pre> element for a live-typing effect.
   */
  async function handleAI(userPrompt: string): Promise<void> {
    // ── Config command ──────────────────────────────────────────────────
    if (userPrompt.startsWith("--config ")) {
      const newUrl = userPrompt.slice(9).trim().replace(/\/+$/, "");
      localStorage.setItem(AI_URL_KEY, newUrl);
      appendText(`✓ AI endpoint configurado: ${newUrl}`, "system-msg");
      return;
    }

    // ── No prompt — show help ───────────────────────────────────────────
    if (!userPrompt || userPrompt === "--help") {
      appendText(
        [
          "🤖 MiShell AI — asistente de sistema operativo (modelo local)",
          "",
          "  Uso: ai <pregunta>",
          "",
          "  Ejemplos:",
          "    ai analiza el uso de memoria actual",
          "    ai explica que es un deadlock y como se detecta",
          "    ai cual es la diferencia entre mutex y semaforo",
          "    ai como funciona round robin con quantum=2",
          "    ai que ventajas tiene SJF sobre FIFO",
          "",
          `  Endpoint: ${getAIBaseUrl()}`,
          "  Cambiar: ai --config http://localhost:1234/v1   (LM Studio)",
          "           ai --config http://localhost:11434/v1  (Ollama)",
          "",
          "  Compatible con: Gemma, Llama, Mistral, Phi, Qwen y cualquier",
          "  modelo cargado en LM Studio u Ollama.",
        ].join("\n"),
        "system-msg"
      );
      return;
    }

    // ── Build system context from live OS state ─────────────────────────
    let ctxLines: string[] = [
      "Sistema: MiShell — emulador de OS virtual (Tauri v2 + Rust + TypeScript).",
      "Modulos implementados: filesystem virtual (RAII), sincronizacion de hilos",
      "(semaforo/mutex/monitor/deadlock/race/concurrency), planificacion de CPU",
      "(FIFO/SJF/Round Robin/Priority).",
    ];

    try {
      const cwd: string = await invoke("get_cwd");
      ctxLines.push(`Directorio actual: ${cwd}`);
    } catch { /* ignore */ }

    try {
      const stats: any = await invoke("get_system_stats");
      const total = stats.file_data_bytes + stats.node_overhead_bytes + stats.history_memory_bytes;
      ctxLines.push(
        `Memoria virtual usada: ${total} bytes total` +
        ` (archivos=${stats.file_data_bytes}B, nodos=${stats.node_overhead_bytes}B, historial=${stats.history_memory_bytes}B)`
      );
    } catch { /* ignore */ }

    try {
      const hist: string[] = await invoke("get_history");
      const recent = hist.slice(-8).join(", ");
      if (recent) ctxLines.push(`Comandos recientes: ${recent}`);
    } catch { /* ignore */ }

    const systemPrompt =
      "Eres un asistente experto en sistemas operativos integrado en MiShell. " +
      "Responde en español, de forma concisa y técnica. " +
      "Si la pregunta es sobre el sistema, usa el contexto provisto. " +
      "Máximo 5 oraciones a menos que se pida más detalle.\n\n" +
      "Contexto del sistema:\n" + ctxLines.join("\n");

    // ── Create output element for streaming ────────────────────────────
    const aiEl = document.createElement("pre");
    aiEl.className = "stdout ai-response";
    aiEl.textContent = "🤖 ";
    output.appendChild(aiEl);
    output.scrollTop = output.scrollHeight;

    const baseUrl = getAIBaseUrl();

    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "local-model", // LM Studio uses whatever is loaded; ignored by most servers
          messages: [
            { role: "system",  content: systemPrompt },
            { role: "user",    content: userPrompt   },
          ],
          stream: true,
          max_tokens: 800,
          temperature: 0.7,
        }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} — ${await res.text()}`);
      }

      // ── SSE streaming reader ──────────────────────────────────────────
      const reader  = res.body!.getReader();
      const decoder = new TextDecoder();
      let   sseBuffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() ?? "";           // keep last incomplete line

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") break;
          try {
            const chunk = JSON.parse(payload);
            const token: string = chunk.choices?.[0]?.delta?.content ?? "";
            if (token) {
              aiEl.textContent += token;
              output.scrollTop = output.scrollHeight;
            }
          } catch { /* malformed chunk — skip */ }
        }
      }

      // Ensure trailing newline for clean spacing
      if (aiEl.textContent && !aiEl.textContent.endsWith("\n")) {
        aiEl.textContent += "\n";
      }

    } catch (err: any) {
      // Network error = LM Studio not running
      const isNetworkErr = err instanceof TypeError || String(err).includes("fetch");
      aiEl.className = "stderr ai-response";
      if (isNetworkErr) {
        aiEl.textContent =
          `⚠️  Sin conexion con el servidor AI.\n` +
          `   Endpoint: ${baseUrl}\n\n` +
          `   Soluciones:\n` +
          `     1. Abre LM Studio y carga un modelo (Gemma, Llama, etc.)\n` +
          `     2. Activa el servidor: LM Studio → Local Server → Start Server\n` +
          `     3. O usa Ollama: ollama serve\n\n` +
          `   Para cambiar el endpoint: ai --config <url>`;
      } else {
        aiEl.textContent = `⚠️  Error: ${err?.message ?? err}`;
      }
    }
  }

  // ── Command executor ───────────────────────────────────────────────────

  async function executeCommand(rawInput: string): Promise<void> {
    const trimmed = rawInput.trim();
    if (!trimmed) return;

    // Echo the command line
    appendText(`${prompt.textContent}${trimmed}`, "command-line");

    // Send to Rust backend (for history tracking + parsing)
    try {
      const result: CommandResult = await invoke("execute_command", {
        input: trimmed,
      });

      // ── Special sentinels ─────────────────────────────────────────────
      if (result.stdout === "\x1B[CLEAR]") {
        output.innerHTML = "";

      } else if (result.stdout.startsWith("\x1B[SIM:")) {
        const match = result.stdout.match(/\x1B\[SIM:(\w+):(\d+)\]/);
        if (match) {
          const mode  = match[1];
          const param = parseInt(match[2]);
          try {
            const { launchSimulation } = await import("../desktop");
            launchSimulation(mode as any, param);
            appendText(`Simulacion '${mode}' abierta (param=${param})`, "system-msg");
          } catch {
            appendText("Error al abrir simulacion", "stderr");
          }
        }

      } else if (result.stdout.startsWith("\x1B[SCHED:")) {
        const match = result.stdout.match(/\x1B\[SCHED:(\w+):(\d+)\]/);
        if (match) {
          const algo    = match[1];
          const quantum = parseInt(match[2]);
          try {
            const { launchScheduler } = await import("../desktop");
            launchScheduler(algo as any, quantum);
            appendText(
              `CPU Scheduler '${algo.toUpperCase()}' abierto${algo === "rr" ? ` (Q=${quantum})` : ""}.`,
              "system-msg"
            );
          } catch {
            appendText("Error al abrir CPU Scheduler", "stderr");
          }
        }

      } else if (result.stdout.startsWith("\x1B[AI:")) {
        // Extract the prompt that was packed by Rust: \x1B[AI:the prompt here]
        const aiPrompt = result.stdout.slice(5, -1); // strip "\x1B[AI:" prefix and "]" suffix
        await handleAI(aiPrompt);

      } else if (result.stdout === "\x1B[PS]") {
        const { getWindows } = await import("../windowManager");
        const wins = getWindows();
        if (wins.size === 0) {
          appendText("No hay ventanas abiertas.", "stdout");
        } else {
          const lines = ["  ID                    TITLE                   TYPE"];
          lines.push("  " + "─".repeat(62));
          for (const [id, win] of wins) {
            lines.push(
              `  ${id.padEnd(22)}${win.title.padEnd(24)}${(win.appType ?? "unknown").padEnd(16)}`
            );
          }
          appendText(lines.join("\n"), "stdout");
        }

      } else if (result.stdout.startsWith("\x1B[KILL:")) {
        const target = result.stdout.slice(7, -1);
        const { getWindows, closeWindow } = await import("../windowManager");
        const win = getWindows().get(target);
        if (win) {
          closeWindow(target);
          appendText(`Ventana '${target}' cerrada.`, "system-msg");
        } else {
          appendText(
            `kill: no se encontro '${target}'. Usa 'ps' para ver las ventanas abiertas.`,
            "stderr"
          );
        }

      } else if (result.stdout.startsWith("\x1B[OPEN:")) {
        const app = result.stdout.slice(7, -1);
        try {
          const desktop = await import("../desktop");
          switch (app) {
            case "terminal":    desktop.launchTerminal();     break;
            case "explorer":    desktop.launchFileExplorer(); break;
            case "taskmanager": desktop.launchTaskManager();  break;
            case "calculator":  desktop.launchCalculator();   break;
          }
          appendText(`Aplicacion '${app}' abierta.`, "system-msg");
        } catch {
          appendText(`Error al abrir '${app}'.`, "stderr");
        }

      } else {
        if (result.stdout) appendText(result.stdout, "stdout");
      }

      if (result.stderr) appendText(result.stderr, "stderr");

    } catch (error) {
      appendText(`Error: ${error}`, "stderr");
    }

    await updatePrompt();
  }

  // ── Tab Autocomplete ────────────────────────────────────────
  async function handleTab(): Promise<void> {
    const currentValue = input.value;

    if (tabCompletions.length > 0 && tabIndex >= 0) {
      tabIndex = (tabIndex + 1) % tabCompletions.length;
      input.value = tabCompletions[tabIndex];
      return;
    }

    try {
      const completions: string[] = await invoke("autocomplete", {
        input: currentValue,
      });

      if (completions.length === 0) return;

      if (completions.length === 1) {
        input.value = completions[0];
        if (!completions[0].endsWith("/")) input.value += " ";
        clearAutocomplete();
      } else {
        tabCompletions = completions;
        tabIndex = 0;
        input.value = completions[0];
        autocompleteHint.textContent = completions.join("  ");
        autocompleteHint.style.display = "block";
      }
    } catch { /* silently fail */ }
  }

  // ── Event handlers ────────────────────────────────────────
  input.addEventListener("keydown", async (e: KeyboardEvent) => {
    if (e.key === "Tab") {
      e.preventDefault();
      await handleTab();
      return;
    }

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
      if (historyIndex === -1) currentInput = input.value;
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

  terminal.addEventListener("click", () => input.focus());

  updatePrompt();
  setTimeout(() => input.focus(), 100);
}
