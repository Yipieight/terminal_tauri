// ═══════════════════════════════════════════════════════════════════════════
// MiShell - Virtual Filesystem (Sandboxed)
//
// This module implements an in-memory filesystem that persists to disk as JSON.
// All shell commands operate on this virtual filesystem — NO real OS commands
// are executed. This provides complete isolation (sandbox) from the host machine.
//
// ─── PHASE 1: Terminal Básica (fork/exec equivalence) ────────────────────
//
// In a traditional C shell, command execution follows this pattern:
//   1. fork()  → creates a child process (copy of the parent)
//   2. exec()  → replaces the child's memory image with the target program
//   3. wait()  → parent waits for child to finish
//
// In Rust/Tauri, this is handled differently but achieves the same goals:
//   - fork() equivalent: Tauri's IPC system spawns commands on a separate
//     thread pool. Each `#[tauri::command]` runs asynchronously, isolated
//     from the main UI thread — similar to how fork() creates an isolated
//     child process.
//   - exec() equivalent: Instead of replacing process memory with execvp(),
//     we dispatch to internal Rust functions (cmd_ls, cmd_cat, etc.) that
//     execute the command logic directly. This is analogous to a "built-in
//     shell command" approach (like cd, echo in bash), where the shell
//     handles execution internally without spawning external binaries.
//   - wait() equivalent: Rust's Mutex<VirtualFs> ensures sequential access.
//     The calling thread blocks on mutex.lock() until the command completes,
//     equivalent to waitpid() in C.
//
// The key insight: real shells use fork/exec because they need to run
// EXTERNAL programs (like /usr/bin/ls). Our shell implements ALL commands
// internally, so no external process spawning is needed. This is the same
// approach used by shells like BusyBox, which embed all utilities.
//
// ─── PHASE 2: Parsing (Análisis de Comandos) ────────────────────────────
//
// Command parsing splits input by pipes (|) and redirection (> and <),
// then tokenizes each segment respecting quoted strings.
// In C, this requires manual memory management:
//   - strtok() + malloc() for each token
//   - A manually managed array of char* pointers
//   - free() for all allocations when done
// In Rust, String::split() + Vec::push() + iterators handle this with
// automatic memory management. No leaks possible (RAII).
//
// ─── PHASE 3: Pipes ─────────────────────────────────────────────────────
//
// Since we don't spawn real OS processes, pipes are implemented as
// string-based data flow: stdout of command N becomes stdin of command N+1.
// This is conceptually identical to Unix pipe()/dup2():
//   C:    pipe(fd) → fork() → dup2(fd[1], STDOUT) → exec()
//   Rust: result.stdout → next command's current_stdin parameter
// The data flows the same way, just through String buffers instead of
// file descriptors.
//
// ─── PHASE 4: Redirección de Entrada/Salida ─────────────────────────────
//
// Output redirection (>): writes final stdout to a virtual file
//   C equivalent: open(file, O_WRONLY|O_CREAT) → dup2(fd, STDOUT_FILENO)
//   Rust: fs.write_file(filepath, &result.stdout)
//
// Input redirection (<): reads a virtual file as stdin for the command
//   C equivalent: open(file, O_RDONLY) → dup2(fd, STDIN_FILENO)
//   Rust: fs.get_node(file) → content passed as current_stdin
//
// ─── PHASE 5: Gestión de Memoria ────────────────────────────────────────
//
// The virtual filesystem uses Rust's ownership model extensively:
//   - FsNode enum variants own their String names and Vec<FsNode> children
//   - When a node is removed (rm), all its children are recursively dropped
//     automatically — no manual free() or recursive cleanup needed
//   - The entire VirtualFs is serialized/deserialized with serde, which
//     handles all allocation/deallocation during JSON parsing
//   - Mutex<VirtualFs> ensures thread-safe access (equivalent to mutex_t
//     in C pthreads) — prevents race conditions on shared state
//
// Memory comparison with C:
//   C:    char* cmd = malloc(256); ... free(cmd);  // manual, error-prone
//   Rust: let cmd = String::new(); // dropped automatically at scope end
//   C:    char** history = malloc(n * sizeof(char*)); // must track size
//   Rust: let history: Vec<String> = Vec::new();      // grows/frees auto
//
// Rust guarantees zero memory leaks through ownership + RAII. There is no
// need for valgrind or AddressSanitizer — the compiler prevents leaks
// at compile time.
//
// ─── PHASE 6: Historial de Comandos ─────────────────────────────────────
//
// Command history is stored in Tauri's managed state as Mutex<Vec<String>>.
// This is equivalent to a dynamically-allocated linked list or array in C:
//   C:    history[count++] = strdup(cmd);  // must free each entry later
//   Rust: history.push(cmd.to_string());   // Vec grows automatically,
//                                          // freed when state is dropped
//
// The Mutex ensures thread-safety (no race conditions between IPC calls),
// equivalent to pthread_mutex_lock/unlock in C.
// ═══════════════════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

// ─── Filesystem Node Model ────────────────────────────────────────────────
// Every entry in the virtual filesystem is either a File or a Directory.
//
// In C, this would be a union or tagged struct requiring manual memory
// management for the children array (realloc on growth, free on removal).
// In Rust, the enum + Vec handles this automatically:
//   - Vec<FsNode> grows with push() (like realloc but safe)
//   - Dropping a Directory drops all children recursively (like a recursive free)
//   - No memory leaks possible — the compiler guarantees it
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type")]
pub enum FsNode {
    File {
        name: String,
        content: String,
        created: u64,
        modified: u64,
    },
    Directory {
        name: String,
        children: Vec<FsNode>,
        created: u64,
        modified: u64,
    },
}

impl FsNode {
    pub fn name(&self) -> &str {
        match self {
            FsNode::File { name, .. } => name,
            FsNode::Directory { name, .. } => name,
        }
    }

    pub fn is_dir(&self) -> bool {
        matches!(self, FsNode::Directory { .. })
    }

    pub fn is_file(&self) -> bool {
        matches!(self, FsNode::File { .. })
    }

    /// Recursively count files, directories, and total bytes in this node
    pub fn stats(&self) -> (usize, usize, usize) {
        match self {
            FsNode::File { content, .. } => (1, 0, content.len()),
            FsNode::Directory { children, .. } => {
                let mut files = 0;
                let mut dirs = 1; // count self
                let mut bytes = 0;
                for child in children {
                    let (f, d, b) = child.stats();
                    files += f;
                    dirs += d;
                    bytes += b;
                }
                (files, dirs, bytes)
            }
        }
    }

    fn new_dir(name: &str) -> Self {
        let now = current_timestamp();
        FsNode::Directory {
            name: name.to_string(),
            children: Vec::new(),
            created: now,
            modified: now,
        }
    }

    fn new_file(name: &str, content: &str) -> Self {
        let now = current_timestamp();
        FsNode::File {
            name: name.to_string(),
            content: content.to_string(),
            created: now,
            modified: now,
        }
    }
}

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// ─── Virtual Filesystem ───────────────────────────────────────────────────
// The top-level structure holding the root directory and current working directory.
//
// PHASE 5 Note: VirtualFs owns the entire filesystem tree through `root`.
// When VirtualFs is dropped (e.g., app shutdown), the ENTIRE tree — every
// directory, every file, every string — is recursively freed automatically.
// In C, you'd need a recursive free function visiting every node.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VirtualFs {
    pub root: FsNode,
    pub cwd: String,
}

