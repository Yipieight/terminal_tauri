# AI Enhancements Design — MiShell OS Emulator

**Fecha:** 2026-04-29  
**Estado:** Aprobado  
**Proyecto:** terminal_tauri (Tauri v2 + Rust + TypeScript)

---

## Resumen

Agregar 4 features de IA al proyecto MiShell usando un servicio central compartido (`aiService.ts`) que se conecta a LM Studio / Ollama vía API OpenAI-compatible en `http://127.0.0.1:1234/v1`.

Las 4 features son:
- **A** — Shell en lenguaje natural (`??` prefix)
- **B** — Botón "🤖 Analizar" en CPU Scheduler y Thread Visualizer
- **C** — Botón "🤖 Analizar" en Task Manager
- **D** — Generador de reporte académico (`ai report`)

---

## Arquitectura

### Módulo central: `src/ai/aiService.ts`

Único punto de contacto con la API de IA. Todos los demás módulos lo importan.

**Exports públicos:**

```typescript
// Streaming genérico — callback recibe tokens uno a uno
export async function streamAI(
  prompt: string,
  systemCtx: string,
  onToken: (token: string) => void,
  onDone: () => void,
  onError: (err: string) => void
): Promise<void>

// NLP shell: texto libre → comando shell
// Retorna { command: string, explanation: string }
export async function parseNLPCommand(input: string): Promise<{ command: string; explanation: string }>

// Análisis de scheduler: recibe stats del Gantt
export async function analyzeScheduler(data: SchedulerAnalysisData): Promise<string>

// Análisis de thread visualizer
export async function analyzeThreadSim(data: ThreadSimData): Promise<string>

// Diagnóstico de Task Manager
export async function analyzeTaskManager(data: TaskManagerData): Promise<string>

// Generador de reporte académico completo
export async function generateReport(session: SessionLog): Promise<string>

// Registro de sesión (llamado automáticamente por terminal.ts)
export function logSessionEvent(event: SessionEvent): void

// Config
export function getAIBaseUrl(): string
export function setAIBaseUrl(url: string): void
export function isNLPAutoMode(): boolean
export function setNLPAutoMode(enabled: boolean): void
```

**`SessionLog`** acumula en memoria durante toda la sesión:
- Comandos ejecutados (timestamp, input, exit_code)
- Simulaciones abiertas (modo, parámetros, resultados)
- Snapshots de memoria en cada comando
- Resultados de scheduling (algoritmo, avg_wait, avg_turnaround, tabla de procesos)

---

## Feature A — Shell en Lenguaje Natural

### Activación
Prefijo `??` en la terminal. Ejemplo: `?? lista los archivos por tamaño`

El comando `ai <pregunta>` sigue funcionando para preguntas libres sin cambios.

### Flujo
1. `terminal.ts` detecta que el input empieza con `??`
2. Llama `aiService.parseNLPCommand(input)` — **una llamada al modelo** con respuesta en JSON:
   - El prompt instruye al modelo a responder exclusivamente con `{"command":"...","explanation":"..."}`
   - Se parsea el JSON; si falla el parse, se reintenta con un prompt más estricto
3. Muestra en terminal:
   ```
   Comando sugerido: ls -lhS
   Ordena por tamaño (-S), formato legible (-h), vista larga (-l)
   ¿Ejecutar? [Y] sí  [N] no  [E] editar  [A] siempre ejecutar
   ```
4. El usuario responde con una tecla:
   - `Y` → ejecuta el comando via `invoke("execute_command")`
   - `N` → cancela, vuelve al prompt
   - `E` → copia el comando al input para editarlo
   - `A` → activa auto-execute mode + ejecuta

### Modo auto-execute
- Se activa con `[A]` o con `ai --nlp-auto on`
- Se guarda en `localStorage` bajo la clave `mishell_nlp_auto`
- Se desactiva con `ai --nlp-auto off`
- Cuando está activo, ejecuta directamente sin mostrar confirmación

### Comandos destructivos
Si el comando generado contiene `rm`, `rmdir`, o `-rf`, mostrar advertencia en naranja **siempre**, incluso en modo auto-execute.

### Manejo de errores NLP
- Si el modelo no puede interpretar la frase → mostrar: `"No pude interpretar eso como un comando. Intenta ser más específico."`
- Si el comando generado no existe en el virtual shell → el error normal de "command not found" aplica

---

## Feature B — Botón Analizar en Visualizadores

