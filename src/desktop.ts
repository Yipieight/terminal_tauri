/**
 * MiShell - Desktop
 *
 * Windows XP-style desktop with wallpaper, icons, and app launching.
 */

import { createWindow, getWindows, bringToFront, restoreWindow } from "./windowManager";
import { initTaskbar } from "./taskbar";
import { initStartMenu } from "./startMenu";
import { mountTerminal } from "./apps/terminal";
import { mountFileExplorer } from "./apps/fileExplorer";
import { mountTaskManager } from "./apps/taskManager";
import { mountSingleMode, getActiveSimulations, MODE_NAMES, type SimMode, SIM_MODES } from "./apps/threadVisualizer";
import { mountCalculator } from "./apps/calculator";

let windowCounter = 0;

export function initDesktop(): void {
  createDesktopIcons();
  initTaskbar();
  initStartMenu();
}

function createDesktopIcons(): void {
  const container = document.getElementById("desktop-icons")!;

  const icons = [
    { id: "icon-terminal", label: "MiShell\nTerminal", emoji: "\uD83D\uDCBB", action: launchTerminal },
    { id: "icon-explorer", label: "File\nExplorer", emoji: "\uD83D\uDCC1", action: () => launchFileExplorer() },
    { id: "icon-taskmanager", label: "Task\nManager", emoji: "\uD83D\uDCCA", action: launchTaskManager },
    { id: "icon-calc", label: "Calculator", emoji: "\uD83E\uDDEE", action: launchCalculator },
    { id: "icon-threads", label: "Thread\nVisualizer", emoji: "\uD83C\uDFAC", action: launchThreadVisualizer },
    { id: "icon-recycle", label: "Recycle\nBin", emoji: "\uD83D\uDDD1\uFE0F", action: () => {} },
  ];

  icons.forEach((icon, index) => {
    const el = document.createElement("div");
    el.className = "desktop-icon";
    el.id = icon.id;
    el.style.top = `${20 + index * 90}px`;
    el.style.left = "20px";
    el.innerHTML = `
      <div class="desktop-icon-img">${icon.emoji}</div>
      <div class="desktop-icon-label">${icon.label}</div>
    `;

    el.addEventListener("dblclick", icon.action);
    container.appendChild(el);
  });
}

export function launchTerminal(): void {
  const id = `terminal-${++windowCounter}`;
  createWindow({
    id,
    title: "MiShell Terminal",
    width: 700,
    height: 450,
    appType: "terminal",
    onContent: (body) => {
      mountTerminal(body);
    },
  });
}

export function launchTaskManager(): void {
  const id = `taskmanager-${++windowCounter}`;
  createWindow({
    id,
    title: "Task Manager",
    width: 500,
    height: 420,
    appType: "taskmanager",
    onContent: (body) => {
      mountTaskManager(body);
    },
  });
}

/**
 * Launch a thread visualizer for a specific mode.
 * If a window for that mode already exists, update its parameters instead.
 * If mode is "all", opens all 7 modes in sequence.
 */
export function launchSimulation(mode: SimMode | "all" = "semaphore", param: number = 3): void {
  if (mode === "all") {
    for (const m of SIM_MODES) {
      launchSimulation(m, param);
    }
    return;
  }

  const instanceId = `sim-${mode}`;
  const existing = getActiveSimulations().get(instanceId);

  if (existing) {
    // Update existing window's parameters
    existing.updateParam(param);
    // Focus the existing window properly
    const win = getWindows().get(instanceId);
    if (win) {
      if (win.isMinimized) {
        restoreWindow(instanceId);
      } else {
        bringToFront(instanceId);
      }
    }
    return;
  }

  createWindow({
    id: instanceId,
    title: `Sim: ${MODE_NAMES[mode]}`,
    width: 720,
    height: 420,
    appType: `sim-${mode}`,
    onContent: (body) => {
      mountSingleMode(body, mode, param, instanceId);
    },
    onClose: () => {
      const inst = getActiveSimulations().get(instanceId);
      if (inst) inst.destroy();
    },
  });
}

export function launchCalculator(): void {
  const id = `calculator-${++windowCounter}`;
  createWindow({
    id,
    title: "Calculator",
    width: 260,
    height: 340,
    appType: "calculator",
    onContent: (body) => {
      mountCalculator(body);
    },
  });
}

// Keep backward compatibility
export function launchThreadVisualizer(): void {
  launchSimulation("semaphore", 3);
}

export function launchFileExplorer(initialPath?: string): void {
  const id = `explorer-${++windowCounter}`;
  createWindow({
    id,
    title: "File Explorer",
    width: 750,
    height: 500,
    appType: "explorer",
    onContent: (body) => {
      mountFileExplorer(body, initialPath);
    },
  });
}