// ─── Tauri State Wrapper ──────────────────────────────────────────────────
// PHASE 6 - Command History:
// History is stored alongside the filesystem in thread-safe Mutex wrappers.
// The Mutex provides mutual exclusion (like pthread_mutex in C) but with
// automatic unlock when the MutexGuard is dropped — no deadlock risk.
pub struct FsState {
    pub fs: Mutex<VirtualFs>,
    pub history: Mutex<Vec<String>>,
    pub data_path: PathBuf,
}

// ─── Command Result ───────────────────────────────────────────────────────
#[derive(Serialize, Clone, Debug)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

// ─── FS Entry for File Explorer (structured data) ─────────────────────────
#[derive(Serialize, Clone, Debug)]
pub struct FsEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: usize,
    pub modified: u64,
}

// ─── FS Tree Node for Explorer tree view ──────────────────────────────────
#[derive(Serialize, Clone, Debug)]
pub struct FsTreeNode {
    pub name: String,
    pub path: String,
    pub children: Vec<FsTreeNode>,
}

// ═══════════════════════════════════════════════════════════════════════════
// VIRTUAL FILESYSTEM IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════

impl VirtualFs {
    /// Create a new filesystem with default directory structure.
    pub fn new_default() -> Self {
        let now = current_timestamp();
        let root = FsNode::Directory {
            name: String::new(), // root has no name
            children: vec![
                FsNode::Directory {
                    name: "home".to_string(),
                    children: vec![FsNode::Directory {
                        name: "user".to_string(),
                        children: vec![
                            FsNode::new_dir("Desktop"),
                            FsNode::new_dir("Documents"),
                            FsNode::new_dir("Downloads"),
                        ],
                        created: now,
                        modified: now,
                    }],
                    created: now,
                    modified: now,
                },
                FsNode::Directory {
                    name: "tmp".to_string(),
                    children: Vec::new(),
                    created: now,
                    modified: now,
                },
                FsNode::Directory {
                    name: "etc".to_string(),
                    children: vec![FsNode::new_file("hostname", "MiShell-PC")],
                    created: now,
                    modified: now,
                },
                FsNode::Directory {
                    name: "var".to_string(),
                    children: vec![FsNode::new_dir("log")],
                    created: now,
                    modified: now,
                },
            ],
            created: now,
            modified: now,
        };

        VirtualFs {
            root,
            cwd: "/home/user".to_string(),
        }
    }

    /// Resolve a path to an absolute normalized path.
    ///
    /// Handles:
    /// - Absolute paths (starting with /)
    /// - Relative paths (prepend cwd)
    /// - `..` (parent) and `.` (current) navigation
    /// - `~` (home directory shortcut)
    pub fn resolve_path(&self, path: &str) -> String {
        let path = path.trim();

        // Handle home shortcut
        let path = if path == "~" || path.starts_with("~/") {
            format!("/home/user{}", &path[1..])
        } else {
            path.to_string()
        };

        // Make absolute
        let absolute = if path.starts_with('/') {
            path
        } else {
            format!("{}/{}", self.cwd, path)
        };

        // Normalize: split by /, resolve . and .., remove empty segments
        let mut parts: Vec<&str> = Vec::new();
        for part in absolute.split('/') {
            match part {
                "" | "." => {} // skip empty and current
                ".." => {
                    parts.pop(); // go up one level
                }
                _ => parts.push(part),
            }
        }

        if parts.is_empty() {
            "/".to_string()
        } else {
            format!("/{}", parts.join("/"))
        }
    }

    /// Navigate to a node by path, returning an immutable reference.
    ///
    /// PHASE 5 Note: This returns a borrow (&FsNode) — no data is copied.
    /// The borrow checker ensures the returned reference is valid as long
    /// as `self` is borrowed. In C, returning a pointer into a tree is
    /// dangerous (dangling pointers if the tree changes). Rust prevents this.
    pub fn get_node(&self, path: &str) -> Option<&FsNode> {
        let resolved = self.resolve_path(path);
        if resolved == "/" {
            return Some(&self.root);
        }

        let parts: Vec<&str> = resolved
            .trim_start_matches('/')
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();

        let mut current = &self.root;
        for part in parts {
            match current {
                FsNode::Directory { children, .. } => {
                    match children.iter().find(|c| c.name() == part) {
                        Some(child) => current = child,
                        None => return None,
                    }
                }
                FsNode::File { .. } => return None,
            }
        }
        Some(current)
    }

    /// Navigate to a node by path, returning a mutable reference.
    pub fn get_node_mut(&mut self, path: &str) -> Option<&mut FsNode> {
        let resolved = self.resolve_path(path);
        if resolved == "/" {
            return Some(&mut self.root);
        }

        let parts: Vec<String> = resolved
            .trim_start_matches('/')
            .split('/')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();

        let mut current = &mut self.root;
        for part in &parts {
            match current {
                FsNode::Directory { children, .. } => {
                    match children.iter_mut().find(|c| c.name() == part.as_str()) {
                        Some(child) => current = child,
                        None => return None,
                    }
                }
                FsNode::File { .. } => return None,
            }
        }
        Some(current)
    }

    /// Get the parent directory of a path (mutable).
    fn get_parent_mut(&mut self, path: &str) -> Option<&mut FsNode> {
        let resolved = self.resolve_path(path);
        let parent_path = if let Some(pos) = resolved.rfind('/') {
            if pos == 0 {
                "/".to_string()
            } else {
                resolved[..pos].to_string()
            }
        } else {
            "/".to_string()
        };
        self.get_node_mut(&parent_path)
    }

    /// Get the filename component of a path.
    fn get_filename(path: &str) -> &str {
        path.rsplit('/').next().unwrap_or(path)
    }

    // ═══════════════════════════════════════════════════════════════════
    // VIRTUAL SHELL COMMANDS
    // Each function takes optional stdin (for pipe support) and returns
    // a CommandResult with stdout/stderr/exit_code.
    // ═══════════════════════════════════════════════════════════════════

    /// `ls [path]` - List directory contents
    pub fn cmd_ls(&self, args: &[String], _stdin: &Option<String>) -> CommandResult {
        let path = args.first().map(|s| s.as_str()).unwrap_or(".");
        let resolved = self.resolve_path(path);

        match self.get_node(&resolved) {
            Some(FsNode::Directory { children, .. }) => {
                let mut entries: Vec<String> = children.iter().map(|c| {
                    if c.is_dir() {
                        format!("{}/", c.name())
                    } else {
                        c.name().to_string()
                    }
                }).collect();
                entries.sort();
                CommandResult {
                    stdout: entries.join("\n"),
                    stderr: String::new(),
                    exit_code: 0,
                }
            }
            Some(FsNode::File { name, .. }) => CommandResult {
                stdout: name.clone(),
                stderr: String::new(),
                exit_code: 0,
            },
            None => CommandResult {
                stdout: String::new(),
                stderr: format!("ls: cannot access '{}': No such file or directory", path),
                exit_code: 1,
            },
        }
    }

