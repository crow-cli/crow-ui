import { app, BrowserWindow, dialog, Menu, crashReporter } from "electron";
import { spawn, ChildProcess, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";

// ─── Logging ───────────────────────────────────────────────────────────────

const LOG_DIR = path.join(os.homedir(), ".crow", "logs");
const LOG_DATE = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const LOG_PATH = path.join(LOG_DIR, `crow-ui-${LOG_DATE}.log`);

let logStream: fs.WriteStream | null = null;

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
} catch {
  // If we can't create the log file, fall back to console-only
}

function log(level: "INFO" | "WARN" | "ERROR", ...args: unknown[]) {
  const timestamp = new Date().toISOString();
  const message = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  const line = `[${timestamp}] [${level}] ${message}\n`;
  // eslint-disable-next-line no-console
  console.log(line.trimEnd());
  if (logStream) {
    logStream.write(line);
  }
}

function logInfo(...args: unknown[]) { log("INFO", ...args); }
function logWarn(...args: unknown[]) { log("WARN", ...args); }
function logError(...args: unknown[]) { log("ERROR", ...args); }

// ─── Crash Reporter ────────────────────────────────────────────────────────

function initCrashReporter() {
  const crashDir = path.join(LOG_DIR, "crashes");
  fs.mkdirSync(crashDir, { recursive: true });

  crashReporter.start({
    submitURL: "", // No auto-submit; we just collect locally
    uploadToServer: false,
    ignoreSystemCrashHandler: true,
    extra: {
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
    },
  });

  logInfo("Crash reporter started. Crashes will be dumped to:", crashDir);
}

// ─── Shell Environment ─────────────────────────────────────────────────────

/** Capture the user's shell environment (fnm, nvm, uv, etc.) by spawning a login shell.
 *  Merges it into the current process.env so all child processes inherit it.
 */
function loadShellEnv(): void {
  if (process.platform === "win32") return;

  const shell = process.env.SHELL || "/bin/bash";
  const shellName = path.basename(shell);

  // Build shell-specific strategies to capture the full user environment.
  // The -i flag is critical for bash/sh: without it, .bashrc exits early
  // because of the "If not running interactively" guard, so fnm/nvm/uv
  // never get a chance to set up PATH.
  const strategies: string[] = [];
  if (shellName === "bash" || shellName === "sh") {
    strategies.push(`${shell} -ilc 'env -0'`);
    strategies.push(`${shell} -lc 'env -0'`);
  } else if (shellName === "zsh") {
    strategies.push(`${shell} -ilc 'env -0'`);
    strategies.push(`${shell} -lc 'env -0'`);
  } else {
    strategies.push(`${shell} -lc 'env -0'`);
    strategies.push(`${shell} -c 'env -0'`);
  }

  for (const cmd of strategies) {
    try {
      const envOutput = execSync(cmd, {
        encoding: "utf-8",
        timeout: 5000,
      });
      const vars = envOutput.split("\0");
      let updated = 0;
      for (const v of vars) {
        const eq = v.indexOf("=");
        if (eq > 0) {
          const key = v.slice(0, eq);
          const val = v.slice(eq + 1);
          // Shell PATH always wins — it has fnm/nvm/uv entries
          if (key === "PATH" || !process.env[key]) {
            process.env[key] = val;
            updated++;
          }
        }
      }
      logInfo("loadShellEnv: captured", updated, "vars via:", cmd);
      return; // Success — bail out
    } catch (err) {
      logWarn("loadShellEnv: strategy failed:", cmd, "—", String(err).slice(0, 120));
    }
  }

  logWarn("loadShellEnv: all strategies failed, using existing env. PATH =", process.env.PATH?.slice(0, 200));
}

let mainWindow: BrowserWindow | null = null;
let backend: ChildProcess | null = null;
let backendPort: number | null = null;

/** Path to the crow-ui-server binary. In dev: workspace root, in prod: bundled alongside app. */
function getBackendPath(): string {
  if (app.isPackaged) {
    // In packaged app, binary is in resources/
    const resourcesPath = process.resourcesPath;
    return path.join(resourcesPath, "crow-ui-server");
  }
  // Dev mode: workspace root (relative to electron/ dir)
  return path.resolve(
    __dirname,
    "..",
    "..",
    "target",
    "release",
    "crow-ui-server",
  );
}

