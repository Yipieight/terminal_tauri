# Analisis Tecnico - MiShell: Mini Terminal con Filesystem Virtual

## 1. Introduccion

MiShell es una mini terminal (shell) desarrollada como aplicacion de escritorio multiplataforma utilizando **Tauri v2** (Rust para el backend, TypeScript + HTML/CSS para el frontend). A diferencia de una terminal convencional que ejecuta comandos directamente en el sistema operativo, MiShell opera sobre un **filesystem virtual completamente aislado** (sandboxed), lo que impide cualquier afectacion al sistema real del usuario.

El proyecto implementa las 7 fases del rubric academico, adaptando los conceptos de sistemas operativos de C/C++ a su equivalente en Rust, demostrando que los principios fundamentales son los mismos independientemente del lenguaje.

---

## 2. Arquitectura del Sistema

```
┌─────────────────────────────────────────────────────┐
│                    FRONTEND                          │
│            (TypeScript + XP.css + HTML)              │
│                                                      │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Terminal  │  │File Explorer │  │Task Manager  │  │
│  │   App     │  │    App       │  │    App       │  │
│  └─────┬─────┘  └──────┬───────┘  └──────┬───────┘  │
│        │               │                │           │
│        └───────┬────────┴────────┬───────┘           │
│                │   Tauri IPC     │                   │
│                │   (invoke())    │                   │
├────────────────┴─────────────────┴───────────────────┤
│                    BACKEND (Rust)                     │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │              lib.rs (Tauri Commands)          │   │
│  │  execute_command, get_history, get_cwd,       │   │
│  │  autocomplete, get_system_stats,              │   │
│  │  fs_list_dir, fs_read_file, fs_create_dir,    │   │
│  │  fs_delete, fs_rename, fs_get_tree            │   │
│  └──────────────────┬───────────────────────────┘   │
│                     │                                │
│  ┌──────────────────▼───────────────────────────┐   │
│  │           virtual_fs.rs                       │   │
│  │                                               │   │
│  │  FsState {                                    │   │
│  │    fs: Mutex<VirtualFs>,    ← Filesystem      │   │
│  │    history: Mutex<Vec<String>>, ← Historial   │   │
│  │    data_path: PathBuf       ← Persistencia    │   │
│  │  }                                            │   │
│  │                                               │   │
│  │  VirtualFs {                                  │   │
│  │    root: FsNode (arbol recursivo)             │   │
│  │    cwd: String (directorio actual)            │   │
│  │  }                                            │   │
│  └──────────────────┬───────────────────────────┘   │
│                     │                                │
│              ┌──────▼──────┐                         │
│              │ JSON File   │  (mishell_fs.json)      │
│              │ Persistencia│                         │
│              └─────────────┘                         │
└─────────────────────────────────────────────────────┘
```

### 2.1 Flujo de Ejecucion de un Comando

1. El usuario escribe un comando en la terminal del frontend (ej: `ls -l /home`)
2. El frontend captura el evento `keydown` (Enter) y llama a `invoke("execute_command", { input: "ls -l /home" })`
3. Tauri enruta la llamada IPC al handler Rust `execute_command()` en `lib.rs`
4. El handler almacena el comando en el historial (`Mutex<Vec<String>>`)
5. El parser (`parse_input()`) divide el input en segmentos de pipeline
6. El dispatcher (`execute_pipeline()`) ejecuta cada segmento en el filesystem virtual
7. El resultado (`CommandResult { stdout, stderr, exit_code }`) se serializa a JSON
8. El frontend recibe el JSON y renderiza el output en la terminal

---

## 3. Fases del Rubric Academico

### Fase 1: Terminal Basica — Prompt y Ejecucion de Comandos

**Requisito:** Mostrar un prompt, leer comandos y ejecutarlos usando `fork()` y `exec()`.

**Implementacion en MiShell:**

El prompt se renderiza en el frontend con formato dinamico que muestra el directorio actual:

