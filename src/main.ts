/**
 * MiShell - Entry Point
 *
 * Orchestrates the full Windows XP lifecycle:
 *   Boot Screen → Login Screen → Desktop
 */

import { showBootScreen, showLoginScreen } from "./bootSequence";
import { initDesktop } from "./desktop";

window.addEventListener("DOMContentLoaded", async () => {
  // Phase 1: Boot screen with loading bar
  await showBootScreen();

  // Phase 2: Login screen
  await showLoginScreen();

  // Phase 3: Show desktop
  document.getElementById("desktop")!.style.display = "";
  document.getElementById("taskbar")!.style.display = "";

  // Small delay for the "desktop loading" feel
  setTimeout(() => {
    initDesktop();
  }, 200);
});
