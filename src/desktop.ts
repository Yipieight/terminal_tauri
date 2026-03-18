/**
 * MiShell - Desktop
 *
 * Windows XP-style desktop with wallpaper, icons, and app launching.
 */

import { createWindow } from "./windowManager";
import { initTaskbar } from "./taskbar";
import { initStartMenu } from "./startMenu";
import { mountTerminal } from "./apps/terminal";
import { mountFileExplorer } from "./apps/fileExplorer";
import { mountTaskManager } from "./apps/taskManager";

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
