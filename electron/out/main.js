"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const net = __importStar(require("net"));
let mainWindow = null;
let backend = null;
let backendPort = null;
/** Path to the murder-server binary. In dev: workspace root, in prod: bundled alongside app. */
function getBackendPath() {
    if (electron_1.app.isPackaged) {
        // In packaged app, binary is in resources/
        const resourcesPath = process.resourcesPath;
        return path.join(resourcesPath, "murder-server");
    }
    // Dev mode: workspace root (relative to electron/ dir)
    return path.resolve(__dirname, "..", "..", "target", "release", "murder-server");
}
/** Wait for a TCP port to become available (poll every 100ms). */
function waitForPort(port, timeoutMs = 10000) {
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
                }
                else {
                    setTimeout(check, 100);
                }
            });
            socket.setTimeout(500);
        };
        check();
    });
}
/** Extract port from Rust's readiness marker: __MURDER_SERVER_READY__ port=3928 */
function extractPort(line) {
    const match = line.match(/__MURDER_SERVER_READY__ port=(\d+)/);
    return match ? parseInt(match[1], 10) : null;
}
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
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
        electron_1.dialog.showErrorBox("Backend Not Found", `Cannot find murder-server at:\n${binaryPath}\n\nBuild the release binary first:\ncargo build --release --package murder-server`);
        electron_1.app.quit();
        return;
    }
    return new Promise((resolve, reject) => {
        // Spawn on a random available port (port 0 lets OS pick)
        backend = (0, child_process_1.spawn)(binaryPath, ["--port", "0"], {
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
        });
        let resolved = false;
        backend.stdout?.on("data", (data) => {
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
        backend.stderr?.on("data", (data) => {
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
            if (!resolved)
                reject(err);
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
electron_1.app.whenReady().then(async () => {
    electron_1.Menu.setApplicationMenu(null); // Hide default menu bar
    try {
        await startBackend();
        createWindow();
    }
    catch (err) {
        electron_1.dialog.showErrorBox("Startup Error", `Failed to start backend:\n${err}`);
        electron_1.app.quit();
    }
});
electron_1.app.on("window-all-closed", () => {
    // On macOS, keep app alive unless explicitly quit
    if (process.platform !== "darwin") {
        electron_1.app.quit();
    }
});
electron_1.app.on("before-quit", () => {
    // Kill backend process on exit
    if (backend) {
        backend.kill("SIGTERM");
        backend = null;
    }
});
electron_1.app.on("activate", () => {
    if (mainWindow === null) {
        createWindow();
    }
});
