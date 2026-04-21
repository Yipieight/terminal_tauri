/**
 * MiShell - CPU Scheduler Visualizer
 *
 * Animated visualization of CPU scheduling algorithms showing:
 *   - Process state transitions: New → Ready → Running → Terminated
 *   - Gantt chart building in real time
 *   - Per-process stats: wait time, turnaround time
 *
 * Supported algorithms:
 *   fifo      — First Come, First Served (FCFS)
 *   sjf       — Shortest Job First (non-preemptive)
 *   rr        — Round Robin (configurable quantum)
 *   priority  — Priority Scheduling (non-preemptive, lower = higher priority)
 *
 * Terminal usage:
 *   sched              → show algorithm list
 *   sched fifo         → launch FIFO visualizer
 *   sched rr 3         → Round Robin with quantum=3
 *   sched sjf          → Shortest Job First
 *   sched priority     → Priority Scheduling
 */

// ── Types ────────────────────────────────────────────────────────────────

export type SchedAlgo = "fifo" | "sjf" | "rr" | "priority";

export const SCHED_ALGO_NAMES: Record<SchedAlgo, string> = {
  fifo:     "FIFO — First Come, First Served",
  sjf:      "SJF — Shortest Job First",
  rr:       "Round Robin",
  priority: "Priority Scheduling",
};

const SCHED_ALGO_DESC: Record<SchedAlgo, string> = {
  fifo:     "Los procesos se ejecutan en orden de llegada. Simple pero puede causar efecto convoy.",
  sjf:      "Se elige el proceso con menor tiempo de burst. Minimiza el tiempo promedio de espera.",
  rr:       "Cada proceso recibe un quantum de tiempo. Equitativo para todos los procesos.",
  priority: "Se elige el proceso con mayor prioridad (numero mas bajo). Puede causar inanicion.",
};

const PROC_COLORS = ["#DC3232", "#3278DC", "#32C850", "#F0B41E", "#B432DC"];

// Fixed reproducible process set (AT=arrival, BT=burst, Pri=priority)
const PROC_DEF = [
  { id: "P1", at: 0, bt: 5, pri: 3 },
  { id: "P2", at: 1, bt: 3, pri: 1 },
  { id: "P3", at: 2, bt: 8, pri: 4 },
  { id: "P4", at: 3, bt: 2, pri: 2 },
  { id: "P5", at: 4, bt: 4, pri: 3 },
];

type ProcState = "new" | "ready" | "running" | "terminated";

interface SchedProcess {
  id: string;
  at: number;
  bt: number;
  pri: number;
  color: string;
  state: ProcState;
  remaining: number;
  waitTime: number;
  turnaround: number;
}

interface GanttSlot {
  pid: string;
  color: string;
  idle: boolean;
}

// ── Schedule computation ─────────────────────────────────────────────────

function computeFIFO(procs: SchedProcess[]): GanttSlot[] {
  const g: GanttSlot[] = [];
  let t = 0;
  for (const p of [...procs].sort((a, b) => a.at - b.at)) {
    while (t < p.at) { g.push({ pid: "IDLE", color: "#3a3a4a", idle: true }); t++; }
    for (let i = 0; i < p.bt; i++) g.push({ pid: p.id, color: p.color, idle: false });
    t += p.bt;
  }
  return g;
}

function computeSJF(procs: SchedProcess[]): GanttSlot[] {
  const g: GanttSlot[] = [];
  const rem = procs.map(p => ({ ...p }));
  let t = 0, done = 0;
  while (done < rem.length) {
    const avail = rem.filter(p => p.at <= t && p.remaining > 0);
    if (!avail.length) { g.push({ pid: "IDLE", color: "#3a3a4a", idle: true }); t++; continue; }
    const p = avail.sort((a, b) => a.remaining - b.remaining)[0];
    for (let i = 0; i < p.remaining; i++) g.push({ pid: p.id, color: p.color, idle: false });
    t += p.remaining; p.remaining = 0; done++;
  }
  return g;
}

