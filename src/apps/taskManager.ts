/**
 * MiShell - Task Manager App
 *
 * Windows XP-style Task Manager that shows:
 *   - Processes tab: command history with PID, full command, and memory
 *   - Performance tab: memory usage visualization with animated bar chart
 *     and clear breakdown of WHERE memory is allocated (file data vs
 *     node overhead vs history strings)
 *   - System tab: filesystem stats + system info
 *
 * PHASE 5 (Academic Rubric):
 * This visually demonstrates Rust's ownership-based memory management.
 * Every byte shown is OWNED by a Rust struct — no manual free() needed.
 * When a file is deleted or history is cleared, memory is freed automatically
 * via Rust's Drop trait (equivalent to RAII in C++).
 *
 * All data comes from the Rust backend via get_system_stats IPC command.
 * Refreshes every 2 seconds to show real-time changes.
 */

import { invoke } from "@tauri-apps/api/core";

interface ProcessInfo {
  pid: number;
  name: string;
  full_command: string;
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
  file_data_bytes: number;
  node_overhead_bytes: number;
  history_memory_bytes: number;
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

  // AI analysis state
  let isAnalyzingAI   = false;
  let lastAIDiagnosis = "";
  let lastStats: SystemStats | null = null;
  let streamGen = 0;

  // Refresh data
  async function refresh(): Promise<void> {
    try {
      const stats: SystemStats = await invoke("get_system_stats");
      lastStats = stats;
      const memKB = Math.round(stats.estimated_memory / 1024);
      memoryHistory.push(memKB);
      if (memoryHistory.length > MAX_HISTORY) memoryHistory.shift();
      renderProcesses(stats);
      renderPerformance(stats);
      renderSystem(stats);
      renderStatus(stats);
    } catch (_err) {
      // silently retry next tick
    }
  }

  function attachAIButton(containerEl: HTMLElement, _stats: SystemStats): void {
    if (lastAIDiagnosis) {
      const panel = containerEl.querySelector("#tm-ai-panel");
      if (panel) panel.textContent = lastAIDiagnosis;
    }

    const aiBtn = containerEl.querySelector<HTMLButtonElement>("#tm-ai-btn");
    if (aiBtn && !isAnalyzingAI) {
      aiBtn.addEventListener("click", async () => {
        if (!lastStats || isAnalyzingAI) return;
        const gen = ++streamGen;
        isAnalyzingAI   = true;
        lastAIDiagnosis = "";
        renderPerformance(lastStats);
        renderProcesses(lastStats);
        renderSystem(lastStats);

        const { analyzeTaskManager, logSessionEvent } = await import("../ai/aiService");
        const history: string[] = await invoke("get_history");

        analyzeTaskManager(
          {
            fileDataBytes:      lastStats.file_data_bytes,
            nodeOverheadBytes:  lastStats.node_overhead_bytes,
            historyMemoryBytes: lastStats.history_memory_bytes,
            recentCommands:     history.slice(-8),
          },
          (token) => {
            if (gen !== streamGen) return;
            lastAIDiagnosis += token;
            for (const panel of document.querySelectorAll("#tm-ai-panel")) {
              panel.textContent = lastAIDiagnosis;
            }
          },
          () => {
            if (gen !== streamGen) return;
            isAnalyzingAI = false;
            if (lastStats) {
              renderPerformance(lastStats);
              renderProcesses(lastStats);
              renderSystem(lastStats);
            }
            logSessionEvent({
              type: "memory",
              data: {
                fileDataBytes:      lastStats!.file_data_bytes,
                nodeOverheadBytes:  lastStats!.node_overhead_bytes,
                historyMemoryBytes: lastStats!.history_memory_bytes,
              },
            });
          },
          (err) => {
            if (gen !== streamGen) return;
            lastAIDiagnosis = `⚠️ ${err}`;
            isAnalyzingAI   = false;
            if (lastStats) {
              renderPerformance(lastStats);
              renderProcesses(lastStats);
              renderSystem(lastStats);
            }
          },
        );
      });
    }
  }

