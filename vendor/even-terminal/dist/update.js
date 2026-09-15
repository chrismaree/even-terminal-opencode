import { PACKAGE_NAME, VERSION } from "./version.js";
const pkg = { name: PACKAGE_NAME, version: VERSION };
const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 5000;
function isNewerVersion(candidate, current) {
    const candidateParts = candidate.split(".").map(Number);
    const currentParts = current.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        if (candidateParts[i] !== currentParts[i])
            return candidateParts[i] > currentParts[i];
    }
    return false;
}
async function fetchNewestVersion(packageName) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const url = `${NPM_REGISTRY_URL}/${encodeURIComponent(packageName)}`;
        const response = await fetch(url, {
            headers: { Accept: "application/vnd.npm.install-v1+json" },
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`npm registry returned ${response.status}`);
        }
        const body = (await response.json());
        const latest = body["dist-tags"]?.latest;
        if (typeof latest !== "string" || latest.length === 0) {
            throw new Error("npm registry response did not include dist-tags.latest");
        }
        return latest;
    }
    finally {
        clearTimeout(timer);
    }
}
export async function checkForUpdate() {
    const newestVersion = await fetchNewestVersion(pkg.name);
    return {
        packageName: pkg.name,
        currentVersion: pkg.version,
        newestVersion,
        updateAvailable: isNewerVersion(newestVersion, pkg.version),
        checkedAt: new Date().toISOString(),
    };
}
export function getCurrentAppVersion() {
    return {
        packageName: pkg.name,
        currentVersion: pkg.version,
        checkedAt: new Date().toISOString(),
    };
}
