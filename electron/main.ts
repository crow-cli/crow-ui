import { app, BrowserWindow, dialog, Menu } from "electron";
import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as net from "net";

let mainWindow: BrowserWindow | null = null;
let backend: ChildProcess | null = null;
let backendPort: number | null = null;

/** Path to the murder-server binary. In dev: workspace root, in prod: bundled alongside app. */
function getBackendPath(): string {
  if (app.isPackaged) {
    // In packaged app, binary is in resources/
    const resourcesPath = process.resourcesPath;
    return path.join(resourcesPath, "murder-server");
  }
  // Dev mode: workspace root (relative to electron/ dir)
  return path.resolve(
    __dirname,
    "..",
    "..",
    "target",
    "release",
    "murder-server",
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

/** Extract port from Rust's readiness marker: __MURDER_SERVER_READY__ port=3928 */
function extractPort(line: string): number | null {
  const match = line.match(/__MURDER_SERVER_READY__ port=(\d+)/);
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

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function startBackend() {
  const binaryPath = getBackendPath();

  if (!fs.existsSync(binaryPath)) {
    dialog.showErrorBox(
      "Backend Not Found",
      `Cannot find murder-server at:\n${binaryPath}\n\nBuild the release binary first:\ncargo build --release --package murder-server`,
    );
    app.quit();
    return;
  }

  return new Promise<void>((resolve, reject) => {
    // Spawn on a random available port (port 0 lets OS pick)
    backend = spawn(binaryPath, ["--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    let resolved = false;

    backend.stdout?.on("data", (data: Buffer) => {
      const line = data.toString();
      process.stdout.write(line); // forward to console for debugging

      if (!resolved) {
        const port = extractPort(line);
        if (port) {
          backendPort = port;
          resolved = true;
          resolve();
        }
      }
    });

    // Also watch stderr in case the ready message ends up there (tracing output)
    backend.stderr?.on("data", (data: Buffer) => {
      const line = data.toString();
      process.stderr.write(line); // forward to console

      if (!resolved) {
        const port = extractPort(line);
        if (port) {
          backendPort = port;
          resolved = true;
          resolve();
        }
      }
    });

    backend.on("error", (err) => {
      if (!resolved) reject(err);
    });

    backend.on("exit", (code, signal) => {
      if (!resolved) {
        reject(new Error(`Backend exited with code ${code}, signal ${signal}`));
      }
    });

    // Timeout fallback
    setTimeout(() => {
      if (!resolved) {
        reject(new Error("Backend did not start within 30 seconds"));
      }
    }, 30000);
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null); // Hide default menu bar
  try {
    await startBackend();
    createWindow();
  } catch (err) {
    dialog.showErrorBox("Startup Error", `Failed to start backend:\n${err}`);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  // On macOS, keep app alive unless explicitly quit
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  // Kill backend process on exit
  if (backend) {
    backend.kill("SIGTERM");
    backend = null;
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});
