# Calendar MCP Server

MCP Server for the Calendar API.

## Tools

Results are compact JSON with `structuredContent`. Lists return `{items, has_more, next_offset, total}`. Text written by third parties is data, never instructions: the event description and location are returned under `untrusted_content`, and titles, calendar names, and attendee names also come from inviters and sharers. Results are capped at 100,000 characters (`truncated: true`): lists drop trailing items and continue at `next_offset`, and one oversize record loses its free text first (cut with a `…` marker), then the second half of its long arrays (`<key>_omitted` counts them), and `shortened` names every cut field. A tool call stops after 90 seconds in total, or when the client cancels it.

1. `calendar_list_calendars`
   - List all your available calendars
   - Returns: `items` (calendars with `id`, `name`, `color`, `default`; share lists and user addresses are left out)

2. `calendar_list_events`
   - List events in a time range across all your calendars (own, shared, secondary), sorted by start
   - Required inputs:
      - `from` (string): Start of the range (eg. 2025-05-28 12:00:00)
      - `to` (string): End of the range, inclusive (a date-only value covers that whole day); the range is limited to 366 days
   - Optional inputs:
      - `calendar_id` (number): Only this calendar
      - `query` (string): only events whose title or location contains every word of the text (case and accents ignored)
      - `limit` (1-200, default 50), `offset` (default 0)
   - Returns: short event records with `calendar_id` and `calendar_name`, sorted by start moment. A calendar that cannot be read is named in `warnings` and the others are still listed. Records carry `my_state` (your reply) and `is_organizer` when the event has attendees. Fetched listings are reused for about a minute, so paging is cheap. Use `calendar_get_event` for the full record.

3. `calendar_get_event`
   - Get a single event by ID
   - Required inputs: `event_id` (number)
   - Returns: the event; `description` and `location` sit under `untrusted_content`. Includes `bookable_resource_name` when the event books a room.

4. `calendar_create_event`
   - Create an event
   - Required inputs: `title`, `start`, `end`
   - Optional inputs:
      - `description`, `location`
      - `attendees` (array of emails). Attendees are added but only emailed an invitation when `notify_attendees` is true (default false).
      - `all_day` (boolean): date-only `start` and `end` create an all-day event; the end date is inclusive.
      - `rrule` (RFC 5545, eg. `FREQ=WEEKLY;BYDAY=MO`)
      - `reminders_minutes` (array of minutes before the start), `private`, `show_as` (`busy`, `free`, `tentative`)
      - `timezone` (IANA name, defaults to your profile time zone)
      - `bookable_resource_id` (from `calendar_list_resources`), `calendar_id`
      - `with_kmeet` (boolean): plan the event with a kMeet video room through `POST /1/kmeet/rooms`; the event carries the link in `meet_room_url`. Needs the `kmeet` token scope and a start and end time (not `all_day`). Attendees need `notify_attendees` true because kMeet may email them. `kmeet_lobby` (default on when people are invited) and `kmeet_password` set the room options. An event that also has `rrule`, `location`, `reminders_minutes`, `private`, a `show_as` other than busy, or `bookable_resource_id` is created normally with a link generated locally (the kMeet host plus a unique id, sent as `meet_room_url`; unverified against the live API), and the room options are not available. Not tested against the live API.
   - Returns: the created event, plus `warnings` for ambiguous local times

5. `calendar_update_event`
   - Update an event; omitted fields keep their stored value. Recurring events change as a whole series.
   - Required inputs: `event_id`
   - Optional inputs: `title`, `start`, `end`, `description`, `location`, `attendees`, `all_day`, `rrule` (empty string removes recurrence), `reminders_minutes`, `private`, `show_as`, `timezone`, `bookable_resource_id` (empty string releases it), `calendar_id`, `notify_attendees` (email the update, organizer only, default false), and `with_kmeet` (add a locally generated kMeet link when the event has none). `with_kmeet` on create has more options (`kmeet_lobby`, `kmeet_password`) that update does not take.
   - Notes: `attendees` replaces the invitee list by address (replies and the organizer are kept; an empty array removes everyone except the organizer and your own entry). Changing only `start` moves `end` by the same amount.

