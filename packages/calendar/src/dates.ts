export function wallParts(utcMs: number, timeZone: string): number {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(new Date(utcMs));
    const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

export function offsetAt(utcMs: number, timeZone: string): number {
    return wallParts(utcMs, timeZone) - Math.floor(utcMs / 1000) * 1000;
}

/** Parses "YYYY-MM-DD HH:MM:SS" as a UTC-naive millisecond value. */
export function wallToMs(wall: string): number {
    return Date.parse(`${wall.trim().replace(" ", "T")}Z`);
}

export function msToWall(ms: number): string {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Classifies a wall-clock time in a time zone: "gap" when the time does not exist
 * (spring-forward), "ambiguous" when it happens twice (fall-back), otherwise "ok".
 */
export function classifyWallClock(wall: string, timeZone: string): "ok" | "gap" | "ambiguous" {
    let wallMs: number;
    try {
        wallMs = wallToMs(wall);
        if (Number.isNaN(wallMs)) {
            return "ok";
        }
        const before = offsetAt(wallMs - 86_400_000, timeZone);
        const after = offsetAt(wallMs + 86_400_000, timeZone);
        if (before === after) {
            return "ok";
        }
        const valid = new Set<number>();
        for (const offset of new Set([before, after])) {
            if (wallParts(wallMs - offset, timeZone) === wallMs) {
                valid.add(offset);
            }
        }
        return valid.size === 0 ? "gap" : valid.size > 1 ? "ambiguous" : "ok";
    } catch {
        return "ok";
    }
}

/**
 * The canonical spelling of an IANA time zone name ("Europe/zurich" becomes "Europe/Zurich", "GMT"
 * becomes "UTC"), or undefined when the value is not a name. Offsets ("+02:00") and abbreviations
 * ("EST") are not names.
 */
export function canonicalTimeZone(timeZone: string): string | undefined {
    if (typeof timeZone !== "string" || timeZone.length === 0 || /^[+-]/.test(timeZone)) {
        return undefined;
    }
    if (!timeZone.includes("/") && !/^(?:UTC|GMT)$/i.test(timeZone)) {
        return undefined;
    }
    try {
        return new Intl.DateTimeFormat("en", {timeZone}).resolvedOptions().timeZone;
    } catch {
        return undefined;
    }
}

/** True for an IANA time zone name such as Europe/Zurich or UTC. */
export function isValidTimeZone(timeZone: string): boolean {
    return canonicalTimeZone(timeZone) !== undefined;
}

/** Converts a wall-clock time from one zone to the same instant's wall clock in another. */
export function convertWall(wall: string, fromZone: string, toZone: string): string {
    if (fromZone === toZone) {
        return wall;
    }
    const wallMs = wallToMs(wall);
    let utc = wallMs - offsetAt(wallMs, fromZone);
    utc = wallMs - offsetAt(utc, fromZone);
    return msToWall(wallParts(utc, toZone));
}