  function renderProcesses(stats: SystemStats): void {
    const procs = stats.processes;
    processesPanel.innerHTML = `
      <table class="tm-table">
        <thead>
          <tr>
            <th>PID</th>
            <th>Command</th>
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
            <tr>
              <td>${p.pid}</td>
              <td title="${p.full_command}">${p.full_command}</td>
              <td>${p.memory_kb} KB</td>
              <td><span class="tm-status-finished">${p.status}</span></td>
            </tr>`
                )
                .join("")
          }
        </tbody>
      </table>
      <div style="margin-top:8px;padding:4px 0;">
        <button id="tm-ai-btn" style="background:#d4d0c8;border:2px outset #fff;padding:3px 10px;font-size:11px;cursor:pointer;width:100%;margin-top:4px;" ${isAnalyzingAI ? 'disabled' : ''}>
          ${isAnalyzingAI ? '🤖 Analizando...' : '🤖 Analizar con IA'}
        </button>
        ${isAnalyzingAI || lastAIDiagnosis ? '<div id="tm-ai-panel" style="margin-top:8px;padding:8px;background:#fffff0;border:1px solid #8855dd;border-radius:2px;color:#333;font-size:10px;line-height:1.6;white-space:pre-wrap;word-break:break-word;"></div>' : ''}
      </div>
    `;

    attachAIButton(processesPanel, stats);
  }

  function renderPerformance(stats: SystemStats): void {
    const maxMem = Math.max(...memoryHistory, 1);
    const chartHeight = 120;

    // Build bar chart
    const bars = memoryHistory
      .map((val) => {
        const h = Math.max(2, (val / maxMem) * chartHeight);
        return `<div class="tm-bar" style="height:${h}px"></div>`;
      })
      .join("");

    // Calculate percentages for the visual breakdown
    const total = stats.estimated_memory || 1;
    const filePct = Math.round((stats.file_data_bytes / total) * 100);
    const nodePct = Math.round((stats.node_overhead_bytes / total) * 100);
    const histPct = Math.round((stats.history_memory_bytes / total) * 100);

    performancePanel.innerHTML = `
      <div class="tm-perf-section">
        <div class="tm-perf-header">Memory Usage Over Time</div>
        <div class="tm-chart-container">
          <div class="tm-chart-label">${maxMem} KB</div>
          <div class="tm-chart">
            ${bars}
          </div>
          <div class="tm-chart-label">0 KB</div>
        </div>

        <div class="tm-perf-header" style="margin-top:12px;">Memory Breakdown (Rust Ownership Model)</div>
        <div class="tm-perf-stats">
          <div class="tm-perf-row">
            <span>Total Heap Memory:</span>
            <strong>${formatBytes(stats.estimated_memory)}</strong>
          </div>
          <div class="tm-perf-row">
            <span>Peak:</span>
            <strong>${formatBytes(Math.max(...memoryHistory) * 1024)}</strong>
          </div>
        </div>

        <div class="tm-perf-stats" style="margin-top:6px;">
          <div class="tm-perf-row" style="margin-bottom:4px;">
            <span style="font-weight:bold;">Where is memory allocated?</span>
          </div>
          <div class="tm-perf-row">
            <span>📄 File Data (String content in FsNode::File):</span>
            <strong>${formatBytes(stats.file_data_bytes)} (${filePct}%)</strong>
          </div>
          <div class="tm-mem-bar-container">
            <div class="tm-mem-bar tm-mem-bar-files" style="width:${filePct}%"></div>
          </div>
          <div class="tm-perf-row">
            <span>🗂️ Node Overhead (${stats.total_files + stats.total_dirs} FsNode structs x ~128B):</span>
            <strong>${formatBytes(stats.node_overhead_bytes)} (${nodePct}%)</strong>
          </div>
          <div class="tm-mem-bar-container">
            <div class="tm-mem-bar tm-mem-bar-nodes" style="width:${nodePct}%"></div>
          </div>
          <div class="tm-perf-row">
            <span>📜 History (${stats.history_count} commands x ~24B + chars):</span>
            <strong>${formatBytes(stats.history_memory_bytes)} (${histPct}%)</strong>
          </div>
          <div class="tm-mem-bar-container">
            <div class="tm-mem-bar tm-mem-bar-history" style="width:${histPct}%"></div>
          </div>
        </div>

        <div class="tm-perf-stats" style="margin-top:6px;font-size:10px;color:#666;">
          <em>All memory is owned by Rust structs. When data is deleted (rm, etc.),
          the Drop trait automatically frees memory — no manual free() needed.
          This is equivalent to RAII in C++, but enforced at compile time.</em>
        </div>

        <div style="margin-top:12px;">
          <button id="tm-ai-btn" style="background:#d4d0c8;border:2px outset #fff;padding:3px 10px;font-size:11px;cursor:pointer;width:100%;margin-top:8px;" ${isAnalyzingAI ? 'disabled' : ''}>
            ${isAnalyzingAI ? '🤖 Analizando...' : '🤖 Analizar con IA'}
          </button>
          ${isAnalyzingAI || lastAIDiagnosis ? `<div id="tm-ai-panel" style="margin-top:8px;padding:8px;background:#fffff0;border:1px solid #8855dd;border-radius:2px;color:#333;font-size:10px;line-height:1.6;white-space:pre-wrap;word-break:break-word;"></div>` : ''}
        </div>
      </div>
    `;

    attachAIButton(performancePanel, stats);
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
          <div class="tm-sys-label">File Data</div>
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
          <tr><td>Kernel:</td><td>Rust (ownership model)</td></tr>
          <tr><td>Shell:</td><td>MiShell v2.0</td></tr>
          <tr><td>Backend:</td><td>Tauri v2 + Rust</td></tr>
          <tr><td>Frontend:</td><td>TypeScript + XP.css</td></tr>
          <tr><td>Filesystem:</td><td>Virtual (Sandboxed, JSON-backed)</td></tr>
          <tr><td>Memory Model:</td><td>Rust Ownership (RAII, no manual free)</td></tr>
          <tr><td>Concurrency:</td><td>Mutex&lt;VirtualFs&gt; (thread-safe)</td></tr>
        </table>
      </div>

      <div style="margin-top:8px;padding:4px 0;">
        <button id="tm-ai-btn" style="background:#d4d0c8;border:2px outset #fff;padding:3px 10px;font-size:11px;cursor:pointer;width:100%;margin-top:4px;" ${isAnalyzingAI ? 'disabled' : ''}>
          ${isAnalyzingAI ? '🤖 Analizando...' : '🤖 Analizar con IA'}
        </button>
        ${isAnalyzingAI || lastAIDiagnosis ? '<div id="tm-ai-panel" style="margin-top:8px;padding:8px;background:#fffff0;border:1px solid #8855dd;border-radius:2px;color:#333;font-size:10px;line-height:1.6;white-space:pre-wrap;word-break:break-word;"></div>' : ''}
      </div>
    `;

    attachAIButton(systemPanel, stats);
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
