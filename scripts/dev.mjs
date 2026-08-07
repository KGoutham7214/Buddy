import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import waitOn from "wait-on";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const isWin = process.platform === "win32";

function run(command, args, env = {}) {
  return spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: isWin,
  });
}

const vite = run(isWin ? "npx.cmd" : "npx", ["vite"]);

vite.on("exit", (code) => {
  if (code && code !== 0) process.exit(code);
});

try {
  await waitOn({
    resources: ["http://127.0.0.1:5173"],
    timeout: 60000,
  });
} catch (err) {
  console.error("Vite did not start in time:", err.message);
  vite.kill();
  process.exit(1);
}

const electronBin = path.join(
  root,
  "node_modules",
  "electron",
  "cli.js"
);

const electron = spawn(process.execPath, [electronBin, root], {
  cwd: root,
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  },
  stdio: "inherit",
  shell: false,
});

function shutdown() {
  electron.kill();
  vite.kill();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

electron.on("exit", (code) => {
  vite.kill();
  process.exit(code ?? 0);
});