```
user@MiShell-PC:/home/user$
```

Cuando el directorio cambia (ej: `cd Documents`), el prompt se actualiza automaticamente consultando al backend:

```typescript
async function updatePrompt(): Promise<void> {
  const cwd: string = await invoke("get_cwd");
  const display = cwd.replace(/^\/home\/user/, "~");
  prompt.textContent = `user@MiShell-PC:${display}$ `;
}
```

**Equivalencia fork/exec en Rust:**

En una shell tradicional en C, la ejecucion de comandos sigue este patron:

| Paso | C/C++ | Rust/Tauri (MiShell) |
|------|-------|----------------------|
| 1. Crear proceso hijo | `fork()` crea una copia del proceso padre | Tauri IPC despacha cada comando en un thread pool separado del UI thread |
| 2. Ejecutar programa | `exec()` reemplaza la imagen del proceso con el programa objetivo | Se despacha a funciones internas de Rust (`cmd_ls`, `cmd_cat`, etc.) |
| 3. Esperar resultado | `waitpid()` bloquea al padre hasta que el hijo termine | `Mutex::lock()` bloquea hasta que el comando termine y libere el lock |

La razon clave de esta diferencia: las shells reales usan `fork/exec` porque necesitan ejecutar **programas externos** (como `/usr/bin/ls`). MiShell implementa **todos los comandos internamente**, siguiendo el enfoque de shells embebidas como BusyBox.

```rust
// En C:
pid_t pid = fork();
if (pid == 0) {
    execvp(args[0], args);  // Hijo: ejecutar programa externo
    exit(1);
}
waitpid(pid, &status, 0);   // Padre: esperar al hijo

// En Rust/Tauri (equivalente funcional):
// Tauri IPC ya aísla la ejecucion en un thread separado (= fork)
// El dispatch a cmd_ls/cmd_cat/etc es el equivalente a exec
// Mutex::lock() es el equivalente a waitpid()
let result = match seg.program.as_str() {
    "ls" => fs.cmd_ls(&seg.args, &current_stdin),
    "cd" => fs.cmd_cd(&seg.args),
    "cat" => fs.cmd_cat(&seg.args, &current_stdin),
    // ... cada comando se ejecuta internamente
};
```

---

### Fase 2: Analisis de Comandos (Parsing)

**Requisito:** Separar el comando en sus partes (programa + argumentos).

**Implementacion:**

El parser se encuentra en la funcion `parse_input()` dentro de `virtual_fs.rs`. El proceso es:

1. **Division por pipes (`|`)**: `input.split('|')` separa el input en segmentos de pipeline
2. **Deteccion de redireccion (`>` y `<`)**: Se buscan los operadores y se extraen los archivos destino/origen
3. **Tokenizacion**: La funcion `tokenize()` divide cada segmento en tokens, respetando comillas dobles y simples

**Ejemplo de parsing:**

```
Entrada: ls -l /home | grep user > output.txt

Resultado del parser:
  Segmento 1: { program: "ls", args: ["-l", "/home"], redirect_to: None, redirect_from: None }
  Segmento 2: { program: "grep", args: ["user"], redirect_to: Some("output.txt"), redirect_from: None }
```

**Comparacion con C:**

| Aspecto | C/C++ | Rust (MiShell) |
|---------|-------|----------------|
| Tokenizacion | `strtok()` modifica el string original, requiere buffer manual | `split()` + iteradores, string original inmutable |
| Almacenamiento de tokens | `malloc()` para cada token, array de `char*` con `realloc()` | `Vec<String>` crece automaticamente con `push()` |
| Liberacion de memoria | `free()` manual para cada token y el array | Automatica al salir del scope (RAII) |
| Strings con comillas | Parsing manual caracter por caracter | Funcion `tokenize()` con maquina de estados |

