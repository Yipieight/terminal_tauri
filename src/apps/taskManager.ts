/**
 * MiShell - Task Manager App
 *
 * Windows XP-style Task Manager that shows:
 *   - Processes tab: list of recent commands with simulated PID/memory
 *   - Performance tab: memory usage visualization with animated bar chart
 *   - System tab: filesystem stats (files, dirs, total bytes)
 *
 * All data comes from the Rust backend via get_system_stats IPC command.
 * Refreshes every 2 seconds to show real-time changes.
 */

import { invoke } from "@tauri-apps/api/core";

interface ProcessInfo {
  pid: number;
  name: string;
  memory_kb: number;
  status: string;
}

interface SystemStats {
  total_files: number;
  total_dirs: number;
  total_bytes: number;
  history_count: number;
  cwd: string;
  estimated_memory: number;
  processes: ProcessInfo[];
}

export function mountTaskManager(container: HTMLElement): void {
  container.style.flexDirection = "column";
  container.style.display = "flex";

  const tm = document.createElement("div");
  tm.className = "taskmanager-container";

  // Tabs
  const tabBar = document.createElement("div");
  tabBar.className = "tm-tab-bar";
  tabBar.innerHTML = `
    <button class="tm-tab active" data-tab="processes">Processes</button>
    <button class="tm-tab" data-tab="performance">Performance</button>
    <button class="tm-tab" data-tab="system">System</button>
  `;

  // Tab content panels
  const processesPanel = document.createElement("div");
  processesPanel.className = "tm-panel";
  processesPanel.id = "tm-processes";

  const performancePanel = document.createElement("div");
  performancePanel.className = "tm-panel";
  performancePanel.id = "tm-performance";
  performancePanel.style.display = "none";

  const systemPanel = document.createElement("div");
  systemPanel.className = "tm-panel";
  systemPanel.id = "tm-system";
  systemPanel.style.display = "none";

  // Status bar
  const statusBar = document.createElement("div");
  statusBar.className = "status-bar tm-status";
  statusBar.innerHTML = `
    <div class="status-bar-field">Processes: 0</div>
    <div class="status-bar-field">Memory: 0 KB</div>
    <div class="status-bar-field">Files: 0</div>
  `;

  tm.appendChild(tabBar);
  tm.appendChild(processesPanel);
  tm.appendChild(performancePanel);
  tm.appendChild(systemPanel);
  tm.appendChild(statusBar);
  container.appendChild(tm);

  // Tab switching
  tabBar.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(".tm-tab") as HTMLElement;
    if (!btn) return;
    const tab = btn.dataset.tab;

    tabBar.querySelectorAll(".tm-tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");

    processesPanel.style.display = tab === "processes" ? "" : "none";
    performancePanel.style.display = tab === "performance" ? "" : "none";
    systemPanel.style.display = tab === "system" ? "" : "none";
  });

  // Memory history for the performance chart
  const memoryHistory: number[] = [];
  const MAX_HISTORY = 30;

  // Refresh data
  async function refresh(): Promise<void> {
    try {
      const stats: SystemStats = await invoke("get_system_stats");
      renderProcesses(stats);
      renderPerformance(stats);
      renderSystem(stats);
      renderStatus(stats);
    } catch (_err) {
      // silently retry next tick
    }
  }

  function renderProcesses(stats: SystemStats): void {
    const procs = stats.processes;
    processesPanel.innerHTML = `
      <table class="tm-table">
        <thead>
          <tr>
            <th>PID</th>
            <th>Process Name</th>
            <th>Memory</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${procs.length === 0
            ? `<tr><td colspan="4" style="text-align:center;color:#888;">No processes yet. Run commands in the terminal.</td></tr>`
            : procs
                .map(
                  (p) => `
            <tr class="${p.status === "Running" ? "tm-row-running" : ""}">
              <td>${p.pid}</td>
              <td>${p.name}</td>
              <td>${p.memory_kb} KB</td>
              <td><span class="tm-status-${p.status.toLowerCase()}">${p.status}</span></td>
            </tr>`
                )
                .join("")
          }
        </tbody>
      </table>
    `;
  }

  function renderPerformance(stats: SystemStats): void {
    const memKB = Math.round(stats.estimated_memory / 1024);
    memoryHistory.push(memKB);
    if (memoryHistory.length > MAX_HISTORY) memoryHistory.shift();

    const maxMem = Math.max(...memoryHistory, 1);
    const chartHeight = 120;

    // Build bar chart
    const bars = memoryHistory
      .map((val) => {
        const h = Math.max(2, (val / maxMem) * chartHeight);
        return `<div class="tm-bar" style="height:${h}px"></div>`;
      })
      .join("");

    performancePanel.innerHTML = `
      <div class="tm-perf-section">
        <div class="tm-perf-header">Memory Usage</div>
        <div class="tm-chart-container">
          <div class="tm-chart-label">${maxMem} KB</div>
          <div class="tm-chart">
            ${bars}
          </div>
          <div class="tm-chart-label">0 KB</div>
        </div>
        <div class="tm-perf-stats">
          <div class="tm-perf-row">
            <span>Current:</span>
            <strong>${memKB} KB</strong>
          </div>
          <div class="tm-perf-row">
            <span>Peak:</span>
            <strong>${Math.max(...memoryHistory)} KB</strong>
          </div>
          <div class="tm-perf-row">
            <span>File Data:</span>
            <strong>${formatBytes(stats.total_bytes)}</strong>
          </div>
          <div class="tm-perf-row">
            <span>Node Overhead:</span>
            <strong>${formatBytes((stats.total_files + stats.total_dirs) * 128)}</strong>
          </div>
          <div class="tm-perf-row">
            <span>History Memory:</span>
            <strong>${formatBytes(stats.estimated_memory - stats.total_bytes - (stats.total_files + stats.total_dirs) * 128)}</strong>
          </div>
        </div>
      </div>
    `;
  }

  function renderSystem(stats: SystemStats): void {
    systemPanel.innerHTML = `
      <div class="tm-sys-grid">
        <div class="tm-sys-card">
          <div class="tm-sys-icon">📁</div>
          <div class="tm-sys-value">${stats.total_dirs}</div>
          <div class="tm-sys-label">Directories</div>
        </div>
        <div class="tm-sys-card">
          <div class="tm-sys-icon">📄</div>
          <div class="tm-sys-value">${stats.total_files}</div>
          <div class="tm-sys-label">Files</div>
        </div>
        <div class="tm-sys-card">
          <div class="tm-sys-icon">💾</div>
          <div class="tm-sys-value">${formatBytes(stats.total_bytes)}</div>
          <div class="tm-sys-label">Total Data</div>
        </div>
        <div class="tm-sys-card">
          <div class="tm-sys-icon">🧠</div>
          <div class="tm-sys-value">${formatBytes(stats.estimated_memory)}</div>
          <div class="tm-sys-label">Heap Memory</div>
        </div>
        <div class="tm-sys-card">
          <div class="tm-sys-icon">📜</div>
          <div class="tm-sys-value">${stats.history_count}</div>
          <div class="tm-sys-label">Commands Run</div>
        </div>
        <div class="tm-sys-card">
          <div class="tm-sys-icon">📂</div>
          <div class="tm-sys-value tm-sys-cwd">${stats.cwd}</div>
          <div class="tm-sys-label">Working Dir</div>
        </div>
      </div>

      <div class="tm-sys-info">
        <div class="tm-perf-header">System Information</div>
        <table class="tm-info-table">
          <tr><td>OS:</td><td>MiShell Virtual OS 1.0</td></tr>
          <tr><td>Kernel:</td><td>Rust ${getRustVersion()}</td></tr>
          <tr><td>Shell:</td><td>MiShell v2.0</td></tr>
          <tr><td>Backend:</td><td>Tauri v2 + Rust</td></tr>
          <tr><td>Frontend:</td><td>TypeScript + XP.css</td></tr>
          <tr><td>Filesystem:</td><td>Virtual (JSON-backed)</td></tr>
          <tr><td>Memory Model:</td><td>Rust Ownership (RAII)</td></tr>
          <tr><td>Concurrency:</td><td>Mutex&lt;VirtualFs&gt;</td></tr>
        </table>
      </div>
    `;
  }

  function renderStatus(stats: SystemStats): void {
    const fields = statusBar.querySelectorAll(".status-bar-field");
    fields[0].textContent = `Processes: ${stats.processes.length}`;
    fields[1].textContent = `Memory: ${formatBytes(stats.estimated_memory)}`;
    fields[2].textContent = `Files: ${stats.total_files}`;
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function getRustVersion(): string {
    return "1.75+ (ownership model)";
  }

  // Initial load + auto-refresh every 2 seconds
  refresh();
  const interval = setInterval(refresh, 2000);

  // Cleanup on window close (observe if container is removed from DOM)
  const observer = new MutationObserver(() => {
    if (!document.contains(container)) {
      clearInterval(interval);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