/** Wait for a TCP port to become available (poll every 100ms). */
function waitForPort(port: number, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const socket = net.createConnection(port, "127.0.0.1");
      socket.on("connect", () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Port ${port} not available after ${timeoutMs}ms`));
        } else {
          setTimeout(check, 100);
        }
      });
      socket.setTimeout(500);
    };
    check();
  });
}

/** Extract port from Rust's readiness marker: __crow_ui_SERVER_READY__ port=3928 */
function extractPort(line: string): number | null {
  const match = line.match(/__crow_ui_SERVER_READY__ port=(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: "Crow",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const url = `http://127.0.0.1:${backendPort}`;
  mainWindow.loadURL(url);

  // ─── Renderer crash handlers ────────────────────────────────────────────

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logError(
      "RENDERER PROCESS GONE:",
      "reason =", details.reason,
      "exitCode =", details.exitCode,
      "webContents.id =", mainWindow?.webContents.id,
    );
    dialog.showErrorBox(
      "Renderer Process Crashed",
      `The webview process exited unexpectedly.\n\n` +
        `Reason: ${details.reason}\n` +
        `Exit code: ${details.exitCode}\n\n` +
        `Logs written to: ${LOG_PATH}`,
    );
  });

  mainWindow.webContents.on("plugin-crashed", (_event, name, version) => {
    logError("PLUGIN CRASHED:", name, version);
  });

  mainWindow.webContents.on("unresponsive", () => {
    logWarn("RENDERER UNRESPONSIVE — webContents.id =", mainWindow?.webContents.id);
  });

  mainWindow.webContents.on("responsive", () => {
    logInfo("RENDERER RESPONSIVE — webContents.id =", mainWindow?.webContents.id);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function startBackend() {
  const binaryPath = getBackendPath();

  if (!fs.existsSync(binaryPath)) {
    dialog.showErrorBox(
      "Backend Not Found",
      `Cannot find crow-ui-server at:\n${binaryPath}\n\nBuild the release binary first:\ncargo build --release --package crow-ui-server`,
    );
    app.quit();
    return;
  }

  logInfo("Starting backend:", binaryPath);

  return new Promise<void>((resolve, reject) => {
    logInfo("startBackend: spawning with PATH =", process.env.PATH?.slice(0, 200));

    // Spawn on a random available port (port 0 lets OS pick)
    // Explicitly pass env so the Rust backend gets our loaded shell environment
    backend = spawn(binaryPath, ["--port", "4723"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      env: process.env,
    });

    let resolved = false;

    backend.stdout?.on("data", (data: Buffer) => {
      const line = data.toString();
      process.stdout.write(line); // forward to console for debugging
      logInfo("[backend stdout]", line.trimEnd()); // also to log file

      if (!resolved) {
        const port = extractPort(line);
        if (port) {
          backendPort = port;
          resolved = true;
          logInfo("Backend ready on port", port);
          resolve();
        }
      }
    });

    // Also watch stderr in case the ready message ends up there (tracing output)
    backend.stderr?.on("data", (data: Buffer) => {
      const line = data.toString();
      process.stderr.write(line); // forward to console
      logInfo("[backend stderr]", line.trimEnd()); // also to log file (tracing is info-level)

      if (!resolved) {
        const port = extractPort(line);
        if (port) {
          backendPort = port;
          resolved = true;
          logInfo("Backend ready on port (via stderr)", port);
          resolve();
        }
      }
    });

    backend.on("error", (err) => {
      logError("Backend spawn error:", err);
      if (!resolved) reject(err);
    });

    backend.on("exit", (code, signal) => {
      logError("Backend exited:", "code =", code, "signal =", signal);
      if (!resolved) {
        reject(new Error(`Backend exited with code ${code}, signal ${signal}`));
      }
    });

    // Timeout fallback
    setTimeout(() => {
      if (!resolved) {
        logError("Backend did not start within 30 seconds");
        reject(new Error("Backend did not start within 30 seconds"));
      }
    }, 30000);
  });
}

// ─── App-level crash handlers ──────────────────────────────────────────────

app.on("child-process-gone", (_event, details) => {
  logError(
    "CHILD PROCESS GONE:",
    "type =", details.type,
    "reason =", details.reason,
    "exitCode =", details.exitCode,
    "serviceName =", details.serviceName,
  );
});

app.on("certificate-error", (_event, _webContents, url, error, _certificate, callback) => {
  logWarn("CERTIFICATE ERROR:", url, error);
  callback(false);
});

app.on("render-process-gone", (_event, _webContents, details) => {
  logError(
    "APP-LEVEL RENDERER GONE:",
    "reason =", details.reason,
    "exitCode =", details.exitCode,
  );
});

app.whenReady().then(async () => {
  initCrashReporter();
  logInfo("Electron starting. Version:", process.versions.electron);
  logInfo("Log file:", LOG_PATH);

  Menu.setApplicationMenu(null); // Hide default menu bar
  loadShellEnv(); // Capture fnm/nvm/uv etc. before spawning backend
  try {
    await startBackend();
    createWindow();
  } catch (err) {
    logError("Startup failed:", err);
    dialog.showErrorBox("Startup Error", `Failed to start backend:\n${err}`);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  logInfo("All windows closed");
  // On macOS, keep app alive unless explicitly quit
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  logInfo("App quitting...");
  // Kill backend process on exit
  if (backend) {
    backend.kill("SIGTERM");
    backend = null;
  }
  if (logStream) {
    logStream.end();
    logStream = null;
  }
});

app.on("activate", () => {
  logInfo("App activated");
  if (mainWindow === null) {
    createWindow();
  }
});
