// ═══════════════════════════════════════════════════════════════════════════
// MiShell - Cross-Platform OS Shell Emulator (Tauri v2 Backend)
//
// This is the main entry point for the Rust backend. It registers Tauri
// commands (IPC handlers) that the TypeScript frontend calls via invoke().
//
// Architecture:
//   Frontend (TypeScript) → invoke("command_name", {args}) → Rust handler
//   Rust handler → operates on VirtualFs → returns result → Frontend
//
// The virtual filesystem (virtual_fs module) provides complete sandbox
// isolation. NO real OS commands are executed — all file operations happen
// in memory with JSON persistence to disk.
//
// PHASE 5 - Memory Management (Academic Rubric):
// All Tauri state is managed through Rust's ownership model:
//   - FsState owns the Mutex<VirtualFs> and Mutex<Vec<String>> (history)
//   - Tauri manages FsState's lifetime (alive for entire app lifecycle)
//   - When the app exits, FsState is dropped → VirtualFs dropped →
//     ALL nodes (directories, files, strings) freed recursively
//   - No manual free() or cleanup code needed anywhere
// ═══════════════════════════════════════════════════════════════════════════

mod virtual_fs;

use tauri::{Manager, State};
use virtual_fs::{CommandResult, FsEntry, FsState, FsTreeNode};

// ═══════════════════════════════════════════════════════════════════════════
// TERMINAL COMMANDS (text-based, used by the MiShell terminal app)
// ═══════════════════════════════════════════════════════════════════════════

/// Main command: parses input, executes virtual command(s), stores in history.
///
/// PHASE 1-2 (Parsing):
/// The input string is parsed into pipeline segments by virtual_fs::parse_input().
/// Each segment is tokenized into program + args using split_whitespace().
/// All temporary Vec<String> and String allocations are freed automatically
/// when this function returns (RAII).
///
/// PHASE 3-4 (Pipes & Redirection):
/// Pipeline execution passes stdout of each command as stdin to the next.
/// Redirection (>) writes final output to a virtual file.
///
/// PHASE 6 (History):
/// Each command is stored in Mutex<Vec<String>> before execution.
/// The Mutex provides thread-safe access (like pthread_mutex in C).
#[tauri::command]
fn execute_command(input: &str, state: State<'_, FsState>) -> CommandResult {
    let trimmed = input.trim();

    // Store command in history
    // PHASE 5 Note: input.to_string() allocates a new String on the heap
    // (equivalent to strdup() in C). The Vec manages this allocation.
    // When the Vec grows, it may reallocate (like realloc in C), but
    // all old memory is freed automatically. No manual free() needed.
    if let Ok(mut history) = state.history.lock() {
        history.push(trimmed.to_string());
    }

    // Parse the input into pipeline segments
    let segments = virtual_fs::parse_input(trimmed);

    // Execute on the virtual filesystem
    if let Ok(mut fs) = state.fs.lock() {
        let history = state.history.lock().map(|h| h.clone()).unwrap_or_default();
        let result = virtual_fs::execute_pipeline(&segments, &mut fs, &history);

        // Persist filesystem after potential mutations
        // (save is cheap for small virtual filesystems)
        drop(fs); // Release the lock before saving
        state.save();

        result
    } else {
        CommandResult {
            stdout: String::new(),
            stderr: "Internal error: filesystem lock failed".to_string(),
            exit_code: 1,
        }
    }
}

