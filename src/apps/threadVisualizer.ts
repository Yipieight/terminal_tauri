/**
 * MiShell - Thread & Resource Visualizer
 *
 * Interactive visualization of OS concurrency concepts using animated canvas.
 * Each mode runs in its own window. If a window for that mode already exists,
 * it updates the parameters instead of creating a new one.
 *
 * Supports parameterized launch from terminal:
 *   sim semaphore 3   → opens semaphore with 3 permits
 *   sim mutex         → opens mutex visualization
 *   sim semaphore 1   → updates existing semaphore window to 1 permit
 *
 * Terminal commands:
 *   ps                → list open visualizer windows
 *   kill <pid>        → close a visualizer window
 */

// ── Types ────────────────────────────────────────────────────────────────

interface Car {
  x: number; y: number; tx: number; ty: number;
  color: string; label: string; speed: number;
  state: string; visible: boolean; highlight: boolean; angle: number;
  side?: string;
}

export type SimMode = "semaphore" | "mutex" | "monitor" | "critical" | "race" | "deadlock" | "concurrency";

const COLORS = ["#DC3232", "#3278DC", "#32C850", "#F0B41E", "#B432DC", "#FF8232", "#32D2D2", "#DC50A0"];

export const SIM_MODES: SimMode[] = ["semaphore", "mutex", "monitor", "critical", "race", "deadlock", "concurrency"];

export const MODE_NAMES: Record<SimMode, string> = {
  semaphore: "Semaforo", mutex: "Mutex", monitor: "Monitor",
  critical: "Seccion Critica", race: "Condicion de Carrera",
  deadlock: "Deadlock", concurrency: "Concurrencia",
};

const MODE_PRIMITIVES: Record<SimMode, string> = {
  semaphore: "Semaphore(N)", mutex: "Lock()", monitor: "Condition()",
  critical: "Lock() [toggle]", race: "None (sin control)",
  deadlock: "2x Lock()", concurrency: "Thread() x6",
};

const MODE_DESCRIPTIONS: Record<SimMode, string> = {
  semaphore: "Un semaforo contador controla cuantos hilos pueden acceder al recurso simultaneamente. Los hilos esperan hasta que haya permisos disponibles.\n\nUP/DOWN: ajustar permisos\nSPACE: reiniciar",
  mutex: "Un mutex (exclusion mutua) permite que solo UN hilo acceda al recurso a la vez. Los demas esperan en cola.\n\nSPACE: reiniciar",
  monitor: "Un monitor usa variables de condicion para auto-gestionar el acceso. Los hilos son notificados automaticamente cuando el recurso esta libre.\n\nSPACE: reiniciar",
  critical: "Una seccion critica es una zona de codigo que debe ser protegida. Sin proteccion, multiples hilos pueden causar errores.\n\nENTER: toggle proteccion\nSPACE: reiniciar",
  race: "Una condicion de carrera ocurre cuando dos hilos acceden al mismo recurso sin sincronizacion. El resultado es impredecible.\n\nSPACE: reiniciar",
  deadlock: "Un deadlock ocurre cuando dos hilos se bloquean mutuamente esperando recursos que el otro tiene.\n\nSPACE: reiniciar",
  concurrency: "Concurrencia real: multiples hilos ejecutandose independientemente sin recursos compartidos.\n\nSPACE: reiniciar",
};

// ── Active instances registry (for ps/kill) ──────────────────────────────

interface SimInstance {
  mode: SimMode;
  param: number;
  updateParam: (p: number) => void;
  restart: () => void;
  destroy: () => void;
}

const activeInstances: Map<string, SimInstance> = new Map();

export function getActiveSimulations(): Map<string, SimInstance> {
  return activeInstances;
}

// ── Car helpers ──────────────────────────────────────────────────────────

function createCar(x: number, y: number, color: string, label: string, speed: number): Car {
  return { x, y, tx: x, ty: y, color, label, speed, state: "idle", visible: true, highlight: false, angle: 0 };
}

function moveCar(c: Car): void {
  const dx = c.tx - c.x;
  const dy = c.ty - c.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > 1) {
    c.x += (dx / dist) * c.speed;
    c.y += (dy / dist) * c.speed;
    c.angle = Math.atan2(dy, dx);
  }
}