### CPU Scheduler (`scheduler.ts`)
- Botón "🤖 Analizar" en el panel `tv-info` lateral, visible cuando `statsShown === true` (animación completada)
- Al hacer click:
  1. Botón cambia a "🤖 Analizando..." y se deshabilita
  2. Llama `aiService.analyzeScheduler({ algo, quantum, processes, avgWait, avgTurnaround, ganttLength })`
  3. La respuesta streama al panel lateral, debajo de las stats, con estilo `.ai-response`
  4. Botón vuelve a "🤖 Analizar" al terminar

**Contexto enviado al modelo:** algoritmo usado, quantum (si RR), tabla de procesos (AT/BT/WT/TT), avg wait, avg turnaround. Se le pide comparar con los otros algoritmos y explicar por qué salieron esos números.

### Thread Visualizer (`threadVisualizer.ts`)
- Botón "🤖 Analizar" en el panel `tv-info`, siempre visible
- Envía: modo activo (semaphore/mutex/deadlock/etc.), parámetro actual, descripción del estado
- La IA explica el mecanismo de sincronización y lo compara con las alternativas

---

## Feature C — Botón Analizar en Task Manager

### Ubicación
Tab "Performance" — botón "🤖 Analizar con IA" debajo de las barras de memoria.

### Flujo
1. Click → botón cambia a "Analizando..." (deshabilitado)
2. Llama `aiService.analyzeTaskManager({ fileDataBytes, nodeOverheadBytes, historyMemoryBytes, recentCommands })`
3. La respuesta aparece en un `<div>` debajo del botón con borde morado, dentro del panel de Performance
4. Se reemplaza en cada análisis nuevo (no acumula)

---

## Feature D — Generador de Reporte Académico

### Comando
```
ai report                    → guarda en /home/user/report.md
ai report mi-proyecto        → guarda en /home/user/mi-proyecto.md
```

### Flujo
1. `terminal.ts` detecta `ai report [nombre?]`
2. Muestra progreso en terminal:
   ```
   📊 Recopilando datos de sesión...
     ✓ N comandos ejecutados
     ✓ Simulaciones: [lista]
     ✓ Memoria actual: X bytes
   🤖 Generando reporte...
   ```
3. Llama `aiService.generateReport(sessionLog)` — streaming sección por sección
4. Cada sección generada se muestra en terminal mientras se escribe
5. Al completar, guarda el texto en el filesystem virtual via `invoke("write_file", { path, content })`
6. Mensaje final: `✓ Reporte guardado en /home/user/report.md`

### Estructura del reporte generado
```markdown
# Reporte de Sesión — MiShell OS Emulator
Fecha | Duración | Comandos ejecutados

## 1. Sistema de Archivos Virtual
## 2. Gestión de Memoria
## 3. Sincronización de Hilos
## 4. Planificación de CPU
## 5. Integración de IA
## 6. Conclusiones
```

### Tauri command requerido
Se necesita exponer `write_file(path: String, content: String)` como Tauri command en `lib.rs`, que llame a `fs.write_file()` del VirtualFs existente.

---

## Archivos modificados

| Archivo | Cambio |
|---|---|
| `src/ai/aiService.ts` | **Nuevo** — servicio central |
| `src/apps/terminal.ts` | Detectar `??` prefix; `ai report`; delegar `ai` a aiService |
| `src/apps/scheduler.ts` | Botón Analizar en panel lateral |
| `src/apps/threadVisualizer.ts` | Botón Analizar en panel lateral |
| `src/apps/taskManager.ts` | Botón Analizar en tab Performance |
| `src-tauri/src/lib.rs` | Nuevo comando `write_file` |
| `src/styles.css` | Estilos para `.ai-analyze-btn` y `.ai-analysis-panel` |

---

## Consideraciones técnicas

- **Sin nuevas dependencias Rust** — `write_file` usa el `VirtualFs` existente
- **CSP null** — fetch a localhost permitido sin configuración adicional
- **sessionLog en memoria** — se pierde al cerrar la ventana; no persiste entre sesiones (comportamiento esperado)
- **Modelo agnóstico** — funciona con cualquier modelo cargado en LM Studio u Ollama; el campo `model` se envía como `"local-model"` que los servidores ignoran
- **NLP destructivo** — `rm`, `rmdir`, `-rf` siempre piden confirmación incluso en auto-execute

---

## Fuera de alcance

- Persistencia del sessionLog entre sesiones (se podría agregar después con `invoke("save_session")`)
- Historial de reportes generados
- Comparación automática entre algoritmos de scheduling al cambiar el modo
