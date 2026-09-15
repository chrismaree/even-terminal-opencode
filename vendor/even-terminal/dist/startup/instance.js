import { homedir } from "node:os";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const INSTANCE_DIR = join(homedir(), ".even-terminal", "instances");
function instanceFilePath(pid) {
    return join(INSTANCE_DIR, `${pid}.json`);
}
export function writeInstancePidfile(info) {
    mkdirSync(INSTANCE_DIR, { recursive: true });
    const full = {
        pid: process.pid,
        platform: process.platform,
        startedAt: Date.now(),
        ...info,
    };
    const path = instanceFilePath(process.pid);
    writeFileSync(path, JSON.stringify(full, null, 2), { mode: 0o600 });
    return path;
}
export function removeInstancePidfile() {
    try {
        unlinkSync(instanceFilePath(process.pid));
    }
    catch {
        // already gone — fine
    }
}
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err?.code === "EPERM";
    }
}
/** List live instances; silently prunes stale pidfiles. */
export function listLiveInstances() {
    let entries;
    try {
        entries = readdirSync(INSTANCE_DIR);
    }
    catch (err) {
        if (err?.code === "ENOENT")
            return [];
        throw err;
    }
    const live = [];
    for (const name of entries) {
        if (!name.endsWith(".json"))
            continue;
        const path = join(INSTANCE_DIR, name);
        let info;
        try {
            info = JSON.parse(readFileSync(path, "utf8"));
        }
        catch {
            try {
                unlinkSync(path);
            }
            catch { }
            continue;
        }
        if (typeof info.pid !== "number" || !isPidAlive(info.pid)) {
            try {
                unlinkSync(path);
            }
            catch { }
            continue;
        }
        live.push(info);
    }
    // Newest first — handy for "most recent" fallbacks and stable display.
    live.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return live;
}
/** Best-effort age string (e.g. "3m", "2h"). */
export function formatInstanceAge(startedAt) {
    const secs = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    if (secs < 60)
        return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60)
        return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24)
        return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}
