import {loadConfig} from "./config.js";
import {buildProducts, checkToolNames} from "./products.js";
import {createApp} from "./app.js";

async function main() {
    const config = loadConfig();
    const products = buildProducts(config);
    // Tool names do not depend on the token, so check them with a placeholder.
    const names = await checkToolNames(products.length ? products : buildProducts(config, () => {}, "check"));
    const total = Object.values(names).reduce((n, l) => n + l.length, 0);
    const app = createApp(config, products);
    app.listen(config.port, config.host, () => {
        const parts = Object.entries(names).map(([k, v]) => `${k} ${v.length}`);
        console.error(`infomaniak-mcp listening on ${config.host}:${config.port}, ${total} tools (${parts.join(", ")}); per-user tokens for ${config.allowedEmailDomains.join(", ")}; shared token ${config.bearerToken ? "on" : "off"}`);
    });
}

main().catch((e) => {
    console.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
