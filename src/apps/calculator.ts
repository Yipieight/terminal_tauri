/**
 * MiShell - Calculator App
 *
 * Windows XP-style calculator. Every operation is logged as a "process"
 * in the Task Manager via command history, so the user can see how
 * each calculation consumes memory and appears in the process list.
 */

import { invoke } from "@tauri-apps/api/core";

export function mountCalculator(container: HTMLElement): void {
  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.background = "#f0f0f0";
  container.style.overflow = "hidden";
  container.style.userSelect = "none";

  container.innerHTML = `
    <div class="calc-display">
      <div class="calc-history"></div>
      <input class="calc-screen" value="0" readonly />
    </div>
    <div class="calc-buttons">
      <button class="calc-btn calc-btn-fn" data-v="C">C</button>
      <button class="calc-btn calc-btn-fn" data-v="CE">CE</button>
      <button class="calc-btn calc-btn-fn" data-v="BS">&larr;</button>
      <button class="calc-btn calc-btn-op" data-v="/">&divide;</button>

      <button class="calc-btn" data-v="7">7</button>
      <button class="calc-btn" data-v="8">8</button>
      <button class="calc-btn" data-v="9">9</button>
      <button class="calc-btn calc-btn-op" data-v="*">&times;</button>

      <button class="calc-btn" data-v="4">4</button>
      <button class="calc-btn" data-v="5">5</button>
      <button class="calc-btn" data-v="6">6</button>
      <button class="calc-btn calc-btn-op" data-v="-">&minus;</button>

      <button class="calc-btn" data-v="1">1</button>
      <button class="calc-btn" data-v="2">2</button>
      <button class="calc-btn" data-v="3">3</button>
      <button class="calc-btn calc-btn-op" data-v="+">+</button>

      <button class="calc-btn calc-btn-zero" data-v="0">0</button>
      <button class="calc-btn" data-v=".">.</button>
      <button class="calc-btn calc-btn-eq" data-v="=">=</button>
    </div>
  `;

  const screen = container.querySelector(".calc-screen") as HTMLInputElement;
  const historyEl = container.querySelector(".calc-history") as HTMLElement;

  let current = "0";
  let previous = "";
  let operator = "";
  let resetNext = false;

  function updateScreen(): void {
    screen.value = current;
  }

  function setHistory(text: string): void {
    historyEl.textContent = text;
  }

  function calculate(a: number, op: string, b: number): number {
    switch (op) {
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/": return b !== 0 ? a / b : NaN;
      default: return b;
    }
  }

  // Log each operation to history so it shows in Task Manager
  async function logOperation(expr: string): Promise<void> {
    try {
      await invoke("execute_command", { input: `echo calc: ${expr}` });
    } catch { /* silent */ }
  }

  function handleInput(value: string): void {
    // Numbers
    if (value >= "0" && value <= "9") {
      if (resetNext) { current = ""; resetNext = false; }
      if (current === "0" && value !== "0") current = value;
      else if (current === "0" && value === "0") { /* stay at 0 */ }
      else current += value;
      updateScreen();
      return;
    }

    // Decimal
    if (value === ".") {
      if (resetNext) { current = "0"; resetNext = false; }
      if (!current.includes(".")) current += ".";
      updateScreen();
      return;
    }

    // Clear all
    if (value === "C") {
      current = "0"; previous = ""; operator = ""; resetNext = false;
      setHistory("");
      updateScreen();
      return;
    }

    // Clear entry
    if (value === "CE") {
      current = "0"; resetNext = false;
      updateScreen();
      return;
    }

    // Backspace
    if (value === "BS") {
      if (current.length > 1) current = current.slice(0, -1);
      else current = "0";
      updateScreen();
      return;
    }

    // Operators
    if (["+", "-", "*", "/"].includes(value)) {
      if (operator && !resetNext) {
        // Chain operations
        const result = calculate(parseFloat(previous), operator, parseFloat(current));
        const expr = `${previous} ${operator} ${current} = ${result}`;
        logOperation(expr);
        current = String(result);
        setHistory(`${previous} ${opSymbol(operator)} ${current}`);
      }
      previous = current;
      operator = value;
      resetNext = true;
      setHistory(`${previous} ${opSymbol(value)}`);
      updateScreen();
      return;
    }

    // Equals
    if (value === "=") {
      if (!operator || !previous) return;
      const a = parseFloat(previous);
      const b = parseFloat(current);
      const result = calculate(a, operator, b);
      const expr = `${previous} ${operator} ${current} = ${result}`;
      logOperation(expr);

      const displayResult = isNaN(result) ? "Error" : String(
        Number.isInteger(result) ? result : parseFloat(result.toFixed(10))
      );

      setHistory(`${previous} ${opSymbol(operator)} ${current} =`);
      current = displayResult;
      previous = "";
      operator = "";
      resetNext = true;
      updateScreen();
    }
  }

  function opSymbol(op: string): string {
    switch (op) {
      case "+": return "+";
      case "-": return "-";
      case "*": return "\u00D7";
      case "/": return "\u00F7";
      default: return op;
    }
  }

  // Button clicks
  container.querySelector(".calc-buttons")!.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(".calc-btn") as HTMLElement;
    if (!btn) return;
    handleInput(btn.dataset.v!);
  });

  // Keyboard support
  container.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key >= "0" && e.key <= "9") handleInput(e.key);
    else if (e.key === ".") handleInput(".");
    else if (e.key === "+") handleInput("+");
    else if (e.key === "-") handleInput("-");
    else if (e.key === "*") handleInput("*");
    else if (e.key === "/") { e.preventDefault(); handleInput("/"); }
    else if (e.key === "Enter" || e.key === "=") handleInput("=");
    else if (e.key === "Backspace") handleInput("BS");
    else if (e.key === "Escape") handleInput("C");
  });

  container.setAttribute("tabindex", "0");
  setTimeout(() => container.focus(), 100);
}