function computeRR(procs: SchedProcess[], q: number): GanttSlot[] {
  const g: GanttSlot[] = [];
  const rem = procs.map(p => ({ ...p }));
  const sorted = [...rem].sort((a, b) => a.at - b.at);
  const queue: typeof rem[0][] = [];
  let t = 0, idx = 0, done = 0;
  while (done < rem.length) {
    while (idx < sorted.length && sorted[idx].at <= t) queue.push(sorted[idx++]);
    if (!queue.length) {
      if (idx >= sorted.length) break;
      g.push({ pid: "IDLE", color: "#3a3a4a", idle: true }); t++; continue;
    }
    const p = queue.shift()!;
    const slice = Math.min(q, p.remaining);
    for (let i = 0; i < slice; i++) g.push({ pid: p.id, color: p.color, idle: false });
    t += slice; p.remaining -= slice;
    while (idx < sorted.length && sorted[idx].at <= t) queue.push(sorted[idx++]);
    if (p.remaining > 0) queue.push(p); else done++;
  }
  return g;
}

function computePriority(procs: SchedProcess[]): GanttSlot[] {
  const g: GanttSlot[] = [];
  const rem = procs.map(p => ({ ...p }));
  let t = 0, done = 0;
  while (done < rem.length) {
    const avail = rem.filter(p => p.at <= t && p.remaining > 0);
    if (!avail.length) { g.push({ pid: "IDLE", color: "#3a3a4a", idle: true }); t++; continue; }
    const p = avail.sort((a, b) => a.pri - b.pri)[0];
    for (let i = 0; i < p.remaining; i++) g.push({ pid: p.id, color: p.color, idle: false });
    t += p.remaining; p.remaining = 0; done++;
  }
  return g;
}

function computeSchedule(procs: SchedProcess[], algo: SchedAlgo, q: number): GanttSlot[] {
  switch (algo) {
    case "fifo":     return computeFIFO(procs);
    case "sjf":      return computeSJF(procs);
    case "rr":       return computeRR(procs, q);
    case "priority": return computePriority(procs);
  }
}

/** Pre-compute final wait/turnaround for each process from the full Gantt */
function computeStats(procs: SchedProcess[], gantt: GanttSlot[]): void {
  for (const p of procs) {
    let first = -1, last = -1;
    for (let t = 0; t < gantt.length; t++) {
      if (gantt[t].pid === p.id) { if (first < 0) first = t; last = t; }
    }
    p.turnaround = last >= 0 ? last + 1 - p.at : 0;
    p.waitTime   = p.turnaround - p.bt;
  }
}

// ── Mount function ───────────────────────────────────────────────────────

