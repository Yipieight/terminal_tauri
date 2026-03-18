/**
 * MiShell - Window Manager
 *
 * Manages XP-style windows with drag, resize, minimize, maximize, close.
 * Each window uses XP.css classes for authentic Windows XP appearance.
 */

import type { WindowOptions, WindowState } from "./types";
import { addTaskbarButton, removeTaskbarButton, setActiveTaskbarButton } from "./taskbar";

const windows: Map<string, WindowState> = new Map();
let zCounter = 100;
let cascadeOffset = 0;

const TASKBAR_HEIGHT = 36;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;

export function getWindows(): Map<string, WindowState> {
  return windows;
}

export function createWindow(opts: WindowOptions): WindowState {
  const desktopEl = document.getElementById("desktop")!;

  // Cascade positioning
  const x = opts.x ?? 60 + cascadeOffset;
  const y = opts.y ?? 40 + cascadeOffset;
  cascadeOffset = (cascadeOffset + 30) % 180;

  // Create window DOM
  const win = document.createElement("div");
  win.className = "window xp-window";
  win.id = `window-${opts.id}`;
  win.style.position = "absolute";
  win.style.left = `${x}px`;
  win.style.top = `${y}px`;
  win.style.width = `${opts.width}px`;
  win.style.height = `${opts.height}px`;
  win.style.zIndex = `${++zCounter}`;
  win.style.display = "flex";
  win.style.flexDirection = "column";

  // Title bar
  const titleBar = document.createElement("div");
  titleBar.className = "title-bar";
  titleBar.innerHTML = `
    <div class="title-bar-text">${opts.title}</div>
    <div class="title-bar-controls">
      <button aria-label="Minimize" class="win-minimize"></button>
      <button aria-label="Maximize" class="win-maximize"></button>
      <button aria-label="Close" class="win-close"></button>
    </div>
  `;

  // Window body
  const body = document.createElement("div");
  body.className = "window-body";
  body.style.flex = "1";
  body.style.margin = "0";
  body.style.padding = "0";
  body.style.overflow = "hidden";
  body.style.display = "flex";

  // Resize handle
  const resizeHandle = document.createElement("div");
  resizeHandle.className = "resize-handle";

  win.appendChild(titleBar);
  win.appendChild(body);
  win.appendChild(resizeHandle);
  desktopEl.appendChild(win);

  const state: WindowState = {
    id: opts.id,
    title: opts.title,
    element: win,
    zIndex: zCounter,
    isMinimized: false,
    isMaximized: false,
    position: { x, y },
    size: { width: opts.width, height: opts.height },
    appType: opts.appType,
    onClose: opts.onClose,
  };

  windows.set(opts.id, state);

  // ── Focus on click ──────────────────────────────────────────
  win.addEventListener("mousedown", () => {
    bringToFront(opts.id);
  });

  // ── Dragging ────────────────────────────────────────────────
  setupDrag(titleBar, state);

  // ── Window controls ─────────────────────────────────────────
  titleBar.querySelector(".win-minimize")!.addEventListener("click", (e) => {
    e.stopPropagation();
    minimizeWindow(opts.id);
  });

  titleBar.querySelector(".win-maximize")!.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMaximize(opts.id);
  });

  titleBar.querySelector(".win-close")!.addEventListener("click", (e) => {
    e.stopPropagation();
    closeWindow(opts.id);
  });

  // Double-click title bar to maximize
  titleBar.addEventListener("dblclick", () => {
    toggleMaximize(opts.id);
  });

  // ── Resizing ────────────────────────────────────────────────
  setupResize(resizeHandle, state);

  // ── Mount app content ───────────────────────────────────────
  opts.onContent(body);

  // ── Add taskbar button ──────────────────────────────────────
  addTaskbarButton(state);
  setActiveTaskbarButton(opts.id);

  return state;
}

function setupDrag(titleBar: HTMLElement, state: WindowState): void {
  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;

  titleBar.addEventListener("mousedown", (e) => {
    if (state.isMaximized) return;
    if ((e.target as HTMLElement).tagName === "BUTTON") return;

    isDragging = true;
    offsetX = e.clientX - state.position.x;
    offsetY = e.clientY - state.position.y;
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;

    const x = Math.max(0, e.clientX - offsetX);
    const y = Math.max(0, e.clientY - offsetY);

    state.position.x = x;
    state.position.y = y;
    state.element.style.left = `${x}px`;
    state.element.style.top = `${y}px`;
  });

  document.addEventListener("mouseup", () => {
    isDragging = false;
  });
}

function setupResize(handle: HTMLElement, state: WindowState): void {
  let isResizing = false;
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;

  handle.addEventListener("mousedown", (e) => {
    if (state.isMaximized) return;
    isResizing = true;
    startX = e.clientX;
    startY = e.clientY;
    startW = state.size.width;
    startH = state.size.height;
    e.preventDefault();
    e.stopPropagation();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isResizing) return;

    const w = Math.max(MIN_WIDTH, startW + (e.clientX - startX));
    const h = Math.max(MIN_HEIGHT, startH + (e.clientY - startY));

    state.size.width = w;
    state.size.height = h;
    state.element.style.width = `${w}px`;
    state.element.style.height = `${h}px`;
  });

  document.addEventListener("mouseup", () => {
    isResizing = false;
  });
}

export function bringToFront(id: string): void {
  const state = windows.get(id);
  if (!state) return;

  state.zIndex = ++zCounter;
  state.element.style.zIndex = `${zCounter}`;
  setActiveTaskbarButton(id);
}

export function minimizeWindow(id: string): void {
  const state = windows.get(id);
  if (!state) return;

  state.isMinimized = true;
  state.element.style.display = "none";
}

export function restoreWindow(id: string): void {
  const state = windows.get(id);
  if (!state) return;

  state.isMinimized = false;
  state.element.style.display = "flex";
  bringToFront(id);
}

export function toggleMaximize(id: string): void {
  const state = windows.get(id);
  if (!state) return;

  if (state.isMaximized) {
    // Restore
    if (state.prevPosition && state.prevSize) {
      state.position = { ...state.prevPosition };
      state.size = { ...state.prevSize };
      state.element.style.left = `${state.position.x}px`;
      state.element.style.top = `${state.position.y}px`;
      state.element.style.width = `${state.size.width}px`;
      state.element.style.height = `${state.size.height}px`;
    }
    state.isMaximized = false;
  } else {
    // Maximize
    state.prevPosition = { ...state.position };
    state.prevSize = { ...state.size };

    state.position = { x: 0, y: 0 };
    state.size = {
      width: window.innerWidth,
      height: window.innerHeight - TASKBAR_HEIGHT,
    };

    state.element.style.left = "0px";
    state.element.style.top = "0px";
    state.element.style.width = "100vw";
    state.element.style.height = `calc(100vh - ${TASKBAR_HEIGHT}px)`;
    state.isMaximized = true;
  }
}

export function closeWindow(id: string): void {
  const state = windows.get(id);
  if (!state) return;

  state.onClose?.();
  state.element.remove();
  windows.delete(id);
  removeTaskbarButton(id);
}

export function toggleWindow(id: string): void {
  const state = windows.get(id);
  if (!state) return;

  if (state.isMinimized) {
    restoreWindow(id);
  } else if (state.zIndex === zCounter) {
    minimizeWindow(id);
  } else {
    bringToFront(id);
  }
}
