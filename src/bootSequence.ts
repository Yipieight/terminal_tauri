/**
 * MiShell - Boot / Login / Shutdown Sequence
 *
 * Provides the full Windows XP lifecycle:
 *   1. Boot screen with animated loading bar
 *   2. Login screen with user avatar
 *   3. Desktop (managed by desktop.ts)
 *   4. Shutdown animation with "saving settings" message
 */

// ─── Boot Screen ──────────────────────────────────────────────
export function showBootScreen(): Promise<void> {
  return new Promise((resolve) => {
    const boot = document.getElementById("boot-screen")!;
    boot.style.display = "flex";

    const progressBar = boot.querySelector(".boot-progress-fill") as HTMLElement;
    let progress = 0;

    const interval = setInterval(() => {
      // Non-linear progress for realism
      const increment = progress < 60 ? 2.5 : progress < 85 ? 1.5 : 0.8;
      progress = Math.min(100, progress + increment + Math.random() * 1.5);
      progressBar.style.width = `${progress}%`;

      if (progress >= 100) {
        clearInterval(interval);
        // Brief pause at 100%
        setTimeout(() => {
          boot.classList.add("fade-out");
          setTimeout(() => {
            boot.style.display = "none";
            boot.classList.remove("fade-out");
            resolve();
          }, 500);
        }, 400);
      }
    }, 80);
  });
}

// ─── Login Screen ─────────────────────────────────────────────
export function showLoginScreen(): Promise<void> {
  return new Promise((resolve) => {
    const login = document.getElementById("login-screen")!;
    login.style.display = "flex";
    login.classList.add("fade-in");

    const loginBtn = document.getElementById("login-btn")!;
    const passwordInput = document.getElementById("login-password") as HTMLInputElement;

    function doLogin(): void {
      // Disable button
      loginBtn.textContent = "Loading...";
      (loginBtn as HTMLButtonElement).disabled = true;

      // "Loading profile" animation
      setTimeout(() => {
        login.classList.add("fade-out");
        setTimeout(() => {
          login.style.display = "none";
          login.classList.remove("fade-in", "fade-out");
          resolve();
        }, 600);
      }, 800);
    }

    loginBtn.addEventListener("click", doLogin);
    passwordInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doLogin();
    });

    // Focus password field
    setTimeout(() => passwordInput.focus(), 600);
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
      "Windows is shutting down...",
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