```rust
// Estructura del resultado del parsing
pub struct ParsedSegment {
    pub program: String,       // Nombre del comando
    pub args: Vec<String>,     // Argumentos del comando
    pub redirect_to: Option<String>,   // Redireccion de salida (>)
    pub redirect_from: Option<String>, // Redireccion de entrada (<)
}
```

La funcion `tokenize()` implementa una maquina de estados que respeta comillas:

```rust
fn tokenize(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_double_quote = false;
    let mut in_single_quote = false;

    for ch in input.chars() {
        match ch {
            '"' if !in_single_quote => in_double_quote = !in_double_quote,
            '\'' if !in_double_quote => in_single_quote = !in_single_quote,
            ' ' | '\t' if !in_double_quote && !in_single_quote => {
                if !current.is_empty() {
                    tokens.push(current.clone());
                    current.clear();
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() { tokens.push(current); }
    tokens
}
```

---

### Fase 3: Uso de Pipes

**Requisito:** Conectar comandos usando el operador `|`, donde la salida de un comando se usa como entrada del siguiente.

**Implementacion:**

Los pipes se implementan como flujo de datos basado en strings dentro de `execute_pipeline()`:

```rust
pub fn execute_pipeline(segments: &[ParsedSegment], fs: &mut VirtualFs, history: &[String]) -> CommandResult {
    let mut current_stdin: Option<String> = None;

    for (i, seg) in segments.iter().enumerate() {
        let is_last = i == segments.len() - 1;

        // Ejecutar el comando con el stdin actual (del pipe anterior)
        let result = match seg.program.as_str() {
            "grep" => fs.cmd_grep(&seg.args, &current_stdin),
            "cat"  => fs.cmd_cat(&seg.args, &current_stdin),
            "wc"   => fs.cmd_wc(&seg.args, &current_stdin),
            "sort" => { /* usa current_stdin */ },
            // ...
        };

        if !is_last {
            // El stdout de este comando se convierte en stdin del siguiente
            current_stdin = Some(result.stdout);
        } else {
            return result; // Ultimo comando: devolver resultado al usuario
        }
    }
}
```

**Equivalencia con Unix pipes:**

| Concepto | C (Unix) | Rust (MiShell) |
|----------|----------|----------------|
| Crear canal | `pipe(fd)` crea file descriptors | Variable `current_stdin: Option<String>` |
| Conectar stdout | `dup2(fd[1], STDOUT_FILENO)` | `result.stdout` se captura en un `String` |
| Conectar stdin | `dup2(fd[0], STDIN_FILENO)` | Se pasa `&current_stdin` al siguiente comando |
| Flujo de datos | Bytes a traves de file descriptors del kernel | Strings en memoria (mas eficiente para filesystem virtual) |

**Ejemplo de ejecucion:**

```
Comando: ls | grep Documents | wc -l

Paso 1: ls → stdout = "Desktop/\nDocuments/\nDownloads/"
Paso 2: grep Documents (stdin = stdout anterior) → stdout = "Documents/"
Paso 3: wc -l (stdin = stdout anterior) → stdout = "1"

Resultado final: "1"
```

---

### Fase 4: Redireccion de Entrada/Salida

**Requisito:** Permitir redireccion con `>` (salida) y `<` (entrada).

**Redireccion de salida (`>`):**

```rust
// Al final del pipeline, si hay redirect_to:
if let Some(ref filepath) = seg.redirect_to {
    let write_result = fs.write_file(filepath, &result.stdout);
    return CommandResult {
        stdout: format!("Output written to: {}", filepath),
        stderr: result.stderr,
        exit_code: result.exit_code,
    };
}
```

Equivalente en C: `open(file, O_WRONLY|O_CREAT)` + `dup2(fd, STDOUT_FILENO)`

**Redireccion de entrada (`<`):**

```rust
// Al inicio del pipeline, si hay redirect_from:
if let Some(ref input_file) = seg.redirect_from {
    let resolved = fs.resolve_path(input_file);
    match fs.get_node(&resolved) {
        Some(FsNode::File { content, .. }) => {
            current_stdin = Some(content.clone());
        }
        // manejo de errores...
    }
}
```

