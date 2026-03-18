/**
 * MiShell - Entry Point
 *
 * Orchestrates the full Windows XP lifecycle:
 *   Boot Screen → Desktop (login removed for streamlined experience)
 */

import { showBootScreen } from "./bootSequence";
import { initDesktop } from "./desktop";

window.addEventListener("DOMContentLoaded", async () => {
  // Phase 1: Boot screen with XP-style animated loading blocks
  await showBootScreen();

  // Phase 2: Show desktop directly (no login)
  document.getElementById("desktop")!.style.display = "";
  document.getElementById("taskbar")!.style.display = "";

  // Small delay for the "desktop loading" feel
  setTimeout(() => {
    initDesktop();
  }, 200);
});