function carArrived(c: Car): boolean {
  return Math.abs(c.tx - c.x) < 2 && Math.abs(c.ty - c.y) < 2;
}

function goTo(c: Car, x: number, y: number): void { c.tx = x; c.ty = y; }

function drawCar(ctx: CanvasRenderingContext2D, c: Car): void {
  if (!c.visible) return;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(c.angle);
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.fillRect(-18, -8, 36, 18);
  ctx.fillStyle = c.color;
  ctx.beginPath(); ctx.roundRect(-16, -9, 32, 18, 4); ctx.fill();
  ctx.strokeStyle = c.highlight ? "#FFD700" : "#333";
  ctx.lineWidth = c.highlight ? 2.5 : 1;
  ctx.stroke();
  ctx.fillStyle = "rgba(150,200,255,0.5)";
  ctx.fillRect(4, -7, 10, 14);
  ctx.fillStyle = "#FFE";
  ctx.fillRect(14, -6, 3, 4); ctx.fillRect(14, 2, 3, 4);
  ctx.fillStyle = "#F44";
  ctx.fillRect(-17, -6, 3, 4); ctx.fillRect(-17, 2, 3, 4);
  if (c.highlight) {
    ctx.shadowColor = "#FFD700"; ctx.shadowBlur = 12;
    ctx.strokeStyle = "#FFD700"; ctx.lineWidth = 2;
    ctx.strokeRect(-16, -9, 32, 18); ctx.shadowBlur = 0;
  }
  ctx.restore();
  ctx.fillStyle = "#FFF"; ctx.font = "bold 9px monospace"; ctx.textAlign = "center";
  ctx.fillText(c.label, c.x, c.y - 14);
}

// ══════════════════════════════════════════════════════════════════════════
// MOUNT FUNCTION — Creates a single-mode visualizer in a container
// ══════════════════════════════════════════════════════════════════════════