Equivalente en C: `open(file, O_RDONLY)` + `dup2(fd, STDIN_FILENO)`

**Ejemplos funcionales:**

```bash
# Redireccion de salida
echo "hola mundo" > archivo.txt     # Crea archivo con contenido
ls /home > listado.txt              # Guarda listado en archivo

# Redireccion de entrada
wc -l < archivo.txt                 # Cuenta lineas del archivo
sort < datos.txt                    # Ordena contenido del archivo

# Combinado con pipes
cat < input.txt | grep error > errores.txt
```

---

### Fase 5: Gestion de Memoria

**Requisito:** Usar memoria dinamica, reservar memoria para comandos, liberarla despues de usarla, y evitar fugas de memoria (memory leaks).

Esta es la fase donde Rust demuestra su mayor ventaja sobre C/C++. El sistema de **ownership** (propiedad) de Rust garantiza **cero fugas de memoria en tiempo de compilacion**, sin necesidad de `free()` manual ni herramientas como Valgrind.

#### 5.1 Modelo de Ownership de Rust

Cada valor en Rust tiene exactamente **un dueno**. Cuando el dueno sale del scope, el valor se libera automaticamente (RAII - Resource Acquisition Is Initialization).

```rust
// ─── Comparacion directa C vs Rust ───

// En C: requiere malloc + free manual
char* cmd = malloc(256);
strcpy(cmd, "ls -l /home");
// ... usar cmd ...
free(cmd);  // OBLIGATORIO, si se olvida → memory leak

// En Rust: ownership + RAII
let cmd = String::from("ls -l /home");
// ... usar cmd ...
// Al salir del scope, Rust llama drop() automaticamente → memoria liberada
// No hay forma de olvidar liberarla — el compilador lo garantiza
```

#### 5.2 Filesystem Virtual — Arbol Recursivo con Liberacion Automatica

El filesystem se modela como un arbol recursivo usando un `enum`:

```rust
pub enum FsNode {
    File {
        name: String,        // 24 bytes (ptr+len+cap) + datos en heap
        content: String,     // 24 bytes + datos en heap
        created: u64,        // 8 bytes
        modified: u64,       // 8 bytes
    },
    Directory {
        name: String,        // 24 bytes + datos en heap
        children: Vec<FsNode>, // 24 bytes (ptr+len+cap) + N nodos en heap
        created: u64,        // 8 bytes
        modified: u64,       // 8 bytes
    },
}
```

**Cuando se elimina un directorio con `rm -r`:**

```rust
// En C: necesitas una funcion recursiva de liberacion
void free_node(FsNode* node) {
    if (node->type == DIRECTORY) {
        for (int i = 0; i < node->child_count; i++) {
            free_node(node->children[i]);  // Recursion manual
        }
        free(node->children);  // Liberar array de hijos
    }
    free(node->name);     // Liberar nombre
    free(node->content);  // Liberar contenido
    free(node);           // Liberar nodo
}

// En Rust: el Drop trait se encarga automaticamente
children.retain(|c| c.name() != target_name);
// Al remover un nodo del Vec, Rust llama drop() recursivamente:
//   drop(Directory) → drop(Vec<FsNode>) → drop(cada FsNode hijo)
//     → drop(String name) → drop(String content) → ...
// TODA la memoria del subarbol se libera automaticamente
```

#### 5.3 Historial de Comandos — Vec Dinamico

```rust
// En C: array dinamico con realloc manual
char** history = malloc(10 * sizeof(char*));
int capacity = 10, count = 0;

void add_to_history(const char* cmd) {
    if (count >= capacity) {
        capacity *= 2;
        history = realloc(history, capacity * sizeof(char*));
    }
    history[count++] = strdup(cmd);  // malloc interno
}
// Liberar: for(i=0;i<count;i++) free(history[i]); free(history);

// En Rust: Vec maneja todo automaticamente
let history: Mutex<Vec<String>> = Mutex::new(Vec::new());

// Agregar comando:
history.push(trimmed.to_string());
// Vec crece automaticamente (realloc interno seguro)
// Cuando history se destruye, TODOS los Strings se liberan automaticamente
```

