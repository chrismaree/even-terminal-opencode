import { spawn, spawnSync, } from "node:child_process";
// Cross-platform spawn that resolves PATHEXT-style shims (`foo.cmd`, `foo.bat`,
// extensionless npm shims, etc.) on Windows by routing through `cmd.exe /c`.
// POSIX uses `execvp`, which already searches PATH — no shell wrapper needed.
//
// Avoids `shell: true` + array args (DEP0190 in Node 22+, removed in Node 24),
// while still letting Windows resolve PATHEXT correctly. Args here are passed
// through Node's per-arg quoting (safer than shell-string concatenation).
function windowsShimArgs(file, args) {
    return { file: process.env.ComSpec || "cmd.exe", args: ["/c", file, ...args] };
}
export function spawnShim(file, args = [], opts = {}) {
    if (process.platform === "win32") {
        const w = windowsShimArgs(file, args);
        return spawn(w.file, w.args, opts);
    }
    return spawn(file, args, opts);
}
export function spawnSyncShim(file, args = [], opts = {}) {
    if (process.platform === "win32") {
        const w = windowsShimArgs(file, args);
        return spawnSync(w.file, w.args, opts);
    }
    return spawnSync(file, args, opts);
}
