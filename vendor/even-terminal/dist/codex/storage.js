import { codexThreadStatus } from "./status.js";
import { debugLog } from "../debug.js";
export async function listCodexSessions(client, limit, cwd) {
    const result = await client.threadList({
        limit: limit,
        ...(cwd ? { cwd } : {}),
        archived: false,
        sortKey: "updated_at",
    });
    return result.data.slice(0, 10).map((t) => ({
        id: String(t.id ?? ""),
        title: String(t.name ?? t.preview ?? "Codex session").slice(0, 64),
        timestamp: new Date((Number(t.updatedAt ?? t.createdAt ?? Date.now() / 1000)) * 1000).toISOString(),
        cwd: String(t.cwd ?? ""),
        status: codexThreadStatus(t),
    }));
}
const MAX_HISTORY_ITEMS = 10;
// Turns fetched per page. Independent of `limit`; correctness comes from the
// pagination loop, this constant only paces it. Each turn in itemsView=full
// returns at most a few user/agent text items + (filtered out client-side)
// reasoning / tool-call / file-change items, so 10 turns per page keeps the
// page size in the tens of KB even for tool-heavy sessions.
const TURNS_PAGE_SIZE = 10;
export async function getCodexSessionHistory(client, sessionId, limit) {
    const t0 = Date.now();
    const returnCount = Math.min(limit, MAX_HISTORY_ITEMS);
    // Walk turns newest-first via thread/turns/list (itemsView=full so we get
    // every userMessage + agentMessage codex would have included in thread/read
    // for that turn, not just the first/last pair that summary view returns).
    // Strict termination: only stop when we have `returnCount` text messages OR
    // the server reports no more pages. Never bail on "probably enough".
    //
    // The reason we switched off `thread/read`: on Windows that single call
    // ships a ~16.5 MB JSON response (the whole rollout's items in API form),
    // which on the platform pays ~1 s of kernel overhead per request for
    // reasons we traced down to per-process WSASend cost (see investigation
    // notes). thread/turns/list with itemsView=full returns just the typed
    // thread items, which is ~200x smaller for typical sessions (74 KB vs
    // 16.5 MB for session 019ddd5d). At that payload size the Windows
    // pathology stops being observable.
    const messages = [];
    let cursor = undefined;
    let pages = 0;
    let scannedTurns = 0;
    let scannedItems = 0;
    outer: while (messages.length < returnCount) {
        const page = await client.threadTurnsList({
            threadId: sessionId,
            limit: TURNS_PAGE_SIZE,
            sortDirection: "desc",
            itemsView: "full",
            ...(cursor ? { cursor } : {}),
        });
        pages++;
        // `data[]` is newest-first (sortDirection=desc). Items within a turn are
        // chronological, so reverse to walk newest-first inside each turn too —
        // that way the slice at the end yields the chronologically-newest N.
        for (const turn of page.data) {
            scannedTurns++;
            const items = Array.isArray(turn?.items) ? [...turn.items].reverse() : [];
            for (const item of items) {
                scannedItems++;
                if (item?.type === "userMessage") {
                    const text = extractUserMessageText(item);
                    if (text)
                        messages.push({ role: "user", text });
                }
                else if (item?.type === "agentMessage") {
                    const text = extractAgentMessageText(item);
                    if (text)
                        messages.push({ role: "assistant", text });
                }
                if (messages.length >= returnCount)
                    break outer;
            }
        }
        // Stop only on server-confirmed exhaustion. If a session is tool-heavy
        // and a 10-turn page contains zero user/agent text items, we keep paging
        // until the server says there's nothing left.
        if (!page.nextCursor || page.data.length === 0)
            break;
        cursor = page.nextCursor;
    }
    // We accumulated newest-first; flip to match the original chronological
    // ordering that callers (and the previous thread/read implementation) used.
    const result = messages.slice(0, returnCount).reverse();
    const tEnd = Date.now();
    debugLog("codex-history", `sessionId=${sessionId} totalMs=${tEnd - t0} pages=${pages} scannedTurns=${scannedTurns} scannedItems=${scannedItems} extracted=${messages.length} returned=${result.length}`);
    return result;
}
function extractUserMessageText(item) {
    const content = Array.isArray(item?.content) ? item.content : [];
    const parts = [];
    for (const c of content) {
        if (c?.type === "text" && typeof c?.text === "string" && c.text.trim()) {
            parts.push(c.text.trim());
        }
    }
    return parts.join("\n").trim();
}
function extractAgentMessageText(item) {
    if (typeof item?.text === "string" && item.text.trim())
        return item.text.trim();
    return "";
}