#### 5.4 Visualizacion de Memoria — Task Manager

MiShell incluye un **Task Manager** visual que muestra en tiempo real como la memoria esta distribuida:

```rust
fn get_system_stats(state: State<'_, FsState>) -> SystemStats {
    let (files, dirs, bytes) = fs.root.stats();

    // Desglose exacto de memoria:
    let node_overhead = (files + dirs) * 128;   // ~128 bytes por struct FsNode
    let history_mem: usize = history.iter()
        .map(|s| s.len() + 24)                 // 24 bytes header String + datos
        .sum();
    let estimated_memory = bytes + node_overhead + history_mem;

    SystemStats {
        file_data_bytes: bytes,          // Contenido de archivos
        node_overhead_bytes: node_overhead, // Overhead de structs
        history_memory_bytes: history_mem,  // Historial de comandos
        estimated_memory,                  // Total
        // ...
    }
}
```

El Task Manager muestra 3 categorias con barras de progreso:
- **File Data** (azul): bytes almacenados en contenido de archivos (`String content` en `FsNode::File`)
- **Node Overhead** (amarillo): memoria de los structs del arbol (N nodos x ~128 bytes)
- **History Memory** (verde): memoria del historial de comandos (24 bytes header + caracteres por entrada)

---

### Fase 6: Historial de Comandos

**Requisito:** Guardar los comandos ejecutados durante la sesion.

**Implementacion:**

El historial se almacena como `Mutex<Vec<String>>` en el estado gestionado por Tauri:

```rust
pub struct FsState {
    pub fs: Mutex<VirtualFs>,
    pub history: Mutex<Vec<String>>,  // ← Historial protegido por Mutex
    pub data_path: PathBuf,
}
```

Cada vez que se ejecuta un comando, se agrega al historial:

```rust
#[tauri::command]
fn execute_command(input: &str, state: State<'_, FsState>) -> CommandResult {
    let trimmed = input.trim();

    // Almacenar en historial (equivalente a: history[count++] = strdup(cmd) en C)
    if let Ok(mut history) = state.history.lock() {
        history.push(trimmed.to_string());
    }

    // Parsear y ejecutar...
}
```

El comando `history` muestra el historial numerado:

```rust
"history" => {
    let history_text: String = history
        .iter()
        .enumerate()
        .map(|(i, cmd)| format!("  {}  {}", i + 1, cmd))
        .collect::<Vec<String>>()
        .join("\n");
    CommandResult { stdout: history_text, stderr: String::new(), exit_code: 0 }
}
```

**Salida ejemplo:**

```
user@MiShell-PC:~$ history
  1  ls
  2  mkdir proyectos
  3  cd proyectos
  4  touch readme.txt
  5  echo "hola mundo" > readme.txt
  6  cat readme.txt
  7  history
```

El frontend tambien permite navegar el historial con las **flechas arriba/abajo** del teclado, igual que una terminal real.

---

### Fase 7 (Opcional): Funcionalidades Adicionales

MiShell implementa multiples funcionalidades que van mas alla del rubric:

| Funcionalidad | Descripcion |
|---------------|-------------|
| **Filesystem virtual sandboxed** | Aislamiento total del sistema real — los archivos solo existen en la app |
| **Interfaz grafica XP** | Desktop completo con ventanas movibles, barra de tareas, menu Start |
| **File Explorer** | Navegador visual del filesystem virtual con click derecho contextual |
| **Task Manager** | Monitor de memoria en tiempo real con graficos y desglose por categoria |
| **Tab Autocomplete** | Autocompletado de comandos y rutas con la tecla Tab (case-insensitive) |
| **Persistencia JSON** | El filesystem se guarda automaticamente en disco y se restaura al reabrir |
| **Boot/Shutdown** | Animaciones de inicio y apagado estilo Windows XP |
| **Multiplataforma** | Compilable para macOS (ARM + Intel), Windows y Linux via GitHub Actions |

