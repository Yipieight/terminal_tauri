/**
 * MiShell — Central AI Service
 *
 * Single point of contact with the local LLM (LM Studio / Ollama).
 * All features import from here — no fetch() calls elsewhere.
 *
 * Endpoint config persisted in localStorage under "mishell_ai_url".
 * NLP auto-execute mode persisted under "mishell_nlp_auto".
 */

// ── Config ────────────────────────────────────────────────────────────────

const AI_URL_KEY  = "mishell_ai_url";
const NLP_AUTO_KEY = "mishell_nlp_auto";

export function getAIBaseUrl(): string {
  return localStorage.getItem(AI_URL_KEY) ?? "http://127.0.0.1:1234/v1";
}
export function setAIBaseUrl(url: string): void {
  localStorage.setItem(AI_URL_KEY, url.replace(/\/+$/, ""));
}
export function isNLPAutoMode(): boolean {
  return localStorage.getItem(NLP_AUTO_KEY) === "true";
}
export function setNLPAutoMode(enabled: boolean): void {
  localStorage.setItem(NLP_AUTO_KEY, String(enabled));
}

// ── Session log ───────────────────────────────────────────────────────────

export interface SessionEvent {
  type: "command" | "simulation" | "schedule" | "memory";
  timestamp: number;
  data: Record<string, unknown>;
}

const sessionLog: SessionEvent[] = [];
const sessionStart = Date.now();

export function logSessionEvent(event: Omit<SessionEvent, "timestamp">): void {
  sessionLog.push({ ...event, timestamp: Date.now() });
}
export function getSessionLog(): SessionEvent[] {
  return [...sessionLog];
}
export function getSessionStartTime(): number {
  return sessionStart;
}

// ── Types for analysis functions ──────────────────────────────────────────

export interface SchedulerAnalysisData {
  algo: string;
  quantum: number;
  processes: Array<{ id: string; at: number; bt: number; pri: number; waitTime: number; turnaround: number }>;
  avgWait: number;
  avgTurnaround: number;
  ganttLength: number;
}

export interface ThreadSimData {
  mode: string;
  param: number;
  description: string;
}

export interface TaskManagerData {
  fileDataBytes: number;
  nodeOverheadBytes: number;
  historyMemoryBytes: number;
  recentCommands: string[];
}

// ── Core streaming function ───────────────────────────────────────────────

/**
 * Streams a chat completion from the local LLM.
 * Calls onToken for each token, onDone when finished, onError on failure.
 */
export async function streamAI(
  prompt: string,
  systemCtx: string,
  onToken: (token: string) => void,
  onDone: () => void,
  onError: (msg: string) => void,
  maxTokens = 800,
): Promise<void> {
  const baseUrl = getAIBaseUrl();
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "local-model",
        messages: [
          { role: "system", content: systemCtx },
          { role: "user",   content: prompt    },
        ],
        stream: true,
        max_tokens: maxTokens,
        temperature: 0.7,
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    if (!res.body) {
      onError("El servidor no devolvió un stream de respuesta.");
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let   sseBuffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") { onDone(); return; }
        try {
          const chunk = JSON.parse(payload);
          const token: string = chunk.choices?.[0]?.delta?.content ?? "";
          if (token) onToken(token);
        } catch { /* malformed chunk */ }
      }
    }
    onDone();
  } catch (err: unknown) {
    const isNetwork = err instanceof TypeError;
    onError(
      isNetwork
        ? `Sin conexión con ${baseUrl}.\n¿Está corriendo LM Studio con un modelo cargado?`
        : `Error: ${(err as Error)?.message ?? String(err)}`
    );
  }
}

// ── NLP shell ─────────────────────────────────────────────────────────────

