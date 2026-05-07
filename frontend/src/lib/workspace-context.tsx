let _globalOpenFile: ((path: string) => Promise<void>) | null = null;
let _globalOpenTerminal: (() => void) | null = null;
let _globalOpenChat: (() => void) | null = null;

export function setGlobalOpenFile(fn: (path: string) => Promise<void>) {
  _globalOpenFile = fn;
}

export function setGlobalOpenTerminal(fn: () => void) {
  _globalOpenTerminal = fn;
}

export function setGlobalOpenChat(fn: () => void) {
  _globalOpenChat = fn;
}

export function globalOpenFile(path: string) {
  return _globalOpenFile?.(path);
}

export function globalOpenTerminal() {
  _globalOpenTerminal?.();
}

export function globalOpenChat() {
  _globalOpenChat?.();
}
