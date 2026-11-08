import crypto from "node:crypto";

export type Resolution =
    | {ok: true; token: string; email: string}
    | {ok: false; status: number; message: string};

export type ProfileFetcher = (token: string) => Promise<{status: number; email?: string}>;

export const VALID_TTL_MS = 5 * 60_000;
export const INVALID_TTL_MS = 30_000;
const MAX_ENTRIES = 1000;

export const fetchProfile: ProfileFetcher = async (token) => {
    const res = await fetch("https://api.infomaniak.com/2/profile", {
        headers: {Authorization: `Bearer ${token}`},
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
        await res.body?.cancel();
        return {status: res.status};
    }
    const body = (await res.json()) as {data?: {email?: unknown}};
    return {status: 200, email: typeof body.data?.email === "string" ? body.data.email : undefined};
};

export const tokenKey = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** Validates a user's Infomaniak token against /2/profile and an email-domain allowlist, with a small cache. */
export class TokenResolver {
    private cache = new Map<string, {value: Resolution; expires: number}>();

    constructor(
        private readonly allowedDomains: string[],
        private readonly fetcher: ProfileFetcher = fetchProfile,
        private readonly now: () => number = Date.now,
    ) {}

    async resolve(token: string): Promise<Resolution> {
        const key = tokenKey(token);
        const hit = this.cache.get(key);
        if (hit && hit.expires > this.now()) return hit.value;
        const value = await this.check(token);
        if (this.cache.size >= MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
        this.cache.set(key, {value, expires: this.now() + (value.ok ? VALID_TTL_MS : INVALID_TTL_MS)});
        return value;
    }

    private async check(token: string): Promise<Resolution> {
        let profile;
        try {
            profile = await this.fetcher(token);
        } catch {
            return {ok: false, status: 503, message: "Infomaniak profile check failed; try again"};
        }
        if (profile.status === 401) return {ok: false, status: 401, message: "Infomaniak token is invalid or expired"};
        if (profile.status === 403) {
            return {ok: false, status: 401, message: "Infomaniak token needs the user_info scope (plus the product scopes)"};
        }
        if (profile.status !== 200 || !profile.email) {
            return {ok: false, status: 503, message: `Infomaniak profile check failed (${profile.status})`};
        }
        const domain = profile.email.split("@").pop()!.toLowerCase();
        if (!this.allowedDomains.includes(domain)) {
            return {ok: false, status: 403, message: "This Infomaniak account is not allowed on this server"};
        }
        return {ok: true, token, email: profile.email};
    }
}