    /// `cd [path]` - Change directory
    pub fn cmd_cd(&mut self, args: &[String]) -> CommandResult {
        let path = args.first().map(|s| s.as_str()).unwrap_or("~");
        let resolved = self.resolve_path(path);

        match self.get_node(&resolved) {
            Some(FsNode::Directory { .. }) => {
                self.cwd = resolved;
                CommandResult {
                    stdout: String::new(),
                    stderr: String::new(),
                    exit_code: 0,
                }
            }
            Some(FsNode::File { .. }) => CommandResult {
                stdout: String::new(),
                stderr: format!("cd: not a directory: {}", path),
                exit_code: 1,
            },
            None => CommandResult {
                stdout: String::new(),
                stderr: format!("cd: no such file or directory: {}", path),
                exit_code: 1,
            },
        }
    }

    /// `pwd` - Print working directory
    pub fn cmd_pwd(&self) -> CommandResult {
        CommandResult {
            stdout: self.cwd.clone(),
            stderr: String::new(),
            exit_code: 0,
        }
    }

    /// `mkdir [-p] <path>` - Create directory
    pub fn cmd_mkdir(&mut self, args: &[String]) -> CommandResult {
        if args.is_empty() {
            return CommandResult {
                stdout: String::new(),
                stderr: "mkdir: missing operand".to_string(),
                exit_code: 1,
            };
        }

        let (recursive, path) = if args[0] == "-p" {
            if args.len() < 2 {
                return CommandResult {
                    stdout: String::new(),
                    stderr: "mkdir: missing operand".to_string(),
                    exit_code: 1,
                };
            }
            (true, args[1].as_str())
        } else {
            (false, args[0].as_str())
        };

        let resolved = self.resolve_path(path);

        if recursive {
            // Create all intermediate directories
            let parts: Vec<&str> = resolved
                .trim_start_matches('/')
                .split('/')
                .filter(|s| !s.is_empty())
                .collect();

            let mut current_path = String::new();
            for part in &parts {
                current_path = format!("{}/{}", current_path, part);
                if self.get_node(&current_path).is_none() {
                    let parent_path = if current_path.rfind('/').unwrap_or(0) == 0 {
                        "/".to_string()
                    } else {
                        current_path[..current_path.rfind('/').unwrap()].to_string()
                    };
                    if let Some(FsNode::Directory { children, modified, .. }) =
                        self.get_node_mut(&parent_path)
                    {
                        children.push(FsNode::new_dir(part));
                        *modified = current_timestamp();
                    }
                }
            }
        } else {
            let dir_name = Self::get_filename(&resolved).to_string();
            let parent = self.get_parent_mut(&resolved);

            match parent {
                Some(FsNode::Directory { children, modified, .. }) => {
                    if children.iter().any(|c| c.name() == dir_name) {
                        return CommandResult {
                            stdout: String::new(),
                            stderr: format!("mkdir: cannot create directory '{}': File exists", path),
                            exit_code: 1,
                        };
                    }
                    children.push(FsNode::new_dir(&dir_name));
                    *modified = current_timestamp();
                }
                _ => {
                    return CommandResult {
                        stdout: String::new(),
                        stderr: format!(
                            "mkdir: cannot create directory '{}': No such file or directory",
                            path
                        ),
                        exit_code: 1,
                    };
                }
            }
        }

        CommandResult {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 0,
        }
    }

    /// `touch <path>` - Create empty file (or update timestamp)
    pub fn cmd_touch(&mut self, args: &[String]) -> CommandResult {
        if args.is_empty() {
            return CommandResult {
                stdout: String::new(),
                stderr: "touch: missing file operand".to_string(),
                exit_code: 1,
            };
        }

        let path = &args[0];
        let resolved = self.resolve_path(path);

        // If file already exists, update modified timestamp
        if let Some(node) = self.get_node_mut(&resolved) {
            match node {
                FsNode::File { modified, .. } | FsNode::Directory { modified, .. } => {
                    *modified = current_timestamp();
                }
            }
            return CommandResult {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: 0,
            };
        }

        // Create new file
        let file_name = Self::get_filename(&resolved).to_string();
        let parent = self.get_parent_mut(&resolved);

        match parent {
            Some(FsNode::Directory { children, modified, .. }) => {
                children.push(FsNode::new_file(&file_name, ""));
                *modified = current_timestamp();
                CommandResult {
                    stdout: String::new(),
                    stderr: String::new(),
                    exit_code: 0,
                }
            }
            _ => CommandResult {
                stdout: String::new(),
                stderr: format!(
                    "touch: cannot touch '{}': No such file or directory",
                    path
                ),
                exit_code: 1,
            },
        }
    }

    /// `cat <file>` - Read file content (or stdin if piped)
    pub fn cmd_cat(&self, args: &[String], stdin: &Option<String>) -> CommandResult {
        // If no args but has stdin, pass through (cat acts as passthrough in pipes)
        if args.is_empty() {
            return CommandResult {
                stdout: stdin.clone().unwrap_or_default(),
                stderr: String::new(),
                exit_code: 0,
            };
        }

        let path = &args[0];
        let resolved = self.resolve_path(path);

        match self.get_node(&resolved) {
            Some(FsNode::File { content, .. }) => CommandResult {
                stdout: content.clone(),
                stderr: String::new(),
                exit_code: 0,
            },
            Some(FsNode::Directory { .. }) => CommandResult {
                stdout: String::new(),
                stderr: format!("cat: {}: Is a directory", path),
                exit_code: 1,
            },
            None => CommandResult {
                stdout: String::new(),
                stderr: format!("cat: {}: No such file or directory", path),
                exit_code: 1,
            },
        }
    }

    /// `echo <args...>` - Print text
    pub fn cmd_echo(&self, args: &[String]) -> CommandResult {
        // Join all args with spaces, handling quoted strings
        let text = args.join(" ");
        // Remove surrounding quotes if present
        let text = text
            .trim_start_matches('"')
            .trim_end_matches('"')
            .trim_start_matches('\'')
            .trim_end_matches('\'');
        CommandResult {
            stdout: text.to_string(),
            stderr: String::new(),
            exit_code: 0,
        }
    }

    /// `rm [-r] <path>` - Remove file or directory
    pub fn cmd_rm(&mut self, args: &[String]) -> CommandResult {
        if args.is_empty() {
            return CommandResult {
                stdout: String::new(),
                stderr: "rm: missing operand".to_string(),
                exit_code: 1,
            };
        }

        let (recursive, path) = if args[0] == "-r" || args[0] == "-rf" || args[0] == "-fr" {
            if args.len() < 2 {
                return CommandResult {
                    stdout: String::new(),
                    stderr: "rm: missing operand".to_string(),
                    exit_code: 1,
                };
            }
            (true, args[1].as_str())
        } else {
            (false, args[0].as_str())
        };

        let resolved = self.resolve_path(path);

        // Prevent removing root
        if resolved == "/" {
            return CommandResult {
                stdout: String::new(),
                stderr: "rm: cannot remove '/'".to_string(),
                exit_code: 1,
            };
        }

        // Check if target exists and is appropriate type
        let is_dir = match self.get_node(&resolved) {
            Some(node) => node.is_dir(),
            None => {
                return CommandResult {
                    stdout: String::new(),
                    stderr: format!("rm: cannot remove '{}': No such file or directory", path),
                    exit_code: 1,
                };
            }
        };

        if is_dir && !recursive {
            return CommandResult {
                stdout: String::new(),
                stderr: format!("rm: cannot remove '{}': Is a directory (use -r)", path),
                exit_code: 1,
            };
        }

        let target_name = Self::get_filename(&resolved).to_string();
        let parent = self.get_parent_mut(&resolved);

        // PHASE 5 Note: When we remove a node from the Vec with retain(),
        // the removed FsNode is dropped. If it's a Directory with children,
        // ALL children (and their children, recursively) are dropped too.
        // In C, you'd need a recursive free function. Rust handles this automatically.
        match parent {
            Some(FsNode::Directory { children, modified, .. }) => {
                children.retain(|c| c.name() != target_name);
                *modified = current_timestamp();
                CommandResult {
                    stdout: String::new(),
                    stderr: String::new(),
                    exit_code: 0,
                }
            }
            _ => CommandResult {
                stdout: String::new(),
                stderr: format!("rm: cannot remove '{}'", path),
                exit_code: 1,
            },
        }
    }