const NLP_SYSTEM = `Eres un asistente de terminal para MiShell, un emulador de OS virtual con comandos muy limitados.
IMPORTANTE: Solo puedes usar los comandos y banderas EXACTOS listados abajo. Cualquier otra bandera o comando no existe.

Comandos disponibles con sus banderas exactas:
- ls [ruta]         — lista directorio (SIN banderas, no soporta -l -a -h etc.)
- dir [ruta]        — igual que ls
- cd <ruta>         — cambiar directorio
- pwd               — mostrar directorio actual
- mkdir [-p] <dir>  — crear directorio (-p para padres)
- touch <archivo>   — crear archivo vacío
- cat <archivo>     — mostrar contenido
- echo <texto>      — imprimir texto
- rm [-r|-rf] <ruta>— borrar (-r o -rf para directorios)
- cp <src> <dst>    — copiar archivo
- mv <src> <dst>    — mover/renombrar
- find <ruta> <nombre>— buscar archivos
- grep <patrón> <archivo>— buscar texto en archivo
- wc [-l|-w|-c] <archivo>— contar (-l líneas, -w palabras, -c chars)
- head [-n N] <archivo>  — primeras N líneas
- tail [-n N] <archivo>  — últimas N líneas
- sort <archivo>    — ordenar líneas
- uniq <archivo>    — eliminar duplicados
- history           — historial de comandos
- clear             — limpiar pantalla
- help              — mostrar ayuda
- ps                — listar ventanas abiertas
- kill <id>         — cerrar ventana
- open <app>        — abrir app (terminal, explorer, taskmanager, calculator)
- sim <modo> [N]    — visualizador de hilos (semaphore, mutex, deadlock, monitor, race, critical, concurrency)
- sched <algo> [Q]  — visualizador CPU (fifo, sjf, rr, priority)
- ai <pregunta>     — asistente IA

REGLAS CRÍTICAS:
1. ls y dir NO soportan ninguna bandera — nunca uses ls -l, ls -la, ls -lh, etc.
2. Solo usa las banderas exactas listadas — no inventes otras
3. Responde ÚNICAMENTE con JSON válido en una sola línea:
{"command":"<comando exacto>","explanation":"<explicación breve en español, máx 15 palabras>"}
Si no puedes convertirlo responde: {"command":"","explanation":"No pude interpretar esa instrucción."}`;


/**
 * Converts natural language to a shell command via a single LLM call.
 * The model is prompted to return only JSON: { command, explanation }.
 */
export async function parseNLPCommand(
  input: string,
): Promise<{ command: string; explanation: string }> {
  return new Promise((resolve) => {
    let fullText = "";
    streamAI(
      input,
      NLP_SYSTEM,
      (token) => { fullText += token; },
      () => {
        // Handle markdown fences that some models add despite instructions
        const cleaned = fullText
          .replace(/```json\s*/gi, "")
          .replace(/```\s*/g, "")
          .trim();
        // Find first {...} block
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            const parsed = JSON.parse(match[0]) as { command?: string; explanation?: string };
            resolve({
              command:     parsed.command     ?? "",
              explanation: parsed.explanation ?? "",
            });
            return;
          } catch { /* fall through */ }
        }
        resolve({ command: "", explanation: "No pude interpretar esa instrucción." });
      },
      (err) => resolve({ command: "", explanation: err }),
      200,
    );
  });
}

// ── Analysis functions ────────────────────────────────────────────────────

const SCHED_SYSTEM = `Eres un experto en sistemas operativos integrado en MiShell.
Analiza los resultados de planificación de CPU y explica en español, de forma técnica y concisa (máx 5 oraciones).
Compara con otros algoritmos y explica por qué salieron esos tiempos.`;

export function analyzeScheduler(
  data: SchedulerAnalysisData,
  onToken: (t: string) => void,
  onDone: () => void,
  onError: (e: string) => void,
): void {
  const procTable = data.processes
    .map((p) => `${p.id}: AT=${p.at} BT=${p.bt} Pri=${p.pri} Wait=${p.waitTime} Turn=${p.turnaround}`)
    .join(", ");
  const prompt =
    `Algoritmo: ${data.algo.toUpperCase()}${data.algo === "rr" ? ` (quantum=${data.quantum})` : ""}. ` +
    `Avg espera: ${data.avgWait.toFixed(2)}, Avg retorno: ${data.avgTurnaround.toFixed(2)}. ` +
    `Procesos: [${procTable}]. Duración total Gantt: ${data.ganttLength} unidades. ` +
    `Analiza estos resultados y compara con los otros algoritmos (FIFO, SJF, RR, Priority).`;
  streamAI(prompt, SCHED_SYSTEM, onToken, onDone, onError, 400);
}

const THREAD_SYSTEM = `Eres un experto en concurrencia y sistemas operativos integrado en MiShell.
Explica el mecanismo de sincronización mostrado, en español, de forma técnica y concisa (máx 5 oraciones).
Menciona ventajas, desventajas y cuándo se usa en la práctica.`;