---

## 4. Sincronizacion y Concurrencia

### 4.1 Mutex — Exclusion Mutua

El recurso compartido principal es el filesystem virtual (`VirtualFs`). Como multiples llamadas IPC de Tauri pueden llegar simultaneamente desde el frontend, se protege con un `Mutex`:

```rust
pub struct FsState {
    pub fs: Mutex<VirtualFs>,         // Acceso exclusivo al filesystem
    pub history: Mutex<Vec<String>>,  // Acceso exclusivo al historial
}
```

**Equivalencia con C:**

```c
// En C (pthreads):
pthread_mutex_t fs_mutex = PTHREAD_MUTEX_INITIALIZER;

void execute_command(const char* cmd) {
    pthread_mutex_lock(&fs_mutex);      // Bloquear
    // ... operar en el filesystem ...
    pthread_mutex_unlock(&fs_mutex);    // Desbloquear (FACIL DE OLVIDAR)
}

// En Rust:
fn execute_command(state: State<'_, FsState>) {
    let mut fs = state.fs.lock().unwrap();  // Bloquear
    // ... operar en el filesystem ...
}   // Al salir del scope, el MutexGuard se destruye → unlock AUTOMATICO
    // IMPOSIBLE olvidar el unlock — el compilador lo garantiza
```

### 4.2 Prevencion de Condiciones de Carrera

Rust previene condiciones de carrera (race conditions) a nivel de compilacion:

1. **Borrow Checker**: Impide que dos hilos tengan referencias mutables al mismo dato simultaneamente
2. **Send + Sync traits**: Solo tipos thread-safe pueden compartirse entre hilos
3. **Mutex obliga acceso secuencial**: Solo un hilo puede acceder al filesystem a la vez

```rust
// Esto NO compila en Rust — el compilador detecta el data race potencial:
// let fs_ref1 = &mut fs;  // Primera referencia mutable
// let fs_ref2 = &mut fs;  // ERROR: segunda referencia mutable al mismo dato

// El Mutex es la solucion correcta:
let mut fs = state.fs.lock().unwrap();  // Solo un hilo puede tener esto
```

### 4.3 Tauri IPC como Modelo de Concurrencia

Tauri maneja las llamadas IPC en un **thread pool**. Cada `invoke()` desde el frontend se despacha a un worker thread:

```
Frontend Thread (UI)          Rust Worker Thread Pool
     │                              │
     │─ invoke("execute_command") ──►│
     │                              │── lock(Mutex<VirtualFs>)
     │                              │── ejecutar comando
     │                              │── unlock (automatico)
     │◄─ CommandResult (JSON) ──────│
     │                              │
     │─ invoke("get_cwd") ──────────►│
     │                              │── lock(Mutex<VirtualFs>)
     │                              │── leer cwd
     │                              │── unlock (automatico)
     │◄─ String (JSON) ────────────│
```

---

## 5. Catalogo Completo de Comandos Implementados

### 5.1 Operaciones de Archivos y Directorios