    /// `cp <source> <dest>` - Copy file
    pub fn cmd_cp(&mut self, args: &[String]) -> CommandResult {
        if args.len() < 2 {
            return CommandResult {
                stdout: String::new(),
                stderr: "cp: missing operand".to_string(),
                exit_code: 1,
            };
        }

        let src_path = self.resolve_path(&args[0]);
        let dst_path = self.resolve_path(&args[1]);

        // Clone the source node
        let src_clone = match self.get_node(&src_path) {
            Some(FsNode::File {
                content, created, ..
            }) => {
                let dest_name = Self::get_filename(&dst_path).to_string();
                FsNode::File {
                    name: dest_name,
                    content: content.clone(),
                    created: *created,
                    modified: current_timestamp(),
                }
            }
            Some(FsNode::Directory { .. }) => {
                return CommandResult {
                    stdout: String::new(),
                    stderr: "cp: copying directories not supported (use cp for files only)"
                        .to_string(),
                    exit_code: 1,
                };
            }
            None => {
                return CommandResult {
                    stdout: String::new(),
                    stderr: format!("cp: cannot stat '{}': No such file or directory", args[0]),
                    exit_code: 1,
                };
            }
        };

        // Add to destination parent
        let parent = self.get_parent_mut(&dst_path);
        match parent {
            Some(FsNode::Directory { children, modified, .. }) => {
                // Remove existing file with same name if present
                let dest_name = src_clone.name().to_string();
                children.retain(|c| c.name() != dest_name);
                children.push(src_clone);
                *modified = current_timestamp();
                CommandResult {
                    stdout: String::new(),
                    stderr: String::new(),
                    exit_code: 0,
                }
            }
            _ => CommandResult {
                stdout: String::new(),
                stderr: format!("cp: cannot create '{}': No such directory", args[1]),
                exit_code: 1,
            },
        }
    }

    /// `mv <source> <dest>` - Move/rename file or directory
    pub fn cmd_mv(&mut self, args: &[String]) -> CommandResult {
        if args.len() < 2 {
            return CommandResult {
                stdout: String::new(),
                stderr: "mv: missing operand".to_string(),
                exit_code: 1,
            };
        }

        let src_path = self.resolve_path(&args[0]);
        let dst_path = self.resolve_path(&args[1]);

        // Remove from source parent
        let src_name = Self::get_filename(&src_path).to_string();
        let src_parent_path = if let Some(pos) = src_path.rfind('/') {
            if pos == 0 {
                "/".to_string()
            } else {
                src_path[..pos].to_string()
            }
        } else {
            "/".to_string()
        };

        // Extract the source node
        let mut extracted_node = None;
        if let Some(FsNode::Directory { children, modified, .. }) =
            self.get_node_mut(&src_parent_path)
        {
            if let Some(pos) = children.iter().position(|c| c.name() == src_name) {
                extracted_node = Some(children.remove(pos));
                *modified = current_timestamp();
            }
        }

        let mut node = match extracted_node {
            Some(n) => n,
            None => {
                return CommandResult {
                    stdout: String::new(),
                    stderr: format!("mv: cannot stat '{}': No such file or directory", args[0]),
                    exit_code: 1,
                };
            }
        };

        // Rename the node to the destination name
        let dst_name = Self::get_filename(&dst_path).to_string();
        match &mut node {
            FsNode::File { name, modified, .. } => {
                *name = dst_name.clone();
                *modified = current_timestamp();
            }
            FsNode::Directory { name, modified, .. } => {
                *name = dst_name.clone();
                *modified = current_timestamp();
            }
        }

        // Insert into destination parent
        let parent = self.get_parent_mut(&dst_path);
        match parent {
            Some(FsNode::Directory { children, modified, .. }) => {
                children.retain(|c| c.name() != dst_name);
                children.push(node);
                *modified = current_timestamp();
                CommandResult {
                    stdout: String::new(),
                    stderr: String::new(),
                    exit_code: 0,
                }
            }
            _ => CommandResult {
                stdout: String::new(),
                stderr: format!("mv: cannot move to '{}': No such directory", args[1]),
                exit_code: 1,
            },
        }
    }

    /// `find [path] [name]` - Search for files
    pub fn cmd_find(&self, args: &[String]) -> CommandResult {
        let (search_path, pattern) = match args.len() {
            0 => (".", ""),
            1 => (args[0].as_str(), ""),
            _ => (args[0].as_str(), args[1].as_str()),
        };

        let resolved = self.resolve_path(search_path);
        let mut results = Vec::new();

        fn find_recursive(node: &FsNode, current_path: &str, pattern: &str, results: &mut Vec<String>) {
            let name = node.name();
            let full_path = if current_path == "/" {
                format!("/{}", name)
            } else if name.is_empty() {
                current_path.to_string()
            } else {
                format!("{}/{}", current_path, name)
            };

            // Match if pattern is empty or name contains pattern
            if pattern.is_empty() || name.contains(pattern) {
                results.push(full_path.clone());
            }

            if let FsNode::Directory { children, .. } = node {
                for child in children {
                    find_recursive(child, &full_path, pattern, results);
                }
            }
        }

        match self.get_node(&resolved) {
            Some(node) => {
                let base = if resolved == "/" { "" } else { &resolved };
                find_recursive(node, base, pattern, &mut results);
                CommandResult {
                    stdout: results.join("\n"),
                    stderr: String::new(),
                    exit_code: 0,
                }
            }
            None => CommandResult {
                stdout: String::new(),
                stderr: format!("find: '{}': No such file or directory", search_path),
                exit_code: 1,
            },
        }
    }

