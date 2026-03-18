/**
 * MiShell - File Explorer App
 *
 * Windows XP-style file explorer with tree view, file listing,
 * and basic file operations (create folder/file, delete, rename).
 *
 * Uses custom XP-style dialog boxes instead of native prompt/confirm
 * since Tauri doesn't support native JS dialogs reliably.
 */

import { invoke } from "@tauri-apps/api/core";
import type { FsEntry, FsTreeNode } from "../types";

// ── XP-style Dialog Helpers ───────────────────────────────────
function showXpDialog(
  title: string,
  message: string,
  inputDefault?: string
): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.3);
      display: flex; align-items: center; justify-content: center;
      z-index: 99999;
    `;

    const isPrompt = inputDefault !== undefined;

    const dialog = document.createElement("div");
    dialog.className = "window";
    dialog.style.cssText = `
      width: 340px; position: relative; box-shadow: 2px 2px 10px rgba(0,0,0,0.5);
    `;

    dialog.innerHTML = `
      <div class="title-bar">
        <div class="title-bar-text">${title}</div>
      </div>
      <div class="window-body" style="padding: 12px;">
        <p style="margin: 0 0 10px; font-size: 11px;">${message}</p>
        ${isPrompt ? `<input type="text" value="${inputDefault}" style="width: 100%; box-sizing: border-box; padding: 3px 6px; font-size: 12px;" />` : ""}
        <div style="display: flex; justify-content: flex-end; gap: 6px; margin-top: 14px;">
          <button class="xp-dialog-ok" style="min-width: 70px;">OK</button>
          <button class="xp-dialog-cancel" style="min-width: 70px;">Cancel</button>
        </div>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const input = dialog.querySelector("input") as HTMLInputElement | null;
    const okBtn = dialog.querySelector(".xp-dialog-ok") as HTMLButtonElement;
    const cancelBtn = dialog.querySelector(".xp-dialog-cancel") as HTMLButtonElement;

    function cleanup(result: string | null) {
      overlay.remove();
      resolve(result);
    }

    okBtn.addEventListener("click", () => {
      if (isPrompt && input) {
        const val = input.value.trim();
        cleanup(val || null);
      } else {
        cleanup("ok");
      }
    });

    cancelBtn.addEventListener("click", () => cleanup(null));

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup(null);
    });

    // Enter/Escape keyboard shortcuts
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        okBtn.click();
      } else if (e.key === "Escape") {
        cleanup(null);
      }
    };
    overlay.addEventListener("keydown", keyHandler);

    // Focus input or OK button
    setTimeout(() => {
      if (input) {
        input.focus();
        input.select();
      } else {
        okBtn.focus();
      }
    }, 50);
  });
}