export function mountScheduler(
  container: HTMLElement,
  algo: SchedAlgo,
  quantum: number,
  _instanceId: string,
): void {
  container.style.display = "flex";
  container.style.flexDirection = "row";
  container.style.background = "#1a1a2e";
  container.style.overflow = "hidden";

  // ── Canvas wrap ──
  const canvasWrap = document.createElement("div");
  canvasWrap.style.cssText = "flex:1;position:relative;overflow:hidden;min-width:0;";
  const canvas = document.createElement("canvas");
  canvasWrap.appendChild(canvas);

  // ── Info panel (reuses thread-visualizer styles) ──
  const infoPanel = document.createElement("div");
  infoPanel.className = "tv-info";

  container.appendChild(canvasWrap);
  container.appendChild(infoPanel);

  const ctx = canvas.getContext("2d")!;
  let W = 520, H = 380;
  let running = true;
  let animId = 0;
  let frame = 0;

  // ── Simulation state ──
  let procs: SchedProcess[] = [];
  let gantt: GanttSlot[] = [];
  let animTime = 0;
  let speed = 0.025;
  let statsShown = false;
  const Q = quantum > 0 ? quantum : 2;

  // ── State colors / labels ──
  const STATE_COLOR: Record<ProcState, string> = {
    new:        "#666688",
    ready:      "#F0B41E",
    running:    "#32C850",
    terminated: "#3278DC",
  };
  const STATE_LABEL: Record<ProcState, string> = {
    new:        "NEW",
    ready:      "READY",
    running:    "RUN",
    terminated: "DONE",
  };

  // ── Init ──────────────────────────────────────────────────────────────────
  function makeProcs(): SchedProcess[] {
    return PROC_DEF.map((d, i) => ({
      id: d.id, at: d.at, bt: d.bt, pri: d.pri,
      color: PROC_COLORS[i],
      state: "new" as ProcState,
      remaining: d.bt,
      waitTime: 0,
      turnaround: 0,
    }));
  }

  function init(): void {
    procs = makeProcs();
    gantt = computeSchedule(procs, algo, Q);
    computeStats(procs, gantt);
    animTime = 0;
    statsShown = false;
  }

  function resize(): void {
    const rect = canvasWrap.getBoundingClientRect();
    W = Math.max(Math.floor(rect.width), 280);
    H = Math.max(Math.floor(rect.height), 200);
    canvas.width = W;
    canvas.height = H;
  }

  // ── Update process states from current animation time ──────────────────
  function updateStates(): void {
    const t = Math.floor(animTime);
    const currentPid = gantt[t]?.pid ?? null;
    for (const p of procs) {
      const runCount = gantt.slice(0, t + 1).filter(g => g.pid === p.id).length;
      p.remaining = Math.max(0, p.bt - runCount);
      if (p.remaining === 0 && runCount > 0) {
        p.state = "terminated";
      } else if (p.id === currentPid) {
        p.state = "running";
      } else if (p.at <= t) {
        p.state = "ready";
      } else {
        p.state = "new";
      }
    }
  }

  // ── Renderers ────────────────────────────────────────────────────────────
  function renderBg(): void {
    ctx.fillStyle = "#2d2d3d";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(255,255,255,0.03)";
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
  }

  function renderHeader(): void {
    ctx.fillStyle = "rgba(10,10,25,0.9)";
    ctx.fillRect(0, 0, W, 30);
    ctx.fillStyle = "#D0D0FF";
    ctx.font = "bold 12px monospace";
    ctx.textAlign = "left";
    ctx.fillText(`CPU Scheduler — ${SCHED_ALGO_NAMES[algo]}`, 10, 20);
    if (algo === "rr") {
      ctx.fillStyle = "#F0B41E";
      ctx.textAlign = "right";
      ctx.fillText(`Q = ${Q}`, W - 10, 20);
    } else {
      const t = Math.floor(animTime);
      ctx.fillStyle = "#555";
      ctx.textAlign = "right";
      ctx.fillText(`t = ${t}`, W - 10, 20);
    }
  }

  function renderProcessCards(): void {
    const n = procs.length;
    const CARD_W = Math.min(Math.floor((W - 20) / n), 90);
    const TOTAL_W = CARD_W * n;
    const startX = Math.floor((W - TOTAL_W) / 2);
    const CARD_Y = 34;
    const CARD_H = H - 34 - 115; // leave 115px at bottom for Gantt
    const MIN_H = 80;
    const ch = Math.max(CARD_H, MIN_H);

    for (let i = 0; i < n; i++) {
      const p = procs[i];
      const cx = startX + i * CARD_W;
      const sc = STATE_COLOR[p.state];
      const isRunning = p.state === "running";

      // Card body
      ctx.fillStyle = isRunning ? `${p.color}20` : "rgba(0,0,0,0.38)";
      ctx.fillRect(cx + 2, CARD_Y, CARD_W - 4, ch);

      // Top accent bar (process color)
      ctx.fillStyle = p.color;
      ctx.fillRect(cx + 2, CARD_Y, CARD_W - 4, 3);

      // Running glow
      if (isRunning) {
        ctx.save();
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 18;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(cx + 2, CARD_Y, CARD_W - 4, ch);
        ctx.restore();
      }

      // Process ID
      ctx.fillStyle = p.color;
      ctx.font = `bold ${Math.min(18, CARD_W / 4)}px monospace`;
      ctx.textAlign = "center";
      ctx.fillText(p.id, cx + CARD_W / 2, CARD_Y + 22);

      // State badge
      ctx.fillStyle = sc + "33";
      ctx.fillRect(cx + 5, CARD_Y + 27, CARD_W - 10, 16);
      ctx.fillStyle = sc;
      ctx.font = "bold 8px monospace";
      ctx.textAlign = "center";
      ctx.fillText(STATE_LABEL[p.state], cx + CARD_W / 2, CARD_Y + 39);

      // Info rows
      if (ch >= 100) {
        const lx = cx + 6;
        ctx.fillStyle = "#999";
        ctx.font = "8px monospace";
        ctx.textAlign = "left";
        ctx.fillText(`AT:  ${p.at}`, lx, CARD_Y + 56);
        ctx.fillText(`BT:  ${p.bt}`, lx, CARD_Y + 67);
        ctx.fillText(`Pri: ${p.pri}`, lx, CARD_Y + 78);

        // Progress bar
        const barY = CARD_Y + 87;
        const barW = CARD_W - 12;
        const pct = p.bt > 0 ? (p.bt - p.remaining) / p.bt : 1;
        ctx.fillStyle = "#2a2a3a";
        ctx.fillRect(lx, barY, barW, 7);
        ctx.fillStyle = p.state === "terminated" ? "#3278DC" : p.color;
        ctx.fillRect(lx, barY, barW * pct, 7);
        ctx.fillStyle = "#666";
        ctx.font = "7px monospace";
        ctx.textAlign = "center";
        ctx.fillText(`${p.bt - p.remaining}/${p.bt}`, cx + CARD_W / 2, barY + 16);

        // Stats if terminated
        if (p.state === "terminated" && ch > 120) {
          const sy = barY + 26;
          ctx.fillStyle = "#5588FF";
          ctx.font = "8px monospace";
          ctx.textAlign = "left";
          ctx.fillText(`W=${p.waitTime}`, lx, sy);
          ctx.fillText(`T=${p.turnaround}`, lx + 30, sy);
        }
      }
    }
  }

  function renderGanttChart(): void {
    const GANTT_Y = H - 110;
    const GANTT_H = 28;
    const t = Math.floor(animTime);

    // Dark backdrop
    ctx.fillStyle = "rgba(10,10,25,0.85)";
    ctx.fillRect(0, GANTT_Y - 20, W, H - GANTT_Y + 20);

    ctx.fillStyle = "#999";
    ctx.font = "9px monospace";
    ctx.textAlign = "left";
    ctx.fillText("Diagrama de Gantt:", 8, GANTT_Y - 7);

    // Sliding window: ~60 slots visible
    const WIN = Math.max(10, Math.floor((W - 16) / 12));
    const visStart = Math.max(0, t - Math.floor(WIN * 0.7));
    const visEnd   = Math.min(gantt.length, visStart + WIN);
    const slotW    = (W - 16) / WIN;

    for (let i = visStart; i < visEnd; i++) {
      if (!gantt[i]) continue;
      const g = gantt[i];
      const x = 8 + (i - visStart) * slotW;
      const isCurrent = i === t;
      ctx.fillStyle = g.idle
        ? (isCurrent ? "#666" : "#333")
        : (isCurrent ? g.color : g.color + "90");
      ctx.fillRect(x, GANTT_Y, slotW - 1, GANTT_H);
      if (slotW >= 10) {
        ctx.fillStyle = isCurrent ? "#FFF" : "#DDD";
        ctx.font = `bold ${Math.min(9, slotW - 2)}px monospace`;
        ctx.textAlign = "center";
        ctx.fillText(g.idle ? "—" : g.pid, x + slotW / 2, GANTT_Y + 19);
      }
    }

    // Time axis labels (every 5)
    ctx.fillStyle = "#555";
    ctx.font = "8px monospace";
    for (let i = visStart; i <= visEnd; i += 5) {
      const x = 8 + (i - visStart) * slotW;
      ctx.textAlign = "center";
      ctx.fillText(i.toString(), x, GANTT_Y + GANTT_H + 12);
      ctx.strokeStyle = "#333";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, GANTT_Y + GANTT_H); ctx.lineTo(x, GANTT_Y + GANTT_H + 4); ctx.stroke();
    }

    // Current-time cursor (▼ + vertical line)
    const curX = 8 + (t - visStart) * slotW + slotW / 2;
    ctx.strokeStyle = "#FFFFFF";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(curX, GANTT_Y - 14);
    ctx.lineTo(curX, GANTT_Y + GANTT_H + 2);
    ctx.stroke();
    ctx.fillStyle = "#FFF";
    ctx.font = "11px monospace";
    ctx.textAlign = "center";
    ctx.fillText("▼", curX, GANTT_Y - 16);

    // Legend
    const legY = H - 15;
    const legendItems: [string, string][] = [
      ["NEW",   "#666688"],
      ["READY", "#F0B41E"],
      ["RUN",   "#32C850"],
      ["DONE",  "#3278DC"],
      ["IDLE",  "#3a3a4a"],
    ];
    let lx = 8;
    for (const [label, color] of legendItems) {
      ctx.fillStyle = color;
      ctx.fillRect(lx, legY - 8, 8, 8);
      ctx.fillStyle = "#888";
      ctx.font = "8px monospace";
      ctx.textAlign = "left";
      ctx.fillText(label, lx + 10, legY);
      lx += label.length * 5 + 20;
    }
  }

  function renderStatsOverlay(): void {
    // Full-screen stats
    ctx.fillStyle = "rgba(18,18,36,0.96)";
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = "#50FF78";
    ctx.font = "bold 16px monospace";
    ctx.textAlign = "center";
    ctx.fillText("✓ Planificacion completada", W / 2, 38);

    ctx.fillStyle = "#D0D0FF";
    ctx.font = "12px monospace";
    ctx.fillText(SCHED_ALGO_NAMES[algo], W / 2, 58);
    if (algo === "rr") {
      ctx.fillStyle = "#F0B41E";
      ctx.font = "11px monospace";
      ctx.fillText(`Quantum = ${Q}`, W / 2, 74);
    }

    // Table header
    const th = algo === "rr" ? 95 : 82;
    ctx.fillStyle = "#444";
    ctx.fillRect(20, th - 4, W - 40, 1);
    const COLS = [
      { h: "PID",     x: 28  },
      { h: "Llegada", x: 78  },
      { h: "Burst",   x: 138 },
      { h: "Espera",  x: 195 },
      { h: "Retorno", x: 255 },
      { h: "Estado",  x: 315 },
    ];
    ctx.font = "bold 9px monospace";
    ctx.textAlign = "left";
    for (const c of COLS) {
      ctx.fillStyle = "#AAA";
      ctx.fillText(c.h, c.x, th + 10);
    }

    for (let r = 0; r < procs.length; r++) {
      const p = procs[r];
      const y = th + 24 + r * 18;
      const row = [p.id, p.at, p.bt, p.waitTime, p.turnaround, "DONE"];
      ctx.fillStyle = "#555";
      ctx.fillRect(20, y - 12, W - 40, 1);
      for (let c2 = 0; c2 < COLS.length; c2++) {
        ctx.fillStyle = c2 === 0 ? p.color : (c2 === 3 ? "#F0B41E" : (c2 === 4 ? "#32D2D2" : "#CCC"));
        ctx.fillText(String(row[c2]), COLS[c2].x, y);
      }
    }

    // Averages
    const n = procs.length;
    const avgW = (procs.reduce((s, p) => s + p.waitTime,    0) / n).toFixed(2);
    const avgT = (procs.reduce((s, p) => s + p.turnaround, 0) / n).toFixed(2);
    const statsY = th + 24 + n * 18 + 18;
    ctx.fillStyle = "#444";
    ctx.fillRect(20, statsY - 10, W - 40, 1);

    ctx.font = "10px monospace";
    ctx.textAlign = "left";
    ctx.fillStyle = "#888";
    ctx.fillText("Promedio Espera:", 28, statsY + 6);
    ctx.fillStyle = "#F0B41E";
    ctx.font = "bold 16px monospace";
    ctx.fillText(avgW, 28, statsY + 24);

    ctx.fillStyle = "#888";
    ctx.font = "10px monospace";
    ctx.fillText("Promedio Retorno:", 155, statsY + 6);
    ctx.fillStyle = "#32D2D2";
    ctx.font = "bold 16px monospace";
    ctx.fillText(avgT, 155, statsY + 24);

    ctx.fillStyle = "#444";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText("Presiona SPACE para reiniciar", W / 2, H - 16);
  }

  // ── Info panel (DOM, right side) ─────────────────────────────────────────
  function updateInfoPanel(): void {
    const t = Math.floor(animTime);
    const current = gantt[t];
    const runPid   = current && !current.idle ? current.pid : null;
    const doneCount = procs.filter(p => p.state === "terminated").length;

    // Ready queue list
    const readyList = procs
      .filter(p => p.state === "ready")
      .map(p => `<span style="color:${p.color};font-weight:bold">${p.id}</span>`)
      .join(", ") || `<span style="color:#444">—</span>`;

    // Running process display
    const runProc = runPid ? procs.find(p => p.id === runPid) : null;
    const cpuHtml = runProc
      ? `<div style="font-size:22px;font-weight:bold;color:${runProc.color}">${runProc.id}</div>
         <div style="font-size:9px;color:#32C850;margin-top:2px">EJECUTANDO</div>`
      : `<div style="font-size:12px;color:#444">IDLE</div>`;

    // Partial stats (only finished processes)
    const finished = procs.filter(p => p.state === "terminated");
    const avgW = finished.length > 0
      ? (finished.reduce((s, p) => s + p.waitTime, 0) / finished.length).toFixed(1) : "—";
    const avgT = finished.length > 0
      ? (finished.reduce((s, p) => s + p.turnaround, 0) / finished.length).toFixed(1) : "—";

    infoPanel.innerHTML = `
      <div class="tv-info-title">Scheduler</div>
      <div class="tv-info-primitive">${algo.toUpperCase()}${algo === "rr" ? ` Q=${Q}` : ""}</div>
      <div class="tv-info-desc">${SCHED_ALGO_DESC[algo]}<br><br>
        Estados:<br>
        <span style="color:#666688">⬛ NEW</span> sin llegar<br>
        <span style="color:#F0B41E">⬛ READY</span> en cola<br>
        <span style="color:#32C850">⬛ RUN</span> en CPU<br>
        <span style="color:#3278DC">⬛ DONE</span> terminado
      </div>
      <div class="tv-info-stats">
        <div style="text-align:center;padding:6px 4px;background:rgba(0,0,0,0.45);
             border:1px solid #333;margin:4px 0;min-height:42px;
             display:flex;flex-direction:column;align-items:center;justify-content:center">
          ${cpuHtml}
        </div>
        <div class="tv-stat"><span>Cola:</span><span style="font-size:10px">${readyList}</span></div>
        <div class="tv-stat"><span>Tiempo:</span><strong>t = ${t}</strong></div>
        <div class="tv-stat"><span>Completos:</span><strong>${doneCount}/${procs.length}</strong></div>
        ${finished.length > 0 ? `
        <div class="tv-stat"><span>Avg Espera:</span><strong style="color:#F0B41E">${avgW}</strong></div>
        <div class="tv-stat"><span>Avg Retorno:</span><strong style="color:#32D2D2">${avgT}</strong></div>
        ` : ""}
      </div>
      <div style="margin-top:8px;font-size:9px;color:#555;border-top:1px solid #2a2a3a;padding-top:6px">
        SPACE: reiniciar<br>
        +&nbsp;/&nbsp;−: velocidad
      </div>
    `;
  }

  // ── Main render loop ──────────────────────────────────────────────────────
  function renderFrame(): void {
    if (!running) return;
    frame++;

    if (!statsShown) {
      animTime = Math.min(animTime + speed, gantt.length);
      if (animTime >= gantt.length) {
        statsShown = true;
      } else {
        updateStates();
      }
    }

    renderBg();
    if (statsShown) {
      renderStatsOverlay();
    } else {
      renderHeader();
      renderProcessCards();
      renderGanttChart();
    }

    if (frame % 8 === 0) updateInfoPanel();
    animId = requestAnimationFrame(renderFrame);
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────
  container.setAttribute("tabindex", "0");
  container.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === " ") { e.preventDefault(); init(); }
    if (e.key === "+" || e.key === "=") speed = Math.min(speed * 1.5, 0.5);
    if (e.key === "-")                  speed = Math.max(speed * 0.67, 0.005);
  });

  // ── Start ─────────────────────────────────────────────────────────────────
  const resizeObs = new ResizeObserver(() => resize());
  resizeObs.observe(canvasWrap);
  resize();
  init();
  updateInfoPanel();
  renderFrame();

  // Cleanup when container is removed from DOM
  const cleanupObs = new MutationObserver(() => {
    if (!document.contains(container)) {
      running = false;
      cancelAnimationFrame(animId);
      resizeObs.disconnect();
      cleanupObs.disconnect();
    }
  });
  cleanupObs.observe(document.body, { childList: true, subtree: true });
}
