import {msToWall, wallToMs} from "./dates.js";

export interface FreeSlot {
    start: string;
    end: string;
    minutes: number;
}

export interface FreeSlotQuery {
    busy: Array<{start: string; end: string}>;
    from: string;
    to: string;
    durationMinutes: number;
    dayStart: string;
    dayEnd: string;
    includeWeekends: boolean;
    /** Wall-clock lower bound: nothing is offered before it. */
    notBefore?: string;
    /** Wall-clock upper bound: nothing is offered after it. */
    notAfter?: string;
}

export const MAX_DAYS = 62;

function minutesOf(time: string): number {
    const match = /^(\d{2}):(\d{2})$/.exec(time);
    const hours = Number(match?.[1]);
    const minutes = Number(match?.[2]);
    if (!match || hours > 24 || minutes > 59 || (hours === 24 && minutes !== 0)) {
        throw new Error(`Invalid time "${time}": use HH:MM`);
    }
    return Number(match[1]) * 60 + Number(match[2]);
}

/** Free gaps (at least `durationMinutes` long) inside daily working hours, as wall-clock times. */
export function findFreeSlots(query: FreeSlotQuery): FreeSlot[] {
    const first = wallToMs(`${query.from} 00:00:00`);
    const last = wallToMs(`${query.to} 00:00:00`);
    if (Number.isNaN(first) || Number.isNaN(last) || last < first) {
        throw new Error("from must not be after to");
    }
    if ((last - first) / 86_400_000 + 1 > MAX_DAYS) {
        throw new Error(`The range is limited to ${MAX_DAYS} days`);
    }
    const open = minutesOf(query.dayStart);
    const close = minutesOf(query.dayEnd);
    if (close <= open) {
        throw new Error("day_end must be after day_start");
    }

    const busy = query.busy
        .map(interval => ({start: wallToMs(interval.start), end: wallToMs(interval.end)}))
        .filter(interval => !Number.isNaN(interval.start) && !Number.isNaN(interval.end))
        .sort((a, b) => a.start - b.start);

    const notBefore = query.notBefore ? wallToMs(query.notBefore) : Number.NEGATIVE_INFINITY;
    const notAfter = query.notAfter ? wallToMs(query.notAfter) : Number.POSITIVE_INFINITY;

    const slots: FreeSlot[] = [];
    for (let day = first; day <= last; day += 86_400_000) {
        const weekday = new Date(day).getUTCDay();
        if (!query.includeWeekends && (weekday === 0 || weekday === 6)) {
            continue;
        }
        const windowStart = Math.max(day + open * 60_000, notBefore);
        const windowEnd = Math.min(day + close * 60_000, notAfter);
        if (windowEnd <= windowStart) {
            continue;
        }
        let cursor = windowStart;
        const emit = (from: number, to: number) => {
            const minutes = Math.floor((to - from) / 60_000);
            if (minutes >= query.durationMinutes) {
                slots.push({start: msToWall(from), end: msToWall(to), minutes});
            }
        };
        for (const interval of busy) {
            if (interval.end <= cursor || interval.start >= windowEnd) {
                continue;
            }
            if (interval.start > cursor) {
                emit(cursor, Math.min(interval.start, windowEnd));
            }
            cursor = Math.max(cursor, interval.end);
            if (cursor >= windowEnd) {
                break;
            }
        }
        if (cursor < windowEnd) {
            emit(cursor, windowEnd);
        }
    }
    return slots;
}