export function mountSingleMode(container: HTMLElement, mode: SimMode, param: number, instanceId: string): void {
  container.style.display = "flex";
  container.style.flexDirection = "row";
  container.style.background = "#1a1a2e";
  container.style.overflow = "hidden";

  // Canvas
  const canvasWrap = document.createElement("div");
  canvasWrap.className = "tv-canvas-wrap";
  const canvas = document.createElement("canvas");
  canvas.className = "tv-canvas";
  canvasWrap.appendChild(canvas);

  // Info panel
  const info = document.createElement("div");
  info.className = "tv-info";

  container.appendChild(canvasWrap);
  container.appendChild(info);

  const ctx = canvas.getContext("2d")!;
  let W = 560, H = 360;
  let frame = 0;
  let animId = 0;
  let running = true;

  // ── Mode-specific state ──
  let cars: Car[] = [];
  let semPermits = param || 3;
  let semMax = param || 3;
  let semActive = 0;
  let mutLocked = false;
  let mutOwner = "";
  let monBusy = false;
  let monProcessor = "";
  let secProtected = true;
  let secFlash = 0;
  let secInZone = 0;
  let racePhase = "run";
  let raceTimer = 0;
  let deadlocked = false;
  let deadTimer = 0;
  let isAnalyzing  = false;
  let lastAnalysis = "";

  function resize(): void {
    const rect = canvasWrap.getBoundingClientRect();
    W = Math.floor(rect.width) || 560;
    H = Math.floor(rect.height) || 360;
    canvas.width = W; canvas.height = H;
  }

  // ── Initializers ──

  function initSemaphore(): void {
    semPermits = semMax; semActive = 0; cars = [];
    const count = Math.min(semMax + 2, 7);
    for (let i = 0; i < count; i++) {
      const c = createCar(40, 40 + i * (H - 80) / (count - 1), COLORS[i], `H${i + 1}`, 1.5 + Math.random() * 0.5);
      c.state = "drive"; goTo(c, W * 0.3, c.y); cars.push(c);
    }
  }

  function initMutex(): void {
    mutLocked = false; mutOwner = ""; cars = [];
    for (let i = 0; i < 4; i++) {
      const side = i < 2 ? "left" : "right";
      const x = side === "left" ? 40 : W - 40;
      const y = 100 + (i % 2) * 100;
      const c = createCar(x, y, COLORS[i], `H${i + 1}`, 1.8);
      c.state = "approach"; c.side = side;
      goTo(c, side === "left" ? W * 0.3 : W * 0.7, y); cars.push(c);
    }
  }

  function initMonitor(): void {
    monBusy = false; monProcessor = ""; cars = [];
    for (let i = 0; i < 4; i++) {
      const c = createCar(40, 70 + i * 70, COLORS[i], `H${i + 1}`, 1.6);
      c.state = "drive"; goTo(c, W * 0.35, 70 + i * 70); cars.push(c);
    }
  }

  function initCritical(): void {
    secProtected = true; secFlash = 0; secInZone = 0; cars = [];
    for (let i = 0; i < 4; i++) {
      const c = createCar(40, 70 + i * 70, COLORS[i], `H${i + 1}`, 1.5);
      c.state = "approach"; goTo(c, W * 0.28, 70 + i * 70); cars.push(c);
    }
  }

  function initRace(): void {
    racePhase = "run"; raceTimer = 0;
    cars = [
      createCar(80, H * 0.3, COLORS[0], "H1", 2.0),
      createCar(80, H * 0.7, COLORS[1], "H2", 2.2),
    ];
    cars[0].state = "race"; cars[1].state = "race";
    goTo(cars[0], W * 0.65, H * 0.5); goTo(cars[1], W * 0.65, H * 0.5);
  }

  function initDeadlock(): void {
    deadlocked = false; deadTimer = 0;
    cars = [
      createCar(W * 0.2, H * 0.5, COLORS[0], "H1", 1.5),
      createCar(W * 0.5, H * 0.15, COLORS[1], "H2", 1.5),
    ];
    cars[0].state = "move_h"; cars[1].state = "move_v";
    goTo(cars[0], W * 0.42, H * 0.5); goTo(cars[1], W * 0.5, H * 0.42);
  }

  function initConcurrency(): void {
    cars = [];
    const count = param >= 2 ? Math.min(param, 8) : 6;
    for (let i = 0; i < count; i++) {
      const c = createCar(30 + Math.random() * 40, 30 + i * ((H - 60) / (count - 1)), COLORS[i % 8], `H${i + 1}`, 1.0 + Math.random() * 2.0);
      c.state = "running"; goTo(c, W - 50, c.y); cars.push(c);
    }
  }

  function initMode(): void {
    switch (mode) {
      case "semaphore": initSemaphore(); break;
      case "mutex": initMutex(); break;
      case "monitor": initMonitor(); break;
      case "critical": initCritical(); break;
      case "race": initRace(); break;
      case "deadlock": initDeadlock(); break;
      case "concurrency": initConcurrency(); break;
    }
  }

  // ── Updaters ──

  function updateSemaphore(): void {
    for (const c of cars) {
      moveCar(c);
      if (c.state === "drive" && carArrived(c)) c.state = "wait";
      if (c.state === "wait" && semPermits > 0) {
        semPermits--; semActive++; c.state = "cross"; c.highlight = true; goTo(c, W * 0.75, c.y);
      }
      if (c.state === "cross" && carArrived(c)) {
        c.state = "exit"; c.highlight = false; semPermits++; semActive--; goTo(c, W + 30, c.y);
      }
      if (c.state === "exit" && carArrived(c)) { c.state = "done"; c.visible = false; }
    }
    if (cars.every(c => c.state === "done")) setTimeout(initSemaphore, 800);
  }

  function updateMutex(): void {
    for (const c of cars) {
      moveCar(c);
      if (c.state === "approach" && carArrived(c)) c.state = "wait";
      if (c.state === "wait" && !mutLocked) {
        mutLocked = true; mutOwner = c.label; c.state = "bridge"; c.highlight = true;
        goTo(c, c.side === "left" ? W * 0.7 : W * 0.3, c.y);
      }
      if (c.state === "bridge" && carArrived(c)) {
        c.state = "exit"; c.highlight = false; mutLocked = false; mutOwner = "";
        goTo(c, c.side === "left" ? W + 30 : -30, c.y);
      }
      if (c.state === "exit" && carArrived(c)) { c.state = "done"; c.visible = false; }
    }
    if (cars.every(c => c.state === "done")) setTimeout(initMutex, 800);
  }

  function updateMonitor(): void {
    for (const c of cars) {
      moveCar(c);
      if (c.state === "drive" && carArrived(c)) c.state = "wait";
      if (c.state === "wait" && !monBusy) {
        monBusy = true; monProcessor = c.label; c.state = "process"; c.highlight = true; goTo(c, W * 0.6, c.y);
      }
      if (c.state === "process" && carArrived(c)) { c.state = "done_wait"; goTo(c, W * 0.85, c.y); }
      if (c.state === "done_wait" && carArrived(c)) {
        monBusy = false; monProcessor = ""; c.state = "exit"; c.highlight = false; goTo(c, W + 30, c.y);
      }
      if (c.state === "exit" && carArrived(c)) { c.state = "done"; c.visible = false; }
    }
    if (cars.every(c => c.state === "done")) setTimeout(initMonitor, 800);
  }

  function updateCritical(): void {
    secInZone = 0;
    const zoneX1 = W * 0.38, zoneX2 = W * 0.68;
    for (const c of cars) {
      moveCar(c);
      if (c.state === "approach" && carArrived(c)) c.state = "wait";
      if (c.state === "wait") {
        if (secProtected) { if (secInZone === 0) { c.state = "enter"; c.highlight = true; goTo(c, W * 0.55, c.y); } }
        else { c.state = "enter"; c.highlight = true; goTo(c, W * 0.55, c.y); }
      }
      if (c.state === "enter" && c.x > zoneX1 && c.x < zoneX2) secInZone++;
      if (c.state === "enter" && carArrived(c)) { c.state = "exit"; c.highlight = false; goTo(c, W + 30, c.y); }
      if (c.state === "exit" && carArrived(c)) { c.state = "done"; c.visible = false; }
    }
    if (!secProtected && secInZone > 1) secFlash = 20;
    if (secFlash > 0) secFlash--;
    if (cars.every(c => c.state === "done")) setTimeout(initCritical, 800);
  }

  function updateRace(): void {
    if (racePhase === "run") {
      for (const c of cars) moveCar(c);
      if (carArrived(cars[0]) && carArrived(cars[1])) {
        racePhase = "crash"; raceTimer = 0;
        cars[0].visible = false; cars[1].visible = false;
      }
    } else if (racePhase === "crash") { raceTimer++; if (raceTimer > 120) { racePhase = "reset"; raceTimer = 0; } }
    else if (racePhase === "reset") { raceTimer++; if (raceTimer > 60) initRace(); }
  }

  function updateDeadlock(): void {
    if (!deadlocked) {
      for (const c of cars) moveCar(c);
      if (cars[0].state === "move_h" && carArrived(cars[0])) { cars[0].state = "has_h_wants_v"; goTo(cars[0], W * 0.5, H * 0.5); }
      if (cars[1].state === "move_v" && carArrived(cars[1])) { cars[1].state = "has_v_wants_h"; goTo(cars[1], W * 0.5, H * 0.5); }
      if (cars[0].state === "has_h_wants_v" && cars[1].state === "has_v_wants_h") {
        deadlocked = true; deadTimer = 0;
        cars[0].highlight = true; cars[1].highlight = true;
        goTo(cars[0], cars[0].x, cars[0].y); goTo(cars[1], cars[1].x, cars[1].y);
      }
    } else { deadTimer++; if (deadTimer > 300) initDeadlock(); }
  }

  function updateConcurrency(): void {
    for (const c of cars) { moveCar(c); if (carArrived(c)) { c.x = -20; goTo(c, W + 30, c.y); } }
  }

  // ── Renderers ──

  function renderBg(): void {
    ctx.fillStyle = "#2d2d3d"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(255,255,255,0.05)"; ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  }

  function renderSemaphore(): void {
    const zx = W * 0.35;
    ctx.fillStyle = "rgba(50,200,80,0.12)"; ctx.fillRect(zx, 10, W * 0.4, H - 20);
    ctx.strokeStyle = "#32C850"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.strokeRect(zx, 10, W * 0.4, H - 20); ctx.setLineDash([]);
    ctx.strokeStyle = semPermits > 0 ? "#32C850" : "#DC3232"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(zx, 10); ctx.lineTo(zx, H - 10); ctx.stroke();
    // Counter
    ctx.fillStyle = "rgba(0,0,0,0.7)"; ctx.fillRect(zx - 40, H - 60, 80, 45);
    ctx.fillStyle = semPermits > 0 ? "#50FF78" : "#FF5050";
    ctx.font = "bold 22px monospace"; ctx.textAlign = "center";
    ctx.fillText(`${semPermits}/${semMax}`, zx, H - 28);
    ctx.fillStyle = "#AAA"; ctx.font = "10px monospace"; ctx.fillText("PERMITS", zx, H - 18);
    // Traffic light
    const tlx = zx + 5, tly = 20;
    ctx.fillStyle = "#333"; ctx.fillRect(tlx, tly, 20, 40);
    ctx.fillStyle = semPermits > 0 ? "#32FF50" : "#225522";
    ctx.beginPath(); ctx.arc(tlx + 10, tly + 12, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = semPermits <= 0 ? "#FF3232" : "#552222";
    ctx.beginPath(); ctx.arc(tlx + 10, tly + 30, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#888"; ctx.font = "10px monospace"; ctx.textAlign = "left";
    ctx.fillText("COLA", 10, 20); ctx.fillText("RECURSO", zx + 10, 20);
    for (const c of cars) drawCar(ctx, c);
  }

  function renderMutex(): void {
    const bx1 = W * 0.32, bx2 = W * 0.68;
    ctx.fillStyle = "rgba(80,80,120,0.3)"; ctx.fillRect(bx1, H * 0.3, bx2 - bx1, H * 0.4);
    ctx.strokeStyle = "#6666AA"; ctx.lineWidth = 2; ctx.strokeRect(bx1, H * 0.3, bx2 - bx1, H * 0.4);
    const lockColor = mutLocked ? "#FF5050" : "#50FF78";
    ctx.fillStyle = "rgba(0,0,0,0.7)"; ctx.fillRect(W * 0.35, 15, W * 0.3, 30);
    ctx.fillStyle = lockColor; ctx.font = "bold 13px monospace"; ctx.textAlign = "center";
    ctx.fillText(mutLocked ? `LOCKED (${mutOwner})` : "UNLOCKED", W * 0.5, 35);
    ctx.strokeStyle = mutLocked ? "#FF8C00" : "#32C850"; ctx.lineWidth = 3;
    if (mutLocked) {
      ctx.beginPath(); ctx.moveTo(bx1, H * 0.3); ctx.lineTo(bx1, H * 0.7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(bx2, H * 0.3); ctx.lineTo(bx2, H * 0.7); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(bx1, H * 0.3); ctx.lineTo(bx1, H * 0.45); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(bx2, H * 0.55); ctx.lineTo(bx2, H * 0.7); ctx.stroke();
    }
    ctx.fillStyle = "#888"; ctx.font = "10px monospace"; ctx.textAlign = "center";
    ctx.fillText("PUENTE (RECURSO)", W * 0.5, H * 0.7 + 20);
    for (const c of cars) drawCar(ctx, c);
  }

  function renderMonitor(): void {
    const bx = W * 0.42, bw = W * 0.25;
    ctx.fillStyle = monBusy ? "rgba(50,210,210,0.15)" : "rgba(50,200,80,0.1)";
    ctx.fillRect(bx, 20, bw, H - 40);
    ctx.strokeStyle = monBusy ? "#32D2D2" : "#32C850"; ctx.lineWidth = 2;
    ctx.strokeRect(bx, 20, bw, H - 40);
    if (monBusy) {
      const pulse = Math.sin(frame * 0.08) * 0.3 + 0.5;
      ctx.fillStyle = `rgba(50,210,210,${pulse * 0.3})`;
      ctx.beginPath(); ctx.arc(bx + bw / 2, H / 2, 40 + pulse * 10, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = "rgba(0,0,0,0.7)"; ctx.fillRect(bx + 5, H - 55, bw - 10, 40);
    ctx.fillStyle = monBusy ? "#32D2D2" : "#50FF78";
    ctx.font = "bold 11px monospace"; ctx.textAlign = "center";
    ctx.fillText(monBusy ? `OCUPADO (${monProcessor})` : "LIBRE", bx + bw / 2, H - 35);
    ctx.fillStyle = "#AAA"; ctx.font = "9px monospace";
    ctx.fillText("AUTO-GESTION", bx + bw / 2, H - 22);
    for (const c of cars) drawCar(ctx, c);
  }

  function renderCritical(): void {
    const zx1 = W * 0.35, zx2 = W * 0.7;
    ctx.fillStyle = secFlash > 0 ? `rgba(255,50,50,${secFlash / 20 * 0.4})` : "rgba(255,180,30,0.08)";
    ctx.fillRect(zx1, 20, zx2 - zx1, H - 40);
    ctx.strokeStyle = "rgba(255,180,30,0.3)"; ctx.lineWidth = 2; ctx.setLineDash([8, 8]);
    ctx.strokeRect(zx1, 20, zx2 - zx1, H - 40); ctx.setLineDash([]);
    ctx.fillStyle = "rgba(0,0,0,0.7)"; ctx.fillRect(zx1 + 10, 25, zx2 - zx1 - 20, 28);
    ctx.fillStyle = secProtected ? "#50FF78" : "#FF5050";
    ctx.font = "bold 12px monospace"; ctx.textAlign = "center";
    ctx.fillText(secProtected ? "PROTEGIDO (Lock)" : "SIN PROTECCION", (zx1 + zx2) / 2, 44);
    if (secFlash > 0 && !secProtected) {
      ctx.fillStyle = "#FF3232"; ctx.font = "bold 20px monospace";
      ctx.fillText("COLISION!", (zx1 + zx2) / 2, H / 2);
    }
    ctx.fillStyle = "#888"; ctx.font = "9px monospace";
    ctx.fillText(`En zona: ${secInZone}`, (zx1 + zx2) / 2, H - 15);
    for (const c of cars) drawCar(ctx, c);
  }

  function renderRace(): void {
    const cx = W * 0.65, cy = H * 0.5;
    ctx.strokeStyle = "rgba(255,80,80,0.4)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, 30, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#888"; ctx.font = "10px monospace"; ctx.textAlign = "center";
    ctx.fillText("RECURSO", cx, cy + 45);
    ctx.fillStyle = "rgba(0,0,0,0.7)"; ctx.fillRect(20, 15, 160, 28);
    ctx.fillStyle = "#FF5050"; ctx.font = "bold 11px monospace"; ctx.textAlign = "left";
    ctx.fillText("SIN CONTROL (no sync)", 30, 34);
    if (racePhase === "crash") {
      const r = raceTimer * 1.5;
      ctx.fillStyle = `rgba(255,130,50,${Math.max(0, 1 - raceTimer / 120)})`;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgba(255,220,50,${Math.max(0, 1 - raceTimer / 80)})`;
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#FF3232"; ctx.font = "bold 24px monospace"; ctx.textAlign = "center";
      ctx.fillText("COLISION!", cx, cy - 50);
      ctx.fillStyle = "#FFF"; ctx.font = "12px monospace";
      ctx.fillText("Race condition: resultado impredecible", cx, cy + 65);
    }
    for (const c of cars) drawCar(ctx, c);
  }

  function renderDeadlock(): void {
    const cx = W * 0.5, cy = H * 0.5;
    ctx.strokeStyle = "#DC3232"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(W * 0.2, cy); ctx.lineTo(W * 0.8, cy); ctx.stroke();
    ctx.fillStyle = "#888"; ctx.font = "10px monospace"; ctx.textAlign = "center";
    ctx.fillText("Lock H", W * 0.85, cy + 4);
    ctx.beginPath(); ctx.moveTo(cx, H * 0.1); ctx.lineTo(cx, H * 0.9); ctx.stroke();
    ctx.fillText("Lock V", cx + 5, H * 0.08);
    if (deadlocked) {
      const pulse = Math.sin(frame * 0.1) * 0.3 + 0.5;
      ctx.fillStyle = `rgba(255,50,50,${pulse * 0.4})`;
      ctx.beginPath(); ctx.arc(cx, cy, 35 + pulse * 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#FF3232"; ctx.font = "bold 22px monospace"; ctx.textAlign = "center";
      ctx.fillText("DEADLOCK!", cx, cy - 50);
      ctx.fillStyle = "rgba(0,0,0,0.8)";
      ctx.fillRect(10, H - 65, W * 0.45, 50); ctx.fillRect(W * 0.52, H - 65, W * 0.45, 50);
      ctx.font = "10px monospace"; ctx.textAlign = "left";
      ctx.fillStyle = "#FF6666";
      ctx.fillText("H1: tiene Lock_H", 18, H - 48); ctx.fillText("    espera Lock_V", 18, H - 34);
      ctx.fillStyle = "#6688FF";
      ctx.fillText("H2: tiene Lock_V", W * 0.55, H - 48); ctx.fillText("    espera Lock_H", W * 0.55, H - 34);
    }
    for (const c of cars) drawCar(ctx, c);
  }

  function renderConcurrency(): void {
    for (let i = 0; i < cars.length; i++) {
      const y = cars[i].ty;
      ctx.strokeStyle = "rgba(255,255,255,0.1)"; ctx.lineWidth = 1; ctx.setLineDash([10, 10]);
      ctx.beginPath(); ctx.moveTo(0, y + 26); ctx.lineTo(W, y + 26); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "#555"; ctx.font = "9px monospace"; ctx.textAlign = "right";
      ctx.fillText(`Carril ${i + 1}`, W - 10, y - 10);
    }
    ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(W / 2 - 110, 5, 220, 20);
    ctx.fillStyle = "#50FF78"; ctx.font = "bold 10px monospace"; ctx.textAlign = "center";
    ctx.fillText(`${cars.length} HILOS INDEPENDIENTES`, W / 2, 18);
    for (const c of cars) drawCar(ctx, c);
  }

  // ── Info panel ──

  function updateInfo(): void {
    if (isAnalyzing && lastAnalysis) {
      const panel = info.querySelector(".ai-analysis-panel");
      if (panel) panel.textContent = lastAnalysis;
      return;
    }
    let statusHTML = "";
    switch (mode) {
      case "semaphore":
        statusHTML = `<div class="tv-stat"><span>Permisos:</span><strong style="color:${semPermits > 0 ? "#50FF78" : "#FF5050"}">${semPermits}/${semMax}</strong></div>
          <div class="tv-stat"><span>Activos:</span><strong>${semActive}</strong></div>
          <div class="tv-stat"><span>Esperando:</span><strong>${cars.filter(c => c.state === "wait").length}</strong></div>`; break;
      case "mutex":
        statusHTML = `<div class="tv-stat"><span>Lock:</span><strong style="color:${mutLocked ? "#FF5050" : "#50FF78"}">${mutLocked ? "LOCKED" : "FREE"}</strong></div>
          <div class="tv-stat"><span>Owner:</span><strong>${mutOwner || "none"}</strong></div>`; break;
      case "monitor":
        statusHTML = `<div class="tv-stat"><span>Estado:</span><strong style="color:${monBusy ? "#32D2D2" : "#50FF78"}">${monBusy ? "OCUPADO" : "LIBRE"}</strong></div>
          <div class="tv-stat"><span>Procesando:</span><strong>${monProcessor || "none"}</strong></div>`; break;
      case "critical":
        statusHTML = `<div class="tv-stat"><span>Proteccion:</span><strong style="color:${secProtected ? "#50FF78" : "#FF5050"}">${secProtected ? "ON" : "OFF"}</strong></div>
          <div class="tv-stat"><span>En zona:</span><strong>${secInZone}</strong></div>`; break;
      case "race":
        statusHTML = `<div class="tv-stat"><span>Fase:</span><strong style="color:#FF5050">${racePhase.toUpperCase()}</strong></div>`; break;
      case "deadlock":
        statusHTML = `<div class="tv-stat"><span>Estado:</span><strong style="color:${deadlocked ? "#FF5050" : "#F0B41E"}">${deadlocked ? "DEADLOCK!" : "Ejecutando..."}</strong></div>`; break;
      case "concurrency":
        statusHTML = `<div class="tv-stat"><span>Hilos:</span><strong style="color:#50FF78">${cars.length} activos</strong></div>`; break;
    }
    info.innerHTML = `
      <div class="tv-info-title">${MODE_NAMES[mode]}</div>
      <div class="tv-info-primitive">${MODE_PRIMITIVES[mode]}</div>
      <div class="tv-info-desc">${MODE_DESCRIPTIONS[mode].replace(/\n/g, "<br>")}</div>
      <div class="tv-info-stats">${statusHTML}</div>
      <button class="ai-analyze-btn" id="tv-ai-btn-${instanceId}" ${isAnalyzing ? 'disabled' : ''}>
        ${isAnalyzing ? '🤖 Analizando...' : '🤖 Analizar'}
      </button>
      ${isAnalyzing || lastAnalysis ? `<div class="ai-analysis-panel"></div>` : ''}
    `;

    if (lastAnalysis) {
      const panel = info.querySelector(".ai-analysis-panel");
      if (panel) panel.textContent = lastAnalysis;
    }

    const aiBtn = info.querySelector<HTMLButtonElement>(`#tv-ai-btn-${instanceId}`);
    if (aiBtn && !isAnalyzing) {
      aiBtn.addEventListener("click", async () => {
        if (isAnalyzing) return;
        isAnalyzing  = true;
        lastAnalysis = "";
        updateInfo();

        const { analyzeThreadSim } = await import("../ai/aiService");
        const description = MODE_DESCRIPTIONS[mode] ?? mode;
        analyzeThreadSim(
          { mode, param, description },
          (token) => {
            lastAnalysis += token;
            const panel = info.querySelector(".ai-analysis-panel");
            if (panel) panel.textContent = lastAnalysis;
          },
          () => { isAnalyzing = false; updateInfo(); },
          (err) => { lastAnalysis = `⚠️ ${err}`; isAnalyzing = false; updateInfo(); },
        );
      });
    }
  }

  // ── Main loop ──

  function render(): void {
    if (!running) return;
    frame++;
    switch (mode) {
      case "semaphore": updateSemaphore(); break; case "mutex": updateMutex(); break;
      case "monitor": updateMonitor(); break; case "critical": updateCritical(); break;
      case "race": updateRace(); break; case "deadlock": updateDeadlock(); break;
      case "concurrency": updateConcurrency(); break;
    }
    renderBg();
    switch (mode) {
      case "semaphore": renderSemaphore(); break; case "mutex": renderMutex(); break;
      case "monitor": renderMonitor(); break; case "critical": renderCritical(); break;
      case "race": renderRace(); break; case "deadlock": renderDeadlock(); break;
      case "concurrency": renderConcurrency(); break;
    }
    if (frame % 10 === 0) updateInfo();
    animId = requestAnimationFrame(render);
  }

  // ── Keyboard ──

  container.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === " ") { e.preventDefault(); initMode(); }
    if (e.key === "Enter" && mode === "critical") secProtected = !secProtected;
    if (e.key === "ArrowUp" && mode === "semaphore") { if (semMax < 5) { semMax++; semPermits++; } }
    if (e.key === "ArrowDown" && mode === "semaphore") { if (semMax > 1) { semMax--; if (semPermits > semMax) semPermits = semMax; } }
  });
  container.setAttribute("tabindex", "0");

  // ── Register instance ──

  activeInstances.set(instanceId, {
    mode, param,
    updateParam: (p: number) => {
      param = p;
      if (mode === "semaphore") { semMax = p; semPermits = Math.min(semPermits, p); }
      // Recalculate canvas size before reinit to avoid position drift
      resize();
      initMode();
    },
    restart: initMode,
    destroy: () => {
      running = false;
      cancelAnimationFrame(animId);
      resizeObs.disconnect();
      activeInstances.delete(instanceId);
    },
  });

  // ── Start ──
  resize();
  const resizeObs = new ResizeObserver(resize);
  resizeObs.observe(canvasWrap);
  initMode();
  updateInfo();
  render();

  // Cleanup on DOM removal
  const cleanupObs = new MutationObserver(() => {
    if (!document.contains(container)) {
      running = false; cancelAnimationFrame(animId);
      resizeObs.disconnect(); cleanupObs.disconnect();
      activeInstances.delete(instanceId);
    }
  });
  cleanupObs.observe(document.body, { childList: true, subtree: true });
}