| Comando | Sintaxis | Descripcion | Ejemplo |
|---------|----------|-------------|---------|
| `ls` | `ls [path]` | Lista contenido del directorio. Los directorios se muestran con `/` al final | `ls /home/user` |
| `cd` | `cd [path]` | Cambia el directorio de trabajo. Soporta rutas absolutas, relativas, `..`, `~` | `cd ../Documents` |
| `pwd` | `pwd` | Muestra el directorio de trabajo actual | `pwd` → `/home/user` |
| `mkdir` | `mkdir [-p] <path>` | Crea un directorio. `-p` crea directorios intermedios | `mkdir -p a/b/c` |
| `touch` | `touch <file>` | Crea un archivo vacio o actualiza timestamp si ya existe | `touch notas.txt` |
| `cat` | `cat <file>` | Muestra el contenido de un archivo. Soporta stdin en pipes | `cat readme.txt` |
| `echo` | `echo <text>` | Imprime texto. Soporta comillas dobles y simples | `echo "hola mundo"` |
| `rm` | `rm [-r] <path>` | Elimina archivos o directorios. `-r` para recursivo | `rm -r proyectos/` |
| `cp` | `cp <src> <dst>` | Copia un archivo a otra ubicacion | `cp a.txt backup.txt` |
| `mv` | `mv <src> <dst>` | Mueve o renombra un archivo o directorio | `mv old.txt new.txt` |
| `find` | `find [path] [name]` | Busca archivos por nombre recursivamente | `find / txt` |

### 5.2 Procesamiento de Texto

| Comando | Sintaxis | Descripcion | Ejemplo |
|---------|----------|-------------|---------|
| `grep` | `grep <pattern> [file]` | Busca lineas que contengan el patron. Soporta stdin (pipes) | `grep error log.txt` |
| `wc` | `wc [-l\|-w\|-c] [file]` | Cuenta lineas, palabras o caracteres | `wc -l archivo.txt` |
| `head` | `head [-n N] [file]` | Muestra las primeras N lineas (default: 10) | `head -n 5 datos.txt` |
| `tail` | `tail [-n N] [file]` | Muestra las ultimas N lineas (default: 10) | `tail -n 3 log.txt` |
| `sort` | `sort [file]` | Ordena lineas alfabeticamente. Soporta stdin | `sort nombres.txt` |
| `uniq` | `uniq` | Elimina lineas duplicadas consecutivas (usar con sort) | `sort data \| uniq` |

### 5.3 Informacion del Sistema

| Comando | Sintaxis | Descripcion | Salida |
|---------|----------|-------------|--------|
| `whoami` | `whoami` | Muestra el usuario actual | `user` |
| `hostname` | `hostname` | Muestra el nombre del equipo | `MiShell-PC` |
| `date` | `date` | Muestra la fecha y hora actual (Unix timestamp) | `Unix timestamp: 1710...` |
| `uname` | `uname` | Muestra informacion del sistema | `MiShell Virtual OS 1.0` |
| `history` | `history` | Muestra el historial numerado de comandos | `1 ls`, `2 pwd`, ... |
| `help` | `help` | Muestra la lista completa de comandos disponibles | Tabla formateada |
| `clear` | `clear` | Limpia la pantalla de la terminal | (limpia output) |

### 5.4 Operadores

| Operador | Sintaxis | Descripcion | Ejemplo |
|----------|----------|-------------|---------|
| `\|` (pipe) | `cmd1 \| cmd2` | Conecta stdout de cmd1 con stdin de cmd2 | `ls \| grep txt` |
| `>` (redireccion salida) | `cmd > file` | Escribe stdout del comando en un archivo | `echo hola > test.txt` |
| `<` (redireccion entrada) | `cmd < file` | Lee archivo como stdin del comando | `wc -l < datos.txt` |

---

## 6. Ejemplos de Ejecucion

### Ejemplo 1: Operaciones basicas de archivos

```bash
user@MiShell-PC:~$ mkdir proyectos
user@MiShell-PC:~$ cd proyectos
user@MiShell-PC:~/proyectos$ touch readme.txt
user@MiShell-PC:~/proyectos$ echo "Mi primer proyecto" > readme.txt
Output written to: readme.txt
user@MiShell-PC:~/proyectos$ cat readme.txt
Mi primer proyecto
user@MiShell-PC:~/proyectos$ ls
readme.txt
```

### Ejemplo 2: Pipes encadenados

