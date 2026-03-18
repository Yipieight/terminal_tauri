/**
 * MiShell - Taskbar
 *
 * Windows XP-style taskbar with Start button, running apps, and system tray clock.
 */

import type { WindowState } from "./types";
import { toggleWindow } from "./windowManager";
import { toggleStartMenu } from "./startMenu";

let activeWindowId: string | null = null;

export function initTaskbar(): void {
  // Start button
  const startBtn = document.getElementById("start-button")!;
  startBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleStartMenu();
  });

  // Clock
  updateClock();
  setInterval(updateClock, 30000);

  // Close start menu when clicking elsewhere
  document.addEventListener("click", (e) => {
    const startMenu = document.getElementById("start-menu")!;
    const startBtn = document.getElementById("start-button")!;
    if (
      startMenu.style.display !== "none" &&
      !startMenu.contains(e.target as Node) &&
      !startBtn.contains(e.target as Node)
    ) {
      startMenu.style.display = "none";
    }
  });
}

function updateClock(): void {
  const clock = document.getElementById("clock")!;
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const h12 = hours % 12 || 12;
  clock.textContent = `${h12}:${minutes} ${ampm}`;
}

export function addTaskbarButton(state: WindowState): void {
  const runningApps = document.getElementById("running-apps")!;

  const btn = document.createElement("button");
  btn.className = "taskbar-app-btn";
  btn.id = `taskbar-btn-${state.id}`;
  btn.textContent = state.title;
  btn.addEventListener("click", () => {
    toggleWindow(state.id);
  });

  runningApps.appendChild(btn);
}

export function removeTaskbarButton(id: string): void {
  const btn = document.getElementById(`taskbar-btn-${id}`);
  btn?.remove();
  if (activeWindowId === id) {
    activeWindowId = null;
  }
}

export function setActiveTaskbarButton(id: string): void {
  // Remove active from all
  document.querySelectorAll(".taskbar-app-btn").forEach((btn) => {
    btn.classList.remove("active");
  });

  // Set active
  const btn = document.getElementById(`taskbar-btn-${id}`);
  btn?.classList.add("active");
  activeWindowId = id;
}