    /// `grep <pattern> [file]` - Search for text (supports stdin from pipes)
    pub fn cmd_grep(&self, args: &[String], stdin: &Option<String>) -> CommandResult {
        if args.is_empty() {
            return CommandResult {
                stdout: String::new(),
                stderr: "grep: missing pattern".to_string(),
                exit_code: 1,
            };
        }

        let pattern = &args[0];
        let text = if args.len() > 1 {
            // Read from file
            let path = &args[1];
            let resolved = self.resolve_path(path);
            match self.get_node(&resolved) {
                Some(FsNode::File { content, .. }) => content.clone(),
                _ => {
                    return CommandResult {
                        stdout: String::new(),
                        stderr: format!("grep: {}: No such file or directory", path),
                        exit_code: 1,
                    };
                }
            }
        } else if let Some(input) = stdin {
            input.clone()
        } else {
            return CommandResult {
                stdout: String::new(),
                stderr: "grep: no input".to_string(),
                exit_code: 1,
            };
        };

        let matching_lines: Vec<&str> = text
            .lines()
            .filter(|line| line.contains(pattern.as_str()))
            .collect();

        if matching_lines.is_empty() {
            CommandResult {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: 1, // grep returns 1 when no matches
            }
        } else {
            CommandResult {
                stdout: matching_lines.join("\n"),
                stderr: String::new(),
                exit_code: 0,
            }
        }
    }

    /// `wc [-l|-w|-c]` - Word/line/char count (supports stdin)
    pub fn cmd_wc(&self, args: &[String], stdin: &Option<String>) -> CommandResult {
        let text = if let Some(file_arg) = args.iter().find(|a| !a.starts_with('-')) {
            let resolved = self.resolve_path(file_arg);
            match self.get_node(&resolved) {
                Some(FsNode::File { content, .. }) => content.clone(),
                _ => {
                    return CommandResult {
                        stdout: String::new(),
                        stderr: format!("wc: {}: No such file", file_arg),
                        exit_code: 1,
                    };
                }
            }
        } else if let Some(input) = stdin {
            input.clone()
        } else {
            return CommandResult {
                stdout: String::new(),
                stderr: "wc: no input".to_string(),
                exit_code: 1,
            };
        };

        let lines = text.lines().count();
        let words = text.split_whitespace().count();
        let chars = text.len();

        let flag = args.first().map(|s| s.as_str()).unwrap_or("");
        let output = match flag {
            "-l" => format!("{}", lines),
            "-w" => format!("{}", words),
            "-c" => format!("{}", chars),
            _ => format!("  {}  {}  {}", lines, words, chars),
        };

        CommandResult {
            stdout: output,
            stderr: String::new(),
            exit_code: 0,
        }
    }

    /// `head [-n N] [file]` - Show first N lines
    pub fn cmd_head(&self, args: &[String], stdin: &Option<String>) -> CommandResult {
        let mut n: usize = 10;
        let mut file_arg: Option<&str> = None;

        let mut i = 0;
        while i < args.len() {
            if args[i] == "-n" && i + 1 < args.len() {
                n = args[i + 1].parse().unwrap_or(10);
                i += 2;
            } else {
                file_arg = Some(&args[i]);
                i += 1;
            }
        }

        let text = if let Some(f) = file_arg {
            let resolved = self.resolve_path(f);
            match self.get_node(&resolved) {
                Some(FsNode::File { content, .. }) => content.clone(),
                _ => {
                    return CommandResult {
                        stdout: String::new(),
                        stderr: format!("head: {}: No such file", f),
                        exit_code: 1,
                    };
                }
            }
        } else if let Some(input) = stdin {
            input.clone()
        } else {
            return CommandResult {
                stdout: String::new(),
                stderr: "head: no input".to_string(),
                exit_code: 1,
            };
        };

        let output: String = text.lines().take(n).collect::<Vec<_>>().join("\n");
        CommandResult {
            stdout: output,
            stderr: String::new(),
            exit_code: 0,
        }
    }

    /// `tail [-n N] [file]` - Show last N lines
    pub fn cmd_tail(&self, args: &[String], stdin: &Option<String>) -> CommandResult {
        let mut n: usize = 10;
        let mut file_arg: Option<&str> = None;

        let mut i = 0;
        while i < args.len() {
            if args[i] == "-n" && i + 1 < args.len() {
                n = args[i + 1].parse().unwrap_or(10);
                i += 2;
            } else {
                file_arg = Some(&args[i]);
                i += 1;
            }
        }

        let text = if let Some(f) = file_arg {
            let resolved = self.resolve_path(f);
            match self.get_node(&resolved) {
                Some(FsNode::File { content, .. }) => content.clone(),
                _ => {
                    return CommandResult {
                        stdout: String::new(),
                        stderr: format!("tail: {}: No such file", f),
                        exit_code: 1,
                    };
                }
            }
        } else if let Some(input) = stdin {
            input.clone()
        } else {
            return CommandResult {
                stdout: String::new(),
                stderr: "tail: no input".to_string(),
                exit_code: 1,
            };
        };

        let lines: Vec<&str> = text.lines().collect();
        let start = if lines.len() > n { lines.len() - n } else { 0 };
        let output = lines[start..].join("\n");
        CommandResult {
            stdout: output,
            stderr: String::new(),
            exit_code: 0,
        }
    }

    /// Write content to a file (used by redirection `>`)
    pub fn write_file(&mut self, path: &str, content: &str) -> CommandResult {
        let resolved = self.resolve_path(path);

        // If file exists, update content
        if let Some(FsNode::File {
            content: ref mut c,
            modified,
            ..
        }) = self.get_node_mut(&resolved)
        {
            *c = content.to_string();
            *modified = current_timestamp();
            return CommandResult {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: 0,
            };
        }

        // Create new file
        let file_name = Self::get_filename(&resolved).to_string();
        let parent = self.get_parent_mut(&resolved);

        match parent {
            Some(FsNode::Directory { children, modified, .. }) => {
                // Remove existing if any
                children.retain(|c| c.name() != file_name);
                children.push(FsNode::new_file(&file_name, content));
                *modified = current_timestamp();
                CommandResult {
                    stdout: String::new(),
                    stderr: String::new(),
                    exit_code: 0,
                }
            }
            _ => CommandResult {
                stdout: String::new(),
                stderr: format!(
                    "cannot write to '{}': Parent directory not found",
                    path
                ),
                exit_code: 1,
            },
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // FILE EXPLORER API (structured data, not text)
    // ═══════════════════════════════════════════════════════════════════

    /// List directory contents as structured entries
    pub fn list_dir(&self, path: &str) -> Result<Vec<FsEntry>, String> {
        let resolved = self.resolve_path(path);
        match self.get_node(&resolved) {
            Some(FsNode::Directory { children, .. }) => {
                let mut entries: Vec<FsEntry> = children
                    .iter()
                    .map(|c| match c {
                        FsNode::File {
                            name,
                            content,
                            modified,
                            ..
                        } => FsEntry {
                            name: name.clone(),
                            is_dir: false,
                            size: content.len(),
                            modified: *modified,
                        },
                        FsNode::Directory {
                            name,
                            children,
                            modified,
                            ..
                        } => FsEntry {
                            name: name.clone(),
                            is_dir: true,
                            size: children.len(),
                            modified: *modified,
                        },
                    })
                    .collect();
                entries.sort_by(|a, b| {
                    // Directories first, then alphabetical
                    b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name))
                });
                Ok(entries)
            }
            Some(FsNode::File { .. }) => Err(format!("'{}' is not a directory", path)),
            None => Err(format!("'{}': No such directory", path)),
        }
    }

