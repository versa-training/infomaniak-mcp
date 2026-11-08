export interface Config {
    /** Optional shared token that maps to INFOMANIAK_TOKEN (for a service account). */
    bearerToken: string | undefined;
    /** Email domains whose Infomaniak tokens may be used as the bearer. */
    allowedEmailDomains: string[];
    infomaniakToken: string | undefined;
    port: number;
    host: string;
    kdriveId: string | undefined;
    kchatTeamName: string | undefined;
    mailAllowSend: boolean;
    mailAllowPermanentDelete: boolean;
    kdriveAllowPublicLinks: boolean;
}

type Env = Record<string, string | undefined>;

function flag(env: Env, name: string): boolean {
    const raw = env[name]?.trim().toLowerCase();
    if (raw === undefined || raw === "") return false;
    if (["true", "1", "yes"].includes(raw)) return true;
    if (["false", "0", "no"].includes(raw)) return false;
    throw new Error(`${name} must be one of true, false, 1, 0, yes, no`);
}

function optional(env: Env, name: string): string | undefined {
    const v = env[name]?.trim();
    return v ? v : undefined;
}

export function loadConfig(env: Env = process.env): Config {
    const bearerToken = optional(env, "MCP_BEARER_TOKEN");
    if (bearerToken !== undefined && bearerToken.length < 32) throw new Error("MCP_BEARER_TOKEN must be at least 32 characters");
    if (bearerToken !== undefined && !optional(env, "INFOMANIAK_TOKEN")) throw new Error("MCP_BEARER_TOKEN needs INFOMANIAK_TOKEN");
    const allowedEmailDomains = (optional(env, "ALLOWED_EMAIL_DOMAINS") ?? "versa.training")
        .split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
    const port = Number(env.PORT ?? "8787");
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer from 0 to 65535");
    return {
        bearerToken,
        allowedEmailDomains,
        infomaniakToken: optional(env, "INFOMANIAK_TOKEN"),
        port,
        host: optional(env, "HOST") ?? "127.0.0.1",
        kdriveId: optional(env, "KDRIVE_ID"),
        kchatTeamName: optional(env, "KCHAT_TEAM_NAME"),
        mailAllowSend: flag(env, "MAIL_ALLOW_SEND"),
        mailAllowPermanentDelete: flag(env, "MAIL_ALLOW_PERMANENT_DELETE"),
        kdriveAllowPublicLinks: flag(env, "KDRIVE_ALLOW_PUBLIC_LINKS"),
    };
}
