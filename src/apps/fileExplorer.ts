/**
 * MiShell - File Explorer App
 *
 * Windows XP-style file explorer with tree view, file listing,
 * and basic file operations (create folder, delete, rename).
 */

import { invoke } from "@tauri-apps/api/core";
import type { FsEntry, FsTreeNode } from "../types";

export function mountFileExplorer(
  container: HTMLElement,
  initialPath?: string
): void {
  container.style.flexDirection = "column";
  container.style.display = "flex";

  let currentPath = initialPath || "/home/user";
  const historyStack: string[] = [];
  let historyPos = -1;

  // ── Build layout ──────────────────────────────────────────
  const explorer = document.createElement("div");
  explorer.className = "explorer-container";

  // Toolbar
  const toolbar = document.createElement("div");
  toolbar.className = "explorer-toolbar";
  toolbar.innerHTML = `
    <button class="explorer-btn" id="exp-back" title="Back">&#9664;</button>
    <button class="explorer-btn" id="exp-forward" title="Forward">&#9654;</button>
    <button class="explorer-btn" id="exp-up" title="Up">&#8593;</button>
    <div class="explorer-address-bar">
      <span class="explorer-address-label">Address:</span>
      <input type="text" class="explorer-address-input" value="${currentPath}" />
    </div>
  `;

  // Split panel
  const splitPanel = document.createElement("div");
  splitPanel.className = "explorer-split";

  // Tree panel (left)
  const treePanel = document.createElement("div");
  treePanel.className = "explorer-tree-panel";
  const treeView = document.createElement("ul");
  treeView.className = "tree-view";
  treePanel.appendChild(treeView);

  // File listing panel (right)
  const filePanel = document.createElement("div");
  filePanel.className = "explorer-file-panel";

  splitPanel.appendChild(treePanel);
  splitPanel.appendChild(filePanel);

  // Status bar
  const statusBar = document.createElement("div");
  statusBar.className = "status-bar explorer-status";
  statusBar.innerHTML = `<div class="status-bar-field">Ready</div>`;

  explorer.appendChild(toolbar);
  explorer.appendChild(splitPanel);
  explorer.appendChild(statusBar);
  container.appendChild(explorer);

  // ── Context menu ──────────────────────────────────────────
  const contextMenu = document.createElement("div");
  contextMenu.className = "explorer-context-menu";
  contextMenu.style.display = "none";
  contextMenu.innerHTML = `
    <button class="context-item" data-action="new-folder">New Folder</button>
    <button class="context-item" data-action="new-file">New File</button>
    <hr />
    <button class="context-item" data-action="delete">Delete</button>
    <button class="context-item" data-action="rename">Rename</button>
  `;
  explorer.appendChild(contextMenu);

  // ── References ────────────────────────────────────────────
  const addressInput = toolbar.querySelector(
    ".explorer-address-input"
  ) as HTMLInputElement;

  // ── Navigation functions ──────────────────────────────────
  function navigateTo(path: string, addToHistory = true): void {
    if (addToHistory) {
      // Truncate forward history
      historyStack.length = historyPos + 1;
      historyStack.push(path);
      historyPos = historyStack.length - 1;
    }
    currentPath = path;
    addressInput.value = path;
    refreshFileList();
  }

  async function refreshFileList(): Promise<void> {
    try {
      const entries: FsEntry[] = await invoke("fs_list_dir", {
        path: currentPath,
      });
      renderFileList(entries);
      statusBar.innerHTML = `<div class="status-bar-field">${entries.length} object(s) | ${currentPath}</div>`;
    } catch (err) {
      filePanel.innerHTML = `<div class="explorer-error">${err}</div>`;
      statusBar.innerHTML = `<div class="status-bar-field">Error: ${err}</div>`;
    }
  }

  function renderFileList(entries: FsEntry[]): void {
    filePanel.innerHTML = "";

    if (entries.length === 0) {
      filePanel.innerHTML = `<div class="explorer-empty">This folder is empty</div>`;
      return;
    }

    entries.forEach((entry) => {
      const item = document.createElement("div");
      item.className = "explorer-file-item";
      item.dataset.name = entry.name;
      item.dataset.isDir = String(entry.is_dir);

      const icon = entry.is_dir ? "\uD83D\uDCC1" : "\uD83D\uDCC4";
      item.innerHTML = `
        <div class="explorer-file-icon">${icon}</div>
        <div class="explorer-file-name">${entry.name}</div>
      `;

      // Double click to open
      item.addEventListener("dblclick", () => {
        if (entry.is_dir) {
          const newPath =
            currentPath === "/"
              ? `/${entry.name}`
              : `${currentPath}/${entry.name}`;
          navigateTo(newPath);
        }
      });

      // Single click to select
      item.addEventListener("click", () => {
        filePanel
          .querySelectorAll(".explorer-file-item")
          .forEach((el) => el.classList.remove("selected"));
        item.classList.add("selected");
      });

      // Right click context menu
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, entry.name, entry.is_dir);
      });

      filePanel.appendChild(item);
    });
  }

  // ── Tree view ─────────────────────────────────────────────
  async function refreshTree(): Promise<void> {
    try {
      const tree: FsTreeNode = await invoke("fs_get_tree", {
        path: "/",
        depth: 4,
      });
      treeView.innerHTML = "";
      renderTreeNode(tree, treeView);
    } catch (err) {
      treeView.innerHTML = `<li>Error loading tree</li>`;
    }
  }

  function renderTreeNode(node: FsTreeNode, parentUl: HTMLElement): void {
    const li = document.createElement("li");

    if (node.children.length > 0) {
      const details = document.createElement("details");
      details.open = node.path === "/" || currentPath.startsWith(node.path);

      const summary = document.createElement("summary");
      summary.textContent = node.name;
      summary.addEventListener("click", (e) => {
        e.preventDefault();
        details.open = !details.open;
        navigateTo(node.path);
      });

      details.appendChild(summary);

      const childUl = document.createElement("ul");
      node.children.forEach((child) => renderTreeNode(child, childUl));
      details.appendChild(childUl);

      li.appendChild(details);
    } else {
      const link = document.createElement("a");
      link.textContent = node.name;
      link.href = "#";
      link.addEventListener("click", (e) => {
        e.preventDefault();
        navigateTo(node.path);
      });
      li.appendChild(link);
    }

    parentUl.appendChild(li);
  }

  // ── Context menu ──────────────────────────────────────────
  let contextTargetName = "";

  function showContextMenu(
    x: number,
    y: number,
    name: string,
    _isDir: boolean
  ): void {
    contextTargetName = name;

    // Position relative to the explorer container
    const rect = explorer.getBoundingClientRect();
    contextMenu.style.left = `${x - rect.left}px`;
    contextMenu.style.top = `${y - rect.top}px`;
    contextMenu.style.display = "block";
  }

  // Right-click on empty area
  filePanel.addEventListener("contextmenu", (e) => {
    if (e.target === filePanel) {
      e.preventDefault();
      contextTargetName = "";
      const rect = explorer.getBoundingClientRect();
      contextMenu.style.left = `${e.clientX - rect.left}px`;
      contextMenu.style.top = `${e.clientY - rect.top}px`;
      contextMenu.style.display = "block";
    }
  });

  // Hide context menu on click elsewhere
  document.addEventListener("click", () => {
    contextMenu.style.display = "none";
  });

  // Context menu actions
  contextMenu.addEventListener("click", async (e) => {
    const action = (e.target as HTMLElement).dataset.action;
    if (!action) return;

    contextMenu.style.display = "none";

    if (action === "new-folder") {
      const name = prompt("Folder name:");
      if (name) {
        try {
          const path =
            currentPath === "/"
              ? `/${name}`
              : `${currentPath}/${name}`;
          await invoke("fs_create_dir", { path });
          refreshFileList();
          refreshTree();
        } catch (err) {
          alert(`Error: ${err}`);
        }
      }
    } else if (action === "new-file") {
      const name = prompt("File name:");
      if (name) {
        try {
          await invoke("execute_command", {
            input: `touch ${currentPath === "/" ? "" : currentPath}/${name}`,
          });
          refreshFileList();
        } catch (err) {
          alert(`Error: ${err}`);
        }
      }
    } else if (action === "delete" && contextTargetName) {
      if (confirm(`Delete "${contextTargetName}"?`)) {
        try {
          const path =
            currentPath === "/"
              ? `/${contextTargetName}`
              : `${currentPath}/${contextTargetName}`;
          await invoke("fs_delete", { path });
          refreshFileList();
          refreshTree();
        } catch (err) {
          alert(`Error: ${err}`);
        }
      }
    } else if (action === "rename" && contextTargetName) {
      const newName = prompt("New name:", contextTargetName);
      if (newName && newName !== contextTargetName) {
        try {
          const oldPath =
            currentPath === "/"
              ? `/${contextTargetName}`
              : `${currentPath}/${contextTargetName}`;
          const newPath =
            currentPath === "/"
              ? `/${newName}`
              : `${currentPath}/${newName}`;
          await invoke("fs_rename", { oldPath, newPath });
          refreshFileList();
          refreshTree();
        } catch (err) {
          alert(`Error: ${err}`);
        }
      }
    }
  });

  // ── Toolbar events ────────────────────────────────────────
  toolbar.querySelector("#exp-back")!.addEventListener("click", () => {
    if (historyPos > 0) {
      historyPos--;
      navigateTo(historyStack[historyPos], false);
    }
  });

  toolbar.querySelector("#exp-forward")!.addEventListener("click", () => {
    if (historyPos < historyStack.length - 1) {
      historyPos++;
      navigateTo(historyStack[historyPos], false);
    }
  });

  toolbar.querySelector("#exp-up")!.addEventListener("click", () => {
    if (currentPath !== "/") {
      const parentPath = currentPath.substring(
        0,
        currentPath.lastIndexOf("/")
      ) || "/";
      navigateTo(parentPath);
    }
  });

  addressInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      navigateTo(addressInput.value.trim());
    }
  });

  // ── Initial load ──────────────────────────────────────────
  historyStack.push(currentPath);
  historyPos = 0;
  refreshFileList();
  refreshTree();
}
