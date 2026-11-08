import {z} from "zod";

export const DATE_FORMATS =
    "YYYY-MM-DD, YYYY-MM-DDTHH:MM[:SS], or YYYY-MM-DDTHH:MM[:SS] followed by Z or an offset such as +02:00";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

export function isValidDateInput(value: string): boolean {
    const text = value.trim();
    if (!DATE_PATTERN.test(text)) {
        return false;
    }
    const [year, month, day] = text.slice(0, 10).split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        return false;
    }
    const time = /[T ](\d{2}):(\d{2})(?::(\d{2}))?/i.exec(text);
    return !time || (Number(time[1]) < 24 && Number(time[2]) < 60 && Number(time[3] ?? 0) < 60);
}

export const idSchema = z.coerce.number().int().positive();

export const dateSchema = z
    .string()
    .max(40)
    .refine(isValidDateInput, {message: `Use ${DATE_FORMATS}`});

export const attendeesSchema = z.array(z.email().max(254)).max(100);

/** An RFC 5545 rule: `NAME=value` parts in any order, with exactly one FREQ. */
export const RRULE_PATTERN = /^(?:RRULE:)?(?:[A-Z]+=[^;=\s]+;)*FREQ=(?:SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)(?:;[A-Z]+=[^;=\s]+)*$/;

export function isValidRrule(value: string): boolean {
    return RRULE_PATTERN.test(value) && value.split(";").filter(part => part.replace(/^RRULE:/, "").startsWith("FREQ=")).length === 1;
}

export const rruleSchema = z
    .string()
    .max(500)
    .refine(value => value === "" || isValidRrule(value), {
        message: "Use RFC 5545 syntax such as FREQ=WEEKLY;BYDAY=MO, or an empty string",
    });

export const titleSchema = z.string().min(1).max(500);
export const descriptionSchema = z.string().max(20000);

export const DATE_HELP =
    "ISO 8601: YYYY-MM-DD (midnight, the whole day for all-day events), YYYY-MM-DDTHH:MM[:SS] (wall-clock time in the profile time zone), or with Z or an offset such as +02:00 (converted to the profile time zone).";

export const UPDATE_DATE_HELP =
    "ISO 8601: YYYY-MM-DD (midnight, the whole day for all-day events), YYYY-MM-DDTHH:MM[:SS] (wall-clock time in the event's own time zone, or in timezone when given; not the profile time zone), or with Z or an offset such as +02:00 (converted to that same zone).";