```bash
user@MiShell-PC:~$ ls /home/user
Desktop/
Documents/
Downloads/
user@MiShell-PC:~$ ls /home/user | grep Doc
Documents/
user@MiShell-PC:~$ ls /home/user | grep Doc | wc -l
1
```

### Ejemplo 3: Redireccion combinada

```bash
user@MiShell-PC:~$ echo "linea1" > datos.txt
user@MiShell-PC:~$ echo "linea2" > datos2.txt
user@MiShell-PC:~$ cat datos.txt
linea1
user@MiShell-PC:~$ wc -l < datos.txt
1
```

### Ejemplo 4: Busqueda y filtrado

```bash
user@MiShell-PC:~$ find / txt
/home/user/datos.txt
/home/user/datos2.txt
user@MiShell-PC:~$ find / txt | wc -l
2
```

### Ejemplo 5: Historial

```bash
user@MiShell-PC:~$ history
  1  mkdir proyectos
  2  cd proyectos
  3  touch readme.txt
  4  echo "Mi primer proyecto" > readme.txt
  5  cat readme.txt
  6  history
```

---

## 7. Estructura del Proyecto

```
terminal_tauri/
├── src/                          # Frontend (TypeScript)
│   ├── main.ts                   # Entry point - boot sequence
│   ├── desktop.ts                # Desktop icons + app launchers
│   ├── windowManager.ts          # Sistema de ventanas movibles/redimensionables
│   ├── taskbar.ts                # Barra de tareas con reloj
│   ├── startMenu.ts              # Menu Start con apps
│   ├── bootSequence.ts           # Animacion de boot/shutdown
│   ├── styles.css                # Estilos completos (desktop + apps)
│   ├── types.ts                  # Interfaces TypeScript
│   └── apps/
│       ├── terminal.ts           # Terminal app (input, output, autocomplete)
│       ├── fileExplorer.ts       # File Explorer app (arbol + grid)
│       └── taskManager.ts        # Task Manager app (procesos + memoria)
├── src-tauri/                    # Backend (Rust)
│   ├── src/
│   │   ├── main.rs               # Entry point Rust
│   │   ├── lib.rs                # Tauri commands + system stats
│   │   └── virtual_fs.rs         # Filesystem virtual completo
│   ├── Cargo.toml                # Dependencias Rust
│   └── tauri.conf.json           # Configuracion Tauri
├── index.html                    # HTML principal
├── package.json                  # Dependencias frontend
└── .github/workflows/build.yml   # CI/CD multiplataforma
```

---

## 8. Conclusiones

MiShell demuestra que los conceptos fundamentales de sistemas operativos — procesos, concurrencia, sincronizacion, gestion de memoria, pipes y redireccion — son **universales e independientes del lenguaje**. Aunque el rubric solicita C/C++, la implementacion en Rust aplica exactamente los mismos principios:

| Concepto | C/C++ | Rust (MiShell) | Resultado |
|----------|-------|----------------|-----------|
| Creacion de procesos | `fork()` | Thread pool de Tauri IPC | Aislamiento equivalente |
| Ejecucion de programas | `exec()` | Dispatch interno a funciones | Mismo patron, sin binarios externos |
| Espera de procesos | `waitpid()` | `Mutex::lock()` | Bloqueo hasta completar |
| Memoria dinamica | `malloc()/free()` | `String`, `Vec`, `Box` (RAII) | Zero leaks garantizados |
| Sincronizacion | `pthread_mutex` | `std::sync::Mutex` | Auto-unlock, sin deadlocks |
| Pipes | `pipe()/dup2()` | String flow entre comandos | Mismo flujo de datos |
| Redireccion | `open()/dup2()` | `write_file()/get_node()` | Misma semantica I/O |

La ventaja clave de Rust: **el compilador previene errores de memoria y concurrencia en tiempo de compilacion**, eliminando categorias completas de bugs que en C/C++ solo se detectan en tiempo de ejecucion (o nunca).
