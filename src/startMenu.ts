/**
 * MiShell - Start Menu
 *
 * Windows XP-style Start menu with application launcher.
 */

import { launchTerminal, launchFileExplorer, launchTaskManager, launchThreadVisualizer, launchCalculator, launchScheduler } from "./desktop";
import { showShutdown } from "./bootSequence";

export function initStartMenu(): void {
  const menu = document.getElementById("start-menu")!;
  menu.innerHTML = `
    <div class="start-menu-header">
      <div class="start-menu-avatar">&#128100;</div>
      <span class="start-menu-username">User</span>
    </div>
    <div class="start-menu-body">
      <div class="start-menu-left">
        <button class="start-menu-item" id="sm-terminal">
          <span class="start-menu-icon">&#128187;</span>
          <span>MiShell Terminal</span>
        </button>
        <button class="start-menu-item" id="sm-explorer">
          <span class="start-menu-icon">&#128193;</span>
          <span>File Explorer</span>
        </button>
        <button class="start-menu-item" id="sm-taskmanager">
          <span class="start-menu-icon">&#128202;</span>
          <span>Task Manager</span>
        </button>
        <button class="start-menu-item" id="sm-threads">
          <span class="start-menu-icon">&#127916;</span>
          <span>Thread Visualizer</span>
        </button>
        <button class="start-menu-item" id="sm-calculator">
          <span class="start-menu-icon">&#129518;</span>
          <span>Calculator</span>
        </button>
        <button class="start-menu-item" id="sm-scheduler">
          <span class="start-menu-icon">&#9201;</span>
          <span>CPU Scheduler</span>
        </button>
      </div>
      <div class="start-menu-divider"></div>
      <div class="start-menu-right">
        <button class="start-menu-item sm-right-item" id="sm-documents">
          <span>My Documents</span>
        </button>
        <button class="start-menu-item sm-right-item" id="sm-computer">
          <span>My Computer</span>
        </button>
      </div>
    </div>
    <div class="start-menu-footer">
      <button class="start-menu-item start-menu-shutdown" id="sm-shutdown">
        <span class="start-menu-icon">&#9211;</span>
        <span>Turn Off Computer</span>
      </button>
    </div>
  `;

  // Wire up launch buttons
  document.getElementById("sm-terminal")!.addEventListener("click", () => {
    launchTerminal();
    hideStartMenu();
  });

  document.getElementById("sm-explorer")!.addEventListener("click", () => {
    launchFileExplorer();
    hideStartMenu();
  });

  document.getElementById("sm-taskmanager")!.addEventListener("click", () => {
    launchTaskManager();
    hideStartMenu();
  });

  document.getElementById("sm-threads")!.addEventListener("click", () => {
    launchThreadVisualizer();
    hideStartMenu();
  });

  document.getElementById("sm-calculator")!.addEventListener("click", () => {
    launchCalculator();
    hideStartMenu();
  });

  document.getElementById("sm-scheduler")!.addEventListener("click", () => {
    launchScheduler("fifo", 2);
    hideStartMenu();
  });

  document.getElementById("sm-documents")!.addEventListener("click", () => {
    launchFileExplorer("/home/user/Documents");
    hideStartMenu();
  });

  document.getElementById("sm-computer")!.addEventListener("click", () => {
    launchFileExplorer("/");
    hideStartMenu();
  });

  document.getElementById("sm-shutdown")!.addEventListener("click", async () => {
    hideStartMenu();
    await showShutdown();
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      getCurrentWindow().close();
    } catch {
      window.close();
    }
  });
}

export function toggleStartMenu(): void {
  const menu = document.getElementById("start-menu")!;
  menu.style.display = menu.style.display === "none" ? "flex" : "none";
}

export function hideStartMenu(): void {
  const menu = document.getElementById("start-menu")!;
  menu.style.display = "none";
}