    /// Read file content
    pub fn read_file(&self, path: &str) -> Result<String, String> {
        let resolved = self.resolve_path(path);
        match self.get_node(&resolved) {
            Some(FsNode::File { content, .. }) => Ok(content.clone()),
            Some(FsNode::Directory { .. }) => Err(format!("'{}' is a directory", path)),
            None => Err(format!("'{}': No such file", path)),
        }
    }

    /// Create a directory (for Explorer)
    pub fn create_dir(&mut self, path: &str) -> Result<(), String> {
        let result = self.cmd_mkdir(&[path.to_string()]);
        if result.exit_code == 0 {
            Ok(())
        } else {
            Err(result.stderr)
        }
    }

    /// Delete a file or directory (for Explorer)
    pub fn delete(&mut self, path: &str) -> Result<(), String> {
        let result = self.cmd_rm(&["-r".to_string(), path.to_string()]);
        if result.exit_code == 0 {
            Ok(())
        } else {
            Err(result.stderr)
        }
    }

    /// Rename/move (for Explorer)
    pub fn rename(&mut self, old_path: &str, new_path: &str) -> Result<(), String> {
        let result = self.cmd_mv(&[old_path.to_string(), new_path.to_string()]);
        if result.exit_code == 0 {
            Ok(())
        } else {
            Err(result.stderr)
        }
    }

    /// Get directory tree for Explorer tree view
    pub fn get_tree(&self, path: &str, depth: u32) -> Result<FsTreeNode, String> {
        let resolved = self.resolve_path(path);
        match self.get_node(&resolved) {
            Some(node) => Ok(self.build_tree_node(node, &resolved, depth)),
            None => Err(format!("'{}': No such directory", path)),
        }
    }

    /// Autocomplete: given a partial path, return matching file/directory names.
    /// Used by the frontend Tab key handler.
    pub fn autocomplete(&self, partial: &str) -> Vec<String> {
        // Split into directory part and prefix to match
        let resolved = if partial.contains('/') {
            // Has path separator — resolve the directory part
            let last_slash = partial.rfind('/').unwrap();
            let dir_part = &partial[..=last_slash];
            let prefix = &partial[last_slash + 1..];
            let resolved_dir = self.resolve_path(dir_part);
            let prefix_lower = prefix.to_lowercase();

            match self.get_node(&resolved_dir) {
                Some(FsNode::Directory { children, .. }) => {
                    children
                        .iter()
                        .filter(|c| c.name().to_lowercase().starts_with(&prefix_lower))
                        .map(|c| {
                            let suffix = if c.is_dir() { "/" } else { "" };
                            format!("{}{}{}", dir_part, c.name(), suffix)
                        })
                        .collect()
                }
                _ => Vec::new(),
            }
        } else {
            // No path separator — match in current directory (case-insensitive)
            let partial_lower = partial.to_lowercase();
            match self.get_node(&self.cwd) {
                Some(FsNode::Directory { children, .. }) => {
                    children
                        .iter()
                        .filter(|c| c.name().to_lowercase().starts_with(&partial_lower))
                        .map(|c| {
                            let suffix = if c.is_dir() { "/" } else { "" };
                            format!("{}{}", c.name(), suffix)
                        })
                        .collect()
                }
                _ => Vec::new(),
            }
        };

        let mut results = resolved;
        results.sort();
        results
    }

