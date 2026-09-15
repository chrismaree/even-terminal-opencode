const provider = {
    name: "ngrok",
    program: "ngrok",
    buildArgs(port) {
        return ["http", String(port), "--log=stdout", "--log-format=json"];
    },
    parseUrl(output) {
        for (const line of output.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            let event;
            try {
                event = JSON.parse(trimmed);
            }
            catch {
                continue;
            }
            if (!event || typeof event !== "object")
                continue;
            const record = event;
            if (!("addr" in record))
                continue;
            const url = record.url;
            if (typeof url !== "string")
                continue;
            if (!/^https?:\/\/[^/]+\.ngrok[^/]*/.test(url))
                continue;
            return url;
        }
        return undefined;
    },
    failureHint: "ngrok requires a free account and authtoken. Sign up at https://dashboard.ngrok.com/signup, then run: ngrok config add-authtoken <YOUR_TOKEN>",
};
export default provider;