/// Returns the full command history.
///
/// PHASE 5 Note:
/// The returned Vec<String> is a clone of the history.
/// Tauri serializes it to JSON, then drops the clone — all memory freed.
/// The original history in the Mutex remains untouched.
#[tauri::command]
fn get_history(state: State<'_, FsState>) -> Vec<String> {
    match state.history.lock() {
        Ok(entries) => entries.clone(),
        Err(_) => Vec::new(),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// FILE EXPLORER COMMANDS (structured data, used by the Explorer app)
//
// These return structured data (Vec<FsEntry>, FsTreeNode) instead of
// plain text, so the File Explorer can render proper UI elements.
// ═══════════════════════════════════════════════════════════════════════════

#[tauri::command]
fn fs_list_dir(path: &str, state: State<'_, FsState>) -> Result<Vec<FsEntry>, String> {
    let fs = state.fs.lock().map_err(|_| "Lock error".to_string())?;
    fs.list_dir(path)
}

#[tauri::command]
fn fs_read_file(path: &str, state: State<'_, FsState>) -> Result<String, String> {
    let fs = state.fs.lock().map_err(|_| "Lock error".to_string())?;
    fs.read_file(path)
}

#[tauri::command]
fn fs_create_dir(path: &str, state: State<'_, FsState>) -> Result<(), String> {
    let mut fs = state.fs.lock().map_err(|_| "Lock error".to_string())?;
    let result = fs.create_dir(path);
    drop(fs);
    state.save();
    result
}

#[tauri::command]
fn fs_delete(path: &str, state: State<'_, FsState>) -> Result<(), String> {
    let mut fs = state.fs.lock().map_err(|_| "Lock error".to_string())?;
    let result = fs.delete(path);
    drop(fs);
    state.save();
    result
}

#[tauri::command]
fn fs_rename(old_path: &str, new_path: &str, state: State<'_, FsState>) -> Result<(), String> {
    let mut fs = state.fs.lock().map_err(|_| "Lock error".to_string())?;
    let result = fs.rename(old_path, new_path);
    drop(fs);
    state.save();
    result
}

#[tauri::command]
fn fs_get_tree(path: &str, depth: u32, state: State<'_, FsState>) -> Result<FsTreeNode, String> {
    let fs = state.fs.lock().map_err(|_| "Lock error".to_string())?;
    fs.get_tree(path, depth)
}

/// Returns the current working directory (for the terminal prompt)
#[tauri::command]
fn get_cwd(state: State<'_, FsState>) -> String {
    match state.fs.lock() {
        Ok(fs) => fs.cwd.clone(),
        Err(_) => "/".to_string(),
    }
}

/// Autocomplete: returns matching file/directory names for a partial input.
/// Handles both command name completion and path completion.
#[tauri::command]
fn autocomplete(input: &str, state: State<'_, FsState>) -> Vec<String> {
    let trimmed = input.trim();

    // If input has no spaces, autocomplete command names
    if !trimmed.contains(' ') {
        let mut matches: Vec<String> = virtual_fs::VirtualFs::available_commands()
            .iter()
            .filter(|cmd| cmd.starts_with(trimmed))
            .map(|cmd| cmd.to_string())
            .collect();
        matches.sort();
        return matches;
    }

    // Otherwise, autocomplete the last argument as a path
    let last_space = trimmed.rfind(' ').unwrap();
    let partial_path = &trimmed[last_space + 1..];
    let prefix = &trimmed[..=last_space];

    let fs = match state.fs.lock() {
        Ok(fs) => fs,
        Err(_) => return Vec::new(),
    };

    let completions = fs.autocomplete(partial_path);
    completions
        .iter()
        .map(|c| format!("{}{}", prefix, c))
        .collect()
}

// ═══════════════════════════════════════════════════════════════════════════
// TAURI APPLICATION ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Determine the data path for filesystem persistence
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let fs_path = data_dir.join("mishell_fs.json");

            // Load existing filesystem or create default
            // PHASE 5 Note: FsState::load_or_create() either deserializes
            // the JSON file (serde allocates all needed memory) or creates
            // a new VirtualFs with default directories. Either way, all
            // memory is owned by FsState and will be freed on app exit.
            let fs_state = FsState::load_or_create(fs_path);

            app.manage(fs_state);
            Ok(())
        })
        // Register all IPC command handlers
        .invoke_handler(tauri::generate_handler![
            execute_command,
            get_history,
            get_cwd,
            autocomplete,
            fs_list_dir,
            fs_read_file,
            fs_create_dir,
            fs_delete,
            fs_rename,
            fs_get_tree,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
