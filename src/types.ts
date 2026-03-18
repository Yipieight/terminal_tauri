/**
 * MiShell - Shared TypeScript Types
 */

// ─── Response from Rust backend ────────────────────────────────
export interface CommandResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

// ─── File Explorer structured data ─────────────────────────────
export interface FsEntry {
  name: string;
  is_dir: boolean;
  size: number;
  modified: number;
}

export interface FsTreeNode {
  name: string;
  path: string;
  children: FsTreeNode[];
}

// ─── Window Manager types ──────────────────────────────────────
export interface WindowState {
  id: string;
  title: string;
  element: HTMLElement;
  zIndex: number;
  isMinimized: boolean;
  isMaximized: boolean;
  position: { x: number; y: number };
  size: { width: number; height: number };
  prevPosition?: { x: number; y: number };
  prevSize?: { width: number; height: number };
  appType: string;
  onClose?: () => void;
}

export interface WindowOptions {
  id: string;
  title: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
  appType: string;
  onContent: (bodyEl: HTMLElement) => void;
  onClose?: () => void;
}
