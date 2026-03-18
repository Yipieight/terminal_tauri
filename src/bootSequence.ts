/**
 * MiShell - Boot / Shutdown Sequence
 *
 * Provides the full Windows XP lifecycle:
 *   1. Boot screen with XP-style animated sliding blocks
 *   2. Desktop (managed by desktop.ts)
 *   3. Shutdown animation with "saving settings" message
 *
 * The boot screen mimics the classic Windows XP startup with:
 *   - Animated flag logo that assembles piece by piece
 *   - Three blue blocks sliding back and forth
 *   - Status messages cycling during boot
 */

// ─── Boot Screen ──────────────────────────────────────────────
export function showBootScreen(): Promise<void> {
  return new Promise((resolve) => {
    const boot = document.getElementById("boot-screen")!;
    const statusEl = document.getElementById("boot-status")!;
    boot.style.display = "flex";

    // Status messages that cycle during boot (simulates real boot)
    const messages = [
      "",
      "Initializing virtual filesystem...",
      "Loading system drivers...",
      "Preparing MiShell environment...",
      "Mounting virtual disk...",
      "Starting shell services...",
      "Applying user settings...",
      "Almost ready...",
    ];

    let msgIndex = 0;

    // Cycle through boot messages
    const msgInterval = setInterval(() => {
      msgIndex++;
      if (msgIndex < messages.length) {
        statusEl.textContent = messages[msgIndex];
        statusEl.classList.add("status-fade");
        setTimeout(() => statusEl.classList.remove("status-fade"), 300);
      }
    }, 700);

    // Total boot duration: ~5.5 seconds
    const bootDuration = 5500;

    setTimeout(() => {
      clearInterval(msgInterval);

      // Fade out the entire boot screen
      boot.classList.add("fade-out");

      setTimeout(() => {
        boot.style.display = "none";
        boot.classList.remove("fade-out");
        resolve();
      }, 800);
    }, bootDuration);
  });
}

// ─── Shutdown Animation ───────────────────────────────────────
export function showShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const shutdown = document.getElementById("shutdown-screen")!;

    // Hide desktop and taskbar
    document.getElementById("desktop")!.style.display = "none";
    document.getElementById("taskbar")!.style.display = "none";
    document.getElementById("start-menu")!.style.display = "none";

    shutdown.style.display = "flex";
    shutdown.classList.add("fade-in");

    const statusText = shutdown.querySelector(".shutdown-status") as HTMLElement;
    const messages = [
      "Saving your settings...",
      "Closing network connections...",
      "Writing system log...",
      "MiShell is shutting down...",
    ];

    let msgIndex = 0;
    const msgInterval = setInterval(() => {
      if (msgIndex < messages.length) {
        statusText.textContent = messages[msgIndex];
        msgIndex++;
      } else {
        clearInterval(msgInterval);
        // Final fade to black
        setTimeout(() => {
          shutdown.classList.add("shutdown-final");
          setTimeout(() => {
            resolve();
          }, 1500);
        }, 800);
      }
    }, 900);
  });
}
