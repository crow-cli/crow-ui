const fs = require("fs");
const path = require("path");
const util = require("util");

const renameAsync = util.promisify(fs.rename);
const unlinkAsync = util.promisify(fs.unlink);
const readFileAsync = util.promisify(fs.readFile);
const writeFileAsync = util.promisify(fs.writeFile);
const chmodAsync = util.promisify(fs.chmod);
const copyFileAsync = util.promisify(fs.copyFile);

exports.default = async function (context) {
  // On Linux: replace the binary with a launcher script that adds --no-sandbox.
  // This works around Electron's sandbox crash on Ubuntu 24.04+ (AppArmor
  // blocks unprivileged user namespaces, and SUID sandbox doesn't work in
  // user-owned installs like /opt/crow-ui/ or AppImage mounts).
  if (context.electronPlatformName !== "linux") return;

  const executableName = context.packager.executableName;
  const appOutDir = context.appOutDir;
  const sourceExecutable = path.join(appOutDir, executableName);
  const targetExecutable = path.join(appOutDir, `${executableName}-bin`);

  // Skip if already renamed (e.g. on incremental builds).
  if (!fs.existsSync(sourceExecutable)) {
    console.log("afterPack: executable already renamed or missing, skipping");
    return;
  }

  // Rename real binary to <name>-bin.
  await renameAsync(sourceExecutable, targetExecutable);

  // Read launcher template and substitute executable name.
  const templatePath = path.join(
    context.packager.projectDir,
    "build",
    "launcher-script.sh"
  );
  let launcher = await readFileAsync(templatePath, "utf8");
  launcher = launcher.replace(/\{\{EXEC_NAME\}\}/g, executableName);

  // Write launcher as the new executable.
  const launcherPath = sourceExecutable; // reuse the original name
  await writeFileAsync(launcherPath, launcher, { mode: 0o755 });

  console.log(
    `afterPack: installed launcher script (${executableName} -> ${executableName}-bin)`
  );

  // Remove chrome-sandbox since we explicitly disable it.
  const chromeSandbox = path.join(appOutDir, "chrome-sandbox");
  if (fs.existsSync(chromeSandbox)) {
    await unlinkAsync(chromeSandbox);
    console.log("afterPack: removed chrome-sandbox");
  }

  // AppImage: inject custom AppRun that also disables sandbox via env var.
  const appRunSource = path.join(context.packager.projectDir, "build", "AppRun");
  const appRunDest = path.join(appOutDir, "AppRun");
  if (fs.existsSync(appRunSource) && fs.existsSync(appRunDest)) {
    await copyFileAsync(appRunSource, appRunDest);
    await chmodAsync(appRunDest, 0o755);
    console.log("afterPack: injected custom AppRun");
  }
};