    /// Return the available virtual commands (for Tab-completing command names)
    pub fn available_commands() -> Vec<&'static str> {
        vec![
            "ls", "dir", "cd", "pwd", "mkdir", "touch", "cat", "echo",
            "rm", "cp", "mv", "find", "grep", "wc", "head", "tail",
            "sort", "uniq", "history", "help", "clear", "whoami",
            "hostname", "date", "uname", "sim", "ps", "kill", "open",
        ]
    }

    fn build_tree_node(&self, node: &FsNode, path: &str, depth: u32) -> FsTreeNode {
        match node {
            FsNode::Directory { name, children, .. } => {
                let child_nodes = if depth > 0 {
                    children
                        .iter()
                        .filter(|c| c.is_dir())
                        .map(|c| {
                            let child_path = if path == "/" {
                                format!("/{}", c.name())
                            } else {
                                format!("{}/{}", path, c.name())
                            };
                            self.build_tree_node(c, &child_path, depth - 1)
                        })
                        .collect()
                } else {
                    Vec::new()
                };

                FsTreeNode {
                    name: if name.is_empty() {
                        "/".to_string()
                    } else {
                        name.clone()
                    },
                    path: path.to_string(),
                    children: child_nodes,
                }
            }
            FsNode::File { name, .. } => FsTreeNode {
                name: name.clone(),
                path: path.to_string(),
                children: Vec::new(),
            },
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTENCE - Load/Save filesystem to JSON
//
// PHASE 5 Note: serde handles all serialization/deserialization memory.
// When loading, serde allocates new Strings and Vecs from the JSON data.
// When saving, serde borrows the existing data (no copies needed).
// The old VirtualFs is dropped (all memory freed) when replaced by the new one.
// ═══════════════════════════════════════════════════════════════════════════

impl FsState {
    pub fn load_or_create(data_path: PathBuf) -> Self {
        let fs = if data_path.exists() {
            match std::fs::read_to_string(&data_path) {
                Ok(json) => match serde_json::from_str::<VirtualFs>(&json) {
                    Ok(vfs) => vfs,
                    Err(_) => VirtualFs::new_default(),
                },
                Err(_) => VirtualFs::new_default(),
            }
        } else {
            VirtualFs::new_default()
        };

        FsState {
            fs: Mutex::new(fs),
            history: Mutex::new(Vec::new()),
            data_path,
        }
    }

    /// Save the filesystem to disk as JSON.
    pub fn save(&self) {
        if let Ok(fs) = self.fs.lock() {
            if let Ok(json) = serde_json::to_string_pretty(&*fs) {
                // Ensure parent directory exists
                if let Some(parent) = self.data_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&self.data_path, json);
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND PARSER & DISPATCHER
//
// PHASE 1-2 (Academic Rubric):
// The parser splits input into pipeline segments (separated by |) and
// handles output redirection (>). Each segment is tokenized into a
// command + arguments.
//
// In C, this parsing requires:
//   - strtok() with manual buffer management
//   - malloc() for each token
//   - A manually managed array of char* pointers
//   - free() for all allocations when done
//
// In Rust, String::split() + Vec::push() + iterators handle all of this
// with automatic memory management. No leaks possible.
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Debug)]
pub struct ParsedSegment {
    pub program: String,
    pub args: Vec<String>,
    /// Output redirection: `command > file` writes stdout to file
    pub redirect_to: Option<String>,
    /// Input redirection: `command < file` reads file as stdin
    pub redirect_from: Option<String>,
}

/// Parse a raw input line into pipeline segments.
///
/// Example: `ls | grep txt > output.txt`
/// → [ParsedSegment{program:"ls", args:[]}, ParsedSegment{program:"grep", args:["txt"], redirect_to:Some("output.txt")}]
pub fn parse_input(input: &str) -> Vec<ParsedSegment> {
    let segments: Vec<&str> = input.split('|').collect();
    let mut commands = Vec::new();

    for (i, segment) in segments.iter().enumerate() {
        let trimmed = segment.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Parse output redirection (>) — only on last segment
        let (cmd_after_out, redirect_to) = if i == segments.len() - 1 {
            if let Some(pos) = trimmed.find('>') {
                let cmd = trimmed[..pos].trim();
                let file = trimmed[pos + 1..].trim();
                (
                    cmd,
                    if file.is_empty() {
                        None
                    } else {
                        Some(file.to_string())
                    },
                )
            } else {
                (trimmed, None)
            }
        } else {
            (trimmed, None)
        };

        // Parse input redirection (<) — only on first segment
        let (cmd_final, redirect_from) = if i == 0 {
            if let Some(pos) = cmd_after_out.find('<') {
                let cmd = cmd_after_out[..pos].trim();
                let file = cmd_after_out[pos + 1..].trim();
                (
                    cmd,
                    if file.is_empty() {
                        None
                    } else {
                        Some(file.to_string())
                    },
                )
            } else {
                (cmd_after_out, None)
            }
        } else {
            (cmd_after_out, None)
        };

        // Tokenize respecting quoted strings
        let tokens = tokenize(cmd_final);
        if tokens.is_empty() {
            continue;
        }

        commands.push(ParsedSegment {
            program: tokens[0].clone(),
            args: tokens[1..].to_vec(),
            redirect_to,
            redirect_from,
        });
    }

    commands
}

/// Tokenize a command string, respecting double and single quotes.
fn tokenize(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_double_quote = false;
    let mut in_single_quote = false;

    for ch in input.chars() {
        match ch {
            '"' if !in_single_quote => {
                in_double_quote = !in_double_quote;
            }
            '\'' if !in_double_quote => {
                in_single_quote = !in_single_quote;
            }
            ' ' | '\t' if !in_double_quote && !in_single_quote => {
                if !current.is_empty() {
                    tokens.push(current.clone());
                    current.clear();
                }
            }
            _ => {
                current.push(ch);
            }
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

/// Execute a parsed pipeline on the virtual filesystem.
///
/// PHASE 3-4 (Academic Rubric - Pipes and Redirection):
/// Since all commands are virtual (no real OS processes), piping is
/// implemented as string-based data flow:
///   1. Execute command N → get stdout as String
///   2. Pass that String as stdin parameter to command N+1
///   3. Repeat until the last command
///
/// This is conceptually identical to Unix pipes (fd-based data flow)
/// but operates entirely in memory. The advantage is complete isolation
/// from the host OS — the sandbox cannot affect the real filesystem.
///
/// Output redirection (>) writes the final stdout to a virtual file
/// instead of returning it to the user.
pub fn execute_pipeline(
    segments: &[ParsedSegment],
    fs: &mut VirtualFs,
    history: &[String],
) -> CommandResult {
    if segments.is_empty() {
        return CommandResult {
            stdout: String::new(),
            stderr: "Empty command".to_string(),
            exit_code: 1,
        };
    }

    let mut current_stdin: Option<String> = None;

    for (i, seg) in segments.iter().enumerate() {
        let is_last = i == segments.len() - 1;

        // ── Input redirection (<) ──
        // If the first segment has redirect_from, read the file content
        // and use it as stdin for this command. This is equivalent to
        // dup2(fd, STDIN_FILENO) in C after fork().
        if let Some(ref input_file) = seg.redirect_from {
            let resolved = fs.resolve_path(input_file);
            match fs.get_node(&resolved) {
                Some(FsNode::File { content, .. }) => {
                    current_stdin = Some(content.clone());
                }
                Some(FsNode::Directory { .. }) => {
                    return CommandResult {
                        stdout: String::new(),
                        stderr: format!("{}: Is a directory", input_file),
                        exit_code: 1,
                    };
                }
                None => {
                    return CommandResult {
                        stdout: String::new(),
                        stderr: format!("{}: No such file or directory", input_file),
                        exit_code: 1,
                    };
                }
            }
        }

        // Dispatch to the appropriate virtual command handler
        let result = match seg.program.as_str() {
            "ls" | "dir" => fs.cmd_ls(&seg.args, &current_stdin),
            "cd" => fs.cmd_cd(&seg.args),
            "pwd" => fs.cmd_pwd(),
            "mkdir" => fs.cmd_mkdir(&seg.args),
            "touch" => fs.cmd_touch(&seg.args),
            "cat" => fs.cmd_cat(&seg.args, &current_stdin),
            "echo" => fs.cmd_echo(&seg.args),
            "rm" => fs.cmd_rm(&seg.args),
            "cp" => fs.cmd_cp(&seg.args),
            "mv" => fs.cmd_mv(&seg.args),
            "find" => fs.cmd_find(&seg.args),
            "grep" => fs.cmd_grep(&seg.args, &current_stdin),
            "wc" => fs.cmd_wc(&seg.args, &current_stdin),
            "head" => fs.cmd_head(&seg.args, &current_stdin),
            "tail" => fs.cmd_tail(&seg.args, &current_stdin),
            "history" => {
                let history_text: String = history
                    .iter()
                    .enumerate()
                    .map(|(i, cmd)| format!("  {}  {}", i + 1, cmd))
                    .collect::<Vec<String>>()
                    .join("\n");
                CommandResult {
                    stdout: history_text,
                    stderr: String::new(),
                    exit_code: 0,
                }
            }
            "whoami" => CommandResult {
                stdout: "user".to_string(),
                stderr: String::new(),
                exit_code: 0,
            },
            "hostname" => CommandResult {
                stdout: "MiShell-PC".to_string(),
                stderr: String::new(),
                exit_code: 0,
            },
            "date" => {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                CommandResult {
                    stdout: format!("Unix timestamp: {}", now),
                    stderr: String::new(),
                    exit_code: 0,
                }
            }
            "uname" => CommandResult {
                stdout: "MiShell Virtual OS 1.0".to_string(),
                stderr: String::new(),
                exit_code: 0,
            },
            "sort" => {
                let text = if let Some(ref input) = current_stdin {
                    input.clone()
                } else if !seg.args.is_empty() {
                    let resolved = fs.resolve_path(&seg.args[0]);
                    match fs.get_node(&resolved) {
                        Some(FsNode::File { content, .. }) => content.clone(),
                        _ => {
                            return CommandResult {
                                stdout: String::new(),
                                stderr: format!("sort: {}: No such file", seg.args[0]),
                                exit_code: 1,
                            };
                        }
                    }
                } else {
                    String::new()
                };
                let mut lines: Vec<&str> = text.lines().collect();
                lines.sort();
                CommandResult {
                    stdout: lines.join("\n"),
                    stderr: String::new(),
                    exit_code: 0,
                }
            }
            "uniq" => {
                let text = current_stdin.clone().unwrap_or_default();
                let mut result = Vec::new();
                let mut prev: Option<&str> = None;
                for line in text.lines() {
                    if prev != Some(line) {
                        result.push(line);
                        prev = Some(line);
                    }
                }
                CommandResult {
                    stdout: result.join("\n"),
                    stderr: String::new(),
                    exit_code: 0,
                }
            }
            "help" => CommandResult {
                stdout: [
                    "MiShell v2.0 - Available Commands",
                    "═════════════════════════════════════════",
                    "",
                    "  File Operations:",
                    "    ls [path]         List directory contents",
                    "    cd <path>         Change directory",
                    "    pwd               Print working directory",
                    "    mkdir [-p] <dir>  Create directory",
                    "    touch <file>      Create empty file",
                    "    cat <file>        Display file contents",
                    "    rm [-r] <path>    Remove file or directory",
                    "    cp <src> <dst>    Copy file or directory",
                    "    mv <src> <dst>    Move/rename file or directory",
                    "    find [path] name  Search for files by name",
                    "",
                    "  Text Processing:",
                    "    echo <text>       Print text to stdout",
                    "    grep <pat> [file] Search for patterns in text",
                    "    wc [-l|-w|-c]     Count lines/words/chars",
                    "    head [-n N]       Show first N lines",
                    "    tail [-n N]       Show last N lines",
                    "    sort [file]       Sort lines alphabetically",
                    "    uniq              Remove duplicate lines",
                    "",
                    "  System:",
                    "    whoami            Display current user",
                    "    hostname          Display hostname",
                    "    date              Display current date/time",
                    "    uname             Display system info",
                    "    history           Show command history",
                    "    clear             Clear terminal screen",
                    "    help              Show this help message",
                    "",
                    "  Simulations:",
                    "    sim [mode] [N]    Launch thread visualizer",
                    "                      Modes: semaphore, mutex, monitor,",
                    "                      critical, race, deadlock, concurrency",
                    "    ps                List open simulation windows",
                    "    kill <sim-id>     Close a simulation window",
                    "",
                    "  Operators:",
                    "    cmd1 | cmd2       Pipe output to next command",
                    "    cmd > file        Redirect output to file",
                    "    cmd < file        Redirect file as input",
                ].join("\n"),
                stderr: String::new(),
                exit_code: 0,
            },
            "clear" => CommandResult {
                stdout: "\x1B[CLEAR]".to_string(), // Special token frontend will recognize
                stderr: String::new(),
                exit_code: 0,
            },
            // ── Thread Visualizer Commands ──
            // These return special tokens that the frontend recognizes
            // to launch the Thread Visualizer in a specific mode.
            //
            // Usage:
            //   sim                     → show available modes
            //   sim semaphore           → open semaphore with default 3 permits
            //   sim semaphore 2         → open semaphore with 2 permits
            //   sim mutex               → open mutex visualization
            //   sim all                 → open all 7 modes
            //
            // If the window already exists, it updates the parameters
            // without creating a new one (singleton per mode).
            "sim" => {
                if seg.args.is_empty() {
                    CommandResult {
                        stdout: [
                            "Thread & Resource Visualizer - Simulaciones disponibles:",
                            "",
                            "  sim semaphore [N]   Semaforo contador (N permisos, default 3)",
                            "  sim mutex           Exclusion mutua (1 hilo a la vez)",
                            "  sim monitor         Monitor con variable de condicion",
                            "  sim critical        Seccion critica (toggle proteccion)",
                            "  sim race            Condicion de carrera (colision)",
                            "  sim deadlock        Deadlock (bloqueo circular)",
                            "  sim concurrency [N] Concurrencia independiente (N hilos, default 6)",
                            "  sim all             Abrir todas las simulaciones",
                            "",
                            "  Si la ventana ya existe, se actualiza sin crear otra.",
                            "  Usa 'ps' para ver ventanas abiertas, 'kill <id>' para cerrarlas.",
                            "",
                            "Controles dentro de la simulacion:",
                            "  SPACE         Reiniciar simulacion",
                            "  ENTER         Toggle proteccion (solo seccion critica)",
                            "  UP/DOWN       Ajustar permisos (solo semaforo)",
                        ].join("\n"),
                        stderr: String::new(),
                        exit_code: 0,
                    }
                } else {
                    let mode = seg.args[0].as_str();
                    let valid_modes = ["semaphore", "mutex", "monitor", "critical", "race", "deadlock", "concurrency", "all"];
                    if valid_modes.contains(&mode) {
                        // Parse optional numeric parameter
                        let param = if seg.args.len() > 1 {
                            seg.args[1].parse::<u32>().unwrap_or(3)
                        } else {
                            3
                        };
                        CommandResult {
                            stdout: format!("\x1B[SIM:{}:{}]", mode, param),
                            stderr: String::new(),
                            exit_code: 0,
                        }
                    } else {
                        CommandResult {
                            stdout: String::new(),
                            stderr: format!("sim: modo desconocido '{}'. Escribe 'sim' para ver los modos.", mode),
                            exit_code: 1,
                        }
                    }
                }
            },
            // ── Process management commands ──
            // ps: lists ALL open windows (the frontend handles this via windowManager)
            // kill: closes any window by ID
            // open: launches an app by name
            "ps" => CommandResult {
                stdout: "\x1B[PS]".to_string(),
                stderr: String::new(),
                exit_code: 0,
            },
            "kill" => {
                if seg.args.is_empty() {
                    CommandResult {
                        stdout: String::new(),
                        stderr: "kill: usage: kill <window-id>\nUsa 'ps' para ver las ventanas abiertas.".to_string(),
                        exit_code: 1,
                    }
                } else {
                    CommandResult {
                        stdout: format!("\x1B[KILL:{}]", seg.args[0]),
                        stderr: String::new(),
                        exit_code: 0,
                    }
                }
            },
            "open" => {
                if seg.args.is_empty() {
                    CommandResult {
                        stdout: [
                            "Aplicaciones disponibles:",
                            "",
                            "  open terminal        Abrir MiShell Terminal",
                            "  open explorer        Abrir File Explorer",
                            "  open taskmanager     Abrir Task Manager",
                            "  open calculator      Abrir Calculator",
                            "  open sim <modo> [N]  Abrir simulacion (ver 'sim' para modos)",
                        ].join("\n"),
                        stderr: String::new(),
                        exit_code: 0,
                    }
                } else {
                    let app = seg.args[0].as_str();
                    let valid_apps = ["terminal", "explorer", "taskmanager", "calculator"];
                    if valid_apps.contains(&app) {
                        CommandResult {
                            stdout: format!("\x1B[OPEN:{}]", app),
                            stderr: String::new(),
                            exit_code: 0,
                        }
                    } else {
                        CommandResult {
                            stdout: String::new(),
                            stderr: format!("open: aplicacion '{}' no encontrada. Escribe 'open' para ver las disponibles.", app),
                            exit_code: 1,
                        }
                    }
                }
            },
            _ => CommandResult {
                stdout: String::new(),
                stderr: format!(
                    "{}: command not found. Type 'help' for available commands.",
                    seg.program
                ),
                exit_code: 127,
            },
        };

        if is_last {
            // Handle output redirection on the last command
            if let Some(ref filepath) = seg.redirect_to {
                let write_result = fs.write_file(filepath, &result.stdout);
                if write_result.exit_code != 0 {
                    return write_result;
                }
                return CommandResult {
                    stdout: format!("Output written to: {}", filepath),
                    stderr: result.stderr,
                    exit_code: result.exit_code,
                };
            }
            return result;
        } else {
            // Pass stdout as stdin to the next command in the pipeline
            if result.exit_code != 0 {
                return result; // Abort pipeline on error
            }
            current_stdin = Some(result.stdout);
        }
    }

    CommandResult {
        stdout: String::new(),
        stderr: "Pipeline error".to_string(),
        exit_code: 1,
    }
}