export function analyzeThreadSim(
  data: ThreadSimData,
  onToken: (t: string) => void,
  onDone: () => void,
  onError: (e: string) => void,
): void {
  const prompt =
    `Modo activo: ${data.mode}. Parámetro: ${data.param}. Descripción: ${data.description}. ` +
    `Explica este mecanismo de sincronización y compáralo con las alternativas.`;
  streamAI(prompt, THREAD_SYSTEM, onToken, onDone, onError, 400);
}

const TM_SYSTEM = `Eres un analizador de memoria de sistema operativo integrado en MiShell.
Analiza los datos de memoria en español, de forma técnica y concisa (máx 4 oraciones).
Da un diagnóstico y sugerencias concretas si aplica.`;

export function analyzeTaskManager(
  data: TaskManagerData,
  onToken: (t: string) => void,
  onDone: () => void,
  onError: (e: string) => void,
): void {
  const total = data.fileDataBytes + data.nodeOverheadBytes + data.historyMemoryBytes || 1;
  const prompt =
    `Memoria total: ${total} bytes. ` +
    `Datos de archivos: ${data.fileDataBytes}B (${Math.round((data.fileDataBytes / total) * 100)}%). ` +
    `Overhead de nodos: ${data.nodeOverheadBytes}B (${Math.round((data.nodeOverheadBytes / total) * 100)}%). ` +
    `Historial de comandos: ${data.historyMemoryBytes}B (${Math.round((data.historyMemoryBytes / total) * 100)}%). ` +
    `Comandos recientes: ${data.recentCommands.slice(-6).join(", ") || "ninguno"}. ` +
    `Analiza y da sugerencias.`;
  streamAI(prompt, TM_SYSTEM, onToken, onDone, onError, 300);
}

// ── Report generator ──────────────────────────────────────────────────────

const REPORT_SYSTEM = `Eres un asistente académico para MiShell, un proyecto de emulador de OS virtual
(Tauri v2 + Rust + TypeScript) para un curso universitario de Sistemas Operativos.
Genera el reporte en español académico, bien estructurado en Markdown.
Usa los datos de sesión provistos para dar análisis concreto, no genérico.
Máximo 600 palabras en total.`;

export async function generateReport(
  onToken: (t: string) => void,
  onDone: () => void,
  onError: (e: string) => void,
): Promise<void> {
  const elapsedMin = Math.round((Date.now() - sessionStart) / 60000);
  const commands   = sessionLog.filter((e) => e.type === "command");
  const sims       = sessionLog.filter((e) => e.type === "simulation");
  const schedules  = sessionLog.filter((e) => e.type === "schedule");
  const memSnaps   = sessionLog.filter((e) => e.type === "memory");
  const lastMem    = (memSnaps.length > 0 ? memSnaps[memSnaps.length - 1] : undefined)?.data ?? {};

  const cmdList = commands
    .slice(-15)
    .map((e) => e.data["input"] as string)
    .join(", ");
  const simList = [...new Set(sims.map((e) => e.data["mode"] as string))].join(", ");
  const schedList = schedules
    .map((e) => `${e.data["algo"]}(avgWait=${(e.data["avgWait"] as number)?.toFixed(1)})`)
    .join(", ");

  const today = new Date().toISOString().split("T")[0];

  const prompt =
    `Genera un reporte académico completo en Markdown para el proyecto MiShell con estas secciones:
# Reporte de Sesión — MiShell OS Emulator
(incluye fecha: ${today}, duración: ~${elapsedMin} min, total comandos: ${commands.length})
## 1. Sistema de Archivos Virtual
## 2. Gestión de Memoria
## 3. Sincronización de Hilos
## 4. Planificación de CPU
## 5. Integración de IA Local
## 6. Conclusiones

Datos de la sesión:
- Comandos ejecutados: ${cmdList || "ninguno"}
- Simulaciones de hilos corridas: ${simList || "ninguna"}
- Schedules corridos: ${schedList || "ninguno"}
- Memoria al finalizar: archivos=${lastMem["fileDataBytes"] ?? 0}B, nodos=${lastMem["nodeOverheadBytes"] ?? 0}B, historial=${lastMem["historyMemoryBytes"] ?? 0}B

Usa estos datos para hacer el análisis concreto. No inventes datos.`;

  streamAI(prompt, REPORT_SYSTEM, onToken, onDone, onError, 1200);
}