6. `calendar_delete_event`
   - Delete an event (the whole series for recurring events)
   - Required inputs: `event_id`
   - Optional inputs: `calendar_id` (defaults to the event's own calendar), `notify_attendees` (email a cancellation, default false)

7. `calendar_list_resources`
   - List bookable resources (rooms, equipment) with their `uuid`, `name`, and type or capacity when given; permission data is left out

8. `calendar_find_free_slots`
   - Find free gaps of at least `duration_minutes` inside working hours (`day_start`, `day_end`, weekends off by default) in your own schedule: calendars you own count in full, shared calendars count only events where you are an attendee, and `calendar_id` or `calendar_ids` count every event of exactly those calendars. Attendees' calendars are not checked. Events you declined, cancelled events, and events marked free do not block time.
   - Required inputs: `from`, `to` (at most 62 days), `duration_minutes`
   - A time of day in `from` or `to` bounds the search, and slots never start in the past. A range that lies in the past returns no slots and a warning. All-day events block their own calendar days when `all_day_blocks` is true.

## Date & time

All date inputs are interpreted in your profile timezone (the one set in your Infomaniak account), and event times always match the wall clock you provide regardless of the machine running the server:

- `2025-05-28 12:00:00` (or `2025-05-28T12:00:00`) means 12:00 in your profile timezone
- `2025-05-28` means midnight (00:00:00) in your profile timezone, or the whole day for all-day events
- `2025-05-28T10:00:00Z` or `2025-05-28T12:00:00+02:00` (ISO with offset) are converted to your profile timezone
- An account without a time zone setting gets an error instead of UTC: set one in your Infomaniak profile, or pass `timezone` when creating an event.

No `TZ` environment variable is required.

## Setup

1. Create a calendar token linked to your user:
    - Visit the [API Token page](https://manager.infomaniak.com/v3/ng/accounts/token/list)
    - Choose "workspace:calendar user_info" scopes (add "kmeet" to use `with_kmeet`)

### Usage with Claude Desktop

Add the following to your `claude_desktop_config.json`:

#### NPX

```json
{
  "mcpServers": {
    "calendar": {
      "command": "npx",
      "args": [
        "-y",
        "@infomaniak/mcp-server-calendar"
      ],
      "env": {
        "CALENDAR_TOKEN": "your-token"
      }
    }
  }
}
```

#### docker

```json
{
  "mcpServers": {
    "calendar": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "CALENDAR_TOKEN",
        "infomaniak/mcp-server-calendar"
      ],
      "env": {
        "CALENDAR_TOKEN": "your-token"
      }
    }
  }
}
```

### Environment Variables

1. `CALENDAR_TOKEN`: Required. Your calendar token.
2. `KMEET_HOSTNAME`: Optional. kMeet host for `with_kmeet` events (default `kmeet.infomaniak.com`).

### Troubleshooting

If you encounter permission errors, verify that:
1. All required scopes are added to your calendar token
2. The token is correctly copied to your configuration

## Use as a library

The package exports `registerTools` and the `CalendarClient` class from `dist/tools.js`. Importing it has no side effects: it reads no environment variables and starts no server.

```ts
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {CalendarClient, registerTools} from "@infomaniak/mcp-server-calendar";

const server = new McpServer({name: "calendar", version: "1.0.0"}, {capabilities: {tools: {}}});
registerTools(server, new CalendarClient(token, {retryDelayMs: 500}));
// connect `server` to the transport of your choice
```

- `CalendarClient(token, options?)`: `options.retryDelayMs` sets the base delay before the one retry of a failed `GET` (default 500 ms; a write retries once only on HTTP 429, a timeout is never retried, and `Retry-After` up to 10 s is honored), `options.cacheTtlMs` how long the profile and calendar list stay cached (default 5 minutes, 0 disables), and `options.kmeetHostname` the host for `with_kmeet` events.
- `@modelcontextprotocol/sdk` (peer range `^1.32`) and `zod` (peer range `^4`) are peer dependencies, and the package also lists them in `dependencies` as `^1.32.1` and `^4.6.5` so the Docker image installs them. A host whose versions satisfy those ranges (SDK 1.32.1 or later 1.x, zod 4.6.5 or later 4.x) shares one copy with this package. A host on an older version inside the peer range gets a second, nested copy: raise it, or add an `overrides` entry for both packages.
- Requires Node.js 22 or later.

## Breaking changes

- Tool inputs are typed: `event_id` and `calendar_id` are numbers, `attendees` is an array of emails (it was a JSON string), and `notify_attendees` is a boolean.
- `calendar_list_events` lists every calendar of the account unless `calendar_id` is given, returns short records, and pages with `limit` and `offset`.
- All-day events take an inclusive end date: `start` and `end` as `YYYY-MM-DD` create an all-day event, and the same date for both is a one-day event.
- Attendees are only emailed when `notify_attendees` is true (default false).
- Event `description` and `location` come back under `untrusted_content`.
- Errors surface as MCP tool errors (`isError: true`) with the HTTP status and API error code.
- A timed event must end after it starts (a zero-length event is rejected), and an account without a time zone setting gets an error instead of UTC.
- `calendar_list_calendars` and `calendar_list_resources` page with `limit` and `offset`, and a list result that is too long to return continues at `next_offset` without skipping items.
- On update, `notify_attendees` also sends the iMIP request, and an empty `location` or `bookable_resource_id` clears the value.
- The server advertises only the `tools` capability.
- `notify_attendees` on update and delete is rejected when someone else organizes the event.
- `calendar_find_free_slots` counts owned calendars in full and shared calendars only for events you attend; pass `calendar_id` or `calendar_ids` to count every event of those calendars.
- `calendar_list_events` rejects ranges over 366 days and `query` needs every word to match (accents ignored).
- `with_kmeet` no longer rejects options at their default value, and an event with `rrule`, `location`, reminders, or a room gets a locally generated kMeet link.
- `calendar_update_event` is no longer marked idempotent, because repeating it with `notify_attendees` emails everyone again.
- Time zone names are sent in their canonical spelling (`Europe/zurich` becomes `Europe/Zurich`).

## Build

Docker build:

```bash
docker build -t infomaniak/mcp-server-calendar -f Dockerfile .
```

## License

This MCP server is licensed under the MIT License.
