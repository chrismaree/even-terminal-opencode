// ── Provider ────────────────────────────────────────────
// cursor/opencode are experimental and hidden in 0.8.1 — re-add them here to re-enable.
export const SUPPORTED_PROVIDERS = ["claude", "codex"];
export function isProvider(value) {
    return typeof value === "string" && SUPPORTED_PROVIDERS.includes(value);
}
export function parseProvider(value, label = "provider") {
    if (isProvider(value))
        return value;
    throw new Error(`Unsupported ${label} "${String(value)}". Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}`);
}
/** Global default provider, read once from env. */
export function getDefaultProvider() {
    const env = process.env.DEFAULT_PROVIDER;
    if (!env)
        return "claude";
    return parseProvider(env, "DEFAULT_PROVIDER");
}