// ── File Explorer ─────────────────────────────────────────────
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
  explorer.appendChild(contextMenu);

  // ── References ────────────────────────────────────────────
  const addressInput = toolbar.querySelector(
    ".explorer-address-input"
  ) as HTMLInputElement;

  // ── Navigation functions ──────────────────────────────────
  function navigateTo(path: string, addToHistory = true): void {
    if (addToHistory) {
      historyStack.length = historyPos + 1;
      historyStack.push(path);
      historyPos = historyStack.length - 1;
    }
    currentPath = path;
    addressInput.value = path;
    refreshFileList();
  }

  function buildPath(name: string): string {
    return currentPath === "/" ? `/${name}` : `${currentPath}/${name}`;
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

    // Sort: directories first, then files
    const sorted = [...entries].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    sorted.forEach((entry) => {
      const item = document.createElement("div");
      item.className = "explorer-file-item";
      item.dataset.name = entry.name;
      item.dataset.isDir = String(entry.is_dir);

      const icon = entry.is_dir ? "\uD83D\uDCC1" : "\uD83D\uDCC4";
      item.innerHTML = `
        <div class="explorer-file-icon">${icon}</div>
        <div class="explorer-file-name">${entry.name}</div>
      `;

      // Double click to open folder
      item.addEventListener("dblclick", () => {
        if (entry.is_dir) {
          navigateTo(buildPath(entry.name));
        }
      });

      // Single click to select
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        filePanel
          .querySelectorAll(".explorer-file-item")
          .forEach((el) => el.classList.remove("selected"));
        item.classList.add("selected");
      });

      // Right click on file/folder
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Select the item visually
        filePanel
          .querySelectorAll(".explorer-file-item")
          .forEach((el) => el.classList.remove("selected"));
        item.classList.add("selected");
        openContextMenu(e.clientX, e.clientY, entry.name);
      });

      filePanel.appendChild(item);
    });
  }

  // ── Context Menu Logic ──────────────────────────────────────
  let contextTargetName: string | null = null;

  function openContextMenu(x: number, y: number, targetName: string | null): void {
    contextTargetName = targetName;
    const hasTarget = targetName !== null;

    // Build menu items dynamically based on context
    contextMenu.innerHTML = `
      <button class="context-item" data-action="new-folder">📁 New Folder</button>
      <button class="context-item" data-action="new-file">📄 New File</button>
      ${hasTarget ? `
        <hr />
        <button class="context-item" data-action="rename">✏️ Rename</button>
        <button class="context-item context-item-danger" data-action="delete">🗑️ Delete</button>
      ` : ""}
    `;

    // Position relative to the explorer container, clamped to bounds
    const rect = explorer.getBoundingClientRect();
    let left = x - rect.left;
    let top = y - rect.top;

    // Show temporarily to measure
    contextMenu.style.display = "block";
    const menuW = contextMenu.offsetWidth;
    const menuH = contextMenu.offsetHeight;

    // Clamp so it doesn't overflow
    if (left + menuW > rect.width) left = rect.width - menuW - 4;
    if (top + menuH > rect.height) top = rect.height - menuH - 4;
    if (left < 0) left = 4;
    if (top < 0) top = 4;

    contextMenu.style.left = `${left}px`;
    contextMenu.style.top = `${top}px`;
  }

  function hideContextMenu(): void {
    contextMenu.style.display = "none";
    contextTargetName = null;
  }

  // Right-click on empty area of file panel
  filePanel.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, null);
  });

  // Hide context menu on any click
  document.addEventListener("click", hideContextMenu);

  // Also hide if we scroll or resize
  filePanel.addEventListener("scroll", hideContextMenu);

  // Context menu action handler
  contextMenu.addEventListener("click", async (e) => {
    e.stopPropagation();
    const target = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
    if (!target) return;

    const action = target.dataset.action;
    hideContextMenu();

    switch (action) {
      case "new-folder": {
        const name = await showXpDialog(
          "New Folder",
          "Enter a name for the new folder:",
          "New Folder"
        );
        if (name) {
          try {
            await invoke("fs_create_dir", { path: buildPath(name) });
            refreshFileList();
            refreshTree();
          } catch (err) {
            await showXpDialog("Error", `Could not create folder: ${err}`);
          }
        }
        break;
      }

      case "new-file": {
        const name = await showXpDialog(
          "New File",
          "Enter a name for the new file:",
          "New File.txt"
        );
        if (name) {
          try {
            await invoke("execute_command", {
              input: `touch ${buildPath(name)}`,
            });
            refreshFileList();
            refreshTree();
          } catch (err) {
            await showXpDialog("Error", `Could not create file: ${err}`);
          }
        }
        break;
      }

      case "delete": {
        if (!contextTargetName) break;
        const targetName = contextTargetName;
        const confirmed = await showXpDialog(
          "Confirm Delete",
          `Are you sure you want to delete "${targetName}"?`
        );
        if (confirmed) {
          try {
            await invoke("fs_delete", { path: buildPath(targetName) });
            refreshFileList();
            refreshTree();
          } catch (err) {
            await showXpDialog("Error", `Could not delete: ${err}`);
          }
        }
        break;
      }

      case "rename": {
        if (!contextTargetName) break;
        const targetName = contextTargetName;
        const newName = await showXpDialog(
          "Rename",
          `Enter a new name for "${targetName}":`,
          targetName
        );
        if (newName && newName !== targetName) {
          try {
            await invoke("fs_rename", {
              oldPath: buildPath(targetName),
              newPath: buildPath(newName),
            });
            refreshFileList();
            refreshTree();
          } catch (err) {
            await showXpDialog("Error", `Could not rename: ${err}`);
          }
        }
        break;
      }
    }
  });

  // ── Tree view ─────────────────────────────────────────────
  async function refreshTree(): Promise<void> {
    try {
      const tree: FsTreeNode = await invoke("fs_get_tree", {
        path: "/",
        depth: 4,
      });
      treeView.innerHTML = "";
      renderTreeNode(tree, treeView);
    } catch (_err) {
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
      const parentPath =
        currentPath.substring(0, currentPath.lastIndexOf("/")) || "/";
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
