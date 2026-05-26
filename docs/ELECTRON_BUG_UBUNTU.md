# Electron Sandbox Crash on Ubuntu 24.04

## Status: FIXED

The `.deb` package now launches correctly on Ubuntu 24.04. Both `.deb` and `linux-unpacked` work.

## Problem (Historical)

The crow-ui Electron app **worked on Ubuntu 22.04** but **silently failed on Ubuntu 24.04** when launched from the GUI (double-clicking `.deb` installed app or `.AppImage`).

When launched from a terminal, the actual error was:

```
FATAL:setuid_sandbox_host.cc(163)] The SUID sandbox helper binary was found,
but is not configured correctly. Rather than run without sandboxing I'm aborting now.
You need to make sure that /opt/crow-ui/chrome-sandbox is owned by root and has mode 4755.
```

From a GUI launch, stderr is discarded, so the app appeared to do nothing.

## Root Cause

Ubuntu 24.04 introduced **restricted unprivileged user namespaces** via AppArmor.
Previously, Electron could use either:
1. **SUID sandbox** (`chrome-sandbox` with setuid bit) — requires root-owned 4755 perms
2. **User namespaces** — unprivileged sandboxing via `unshare --user`

On 24.04:
- AppArmor blocks unprivileged user namespaces by default unless the binary has an AppArmor profile with `userns,` rule
- The SUID sandbox helper in a user-owned install (`/opt/crow-ui/`) cannot have root-owned 4755 permissions
- Chrome/Firefox/etc get AppArmor profiles shipped in the distro, but third-party Electron apps do not

So Electron's sandbox had **no viable backend** and aborted.

## Solution: Launcher Script

Renamed the real Electron binary (`crow-ui` → `crow-ui-bin`) and replaced `crow-ui` with a bash launcher script that adds `--no-sandbox` before delegating to the real binary. This is the same approach used by Beekeeper Studio, Cozy Desktop, and others.

### How it works

After installing the `.deb`:
- `/opt/crow-ui/crow-ui` is the **launcher script**
- `/opt/crow-ui/crow-ui-bin` is the **real Electron binary**
- The `.desktop` file's `Exec` line points to `/opt/crow-ui/crow-ui`
- When the user clicks the app (or runs `crow-ui` from terminal), the launcher script runs the real binary with `--no-sandbox`

This completely bypasses the AppArmor namespace restriction and the SUID sandbox permission problem.

## Files Modified

- `electron/build/launcher-script.sh` — bash launcher template (resolves symlinks, adds `--no-sandbox`)
- `electron/afterPack.js` — renames binary → `-bin`, generates launcher script from template, removes `chrome-sandbox`
- `electron/deb-control/postinst` — removed obsolete `chrome-sandbox` chmod logic
- `electron/build/electron-builder.desktop` — removed `--no-sandbox` from `Exec` (launcher handles it)
- `electron/package.json` — removed invalid `linux.desktop.Exec` setting

## References

- Ubuntu blog on restricted unprivileged user namespaces:
  https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces
- Electron issue #42510 — same crash on Kubuntu 24.04:
  https://github.com/electron/electron/issues/42510
- electron-builder issue #4278 — launcher script pattern:
  https://github.com/electron-userland/electron-builder/issues/4278
- Beekeeper Studio's production implementation:
  https://github.com/beekeeper-studio/beekeeper-studio/blob/master/apps/studio/build/afterPack.js
