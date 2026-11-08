<div align="center">

**One MCP server for Infomaniak Mail, Calendar, kDrive, Contacts, and kChat. The operator picks the products; each user picks the tools. Powered by [versa](https://versa.training)**

<a href="package.json"><img src="https://img.shields.io/badge/node-%E2%89%A522-blue?style=flat-square" alt="Node 22 or newer"></a>
<a href="#what-it-is"><img src="https://img.shields.io/badge/MCP-Streamable_HTTP-d97757?style=flat-square" alt="MCP Streamable HTTP"></a>
<a href="#tools"><img src="https://img.shields.io/badge/tools-102-555?style=flat-square" alt="102 tools"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT license"></a>

**[What it is](#what-it-is) · [Tool selection](#tool-selection) · [Authentication](#authentication) · [Connect](#connect-a-client) · [Tools](#tools) · [Improvements](#improvements-over-the-originals) · [Run](#run-locally) · [Credits](#credits)**

</div>

## What it is

Infomaniak publishes one MCP server per product. This project runs one server instead of five. It speaks Streamable HTTP at `POST /mcp` and exposes the tools of Infomaniak Mail, Calendar, kDrive, Contacts, and kChat. It is stateless: each request builds its own server and answers as JSON.

The five Infomaniak servers live in `packages/` as npm workspaces, vendored from our forks. The root server imports `registerTools` from each. The forks carry our fixes and new tools (see [Improvements](#improvements-over-the-originals)).

`GET /healthz` answers `{"ok":true}` without auth. Every other path returns 404.

## Tool selection

Tool selection has two levels. The operator sets which products and risky tools the server registers. Each user then picks which of those tools to enable in their own agent (the MCP client).

### Pick tools in your client

The server registers every enabled product for every caller. Turn off the tools you do not want in your client.

In Claude Code, add deny rules to `~/.claude/settings.json` (all your projects) or `.claude/settings.json` (one project). A rule names one tool as `mcp__<server>__<tool>`, where `<server>` is the name you gave in `claude mcp add`. This example, for a server added as `infomaniak`, turns off deleting mail and posting to kChat:

```json
{
  "permissions": {
    "deny": [
      "mcp__infomaniak__mail_delete_email",
      "mcp__infomaniak__kchat_post_message",
      "mcp__infomaniak__kchat_send_direct_message"
    ]
  }
}
```

`mcp__infomaniak__*` matches every tool of the server. Syntax: [Claude Code permissions](https://code.claude.com/docs/en/permissions#mcp).

In claude.ai and the Claude desktop app, open **Customize > Connectors**, select the connector, and set each tool under **Tool permissions** to **Always allow**, **Needs approval**, or **Blocked** ([Get started with connectors](https://claude.com/docs/connectors)). Most other MCP clients also let you enable or disable individual tools.

### Set the upper bound on the server

The operator chooses with environment variables which products and risky tools exist at all. A client can only turn off tools the server registers; it cannot add tools the server leaves out.

| Product | Registered when |
|---|---|
| Mail | Always |
| Calendar | Always |
| Contacts | Always |
| kDrive | `KDRIVE_ID` is set |
| kChat | `KCHAT_TEAM_NAME` is set |

Three flags control risky behavior. All default to `false`. They accept `true`, `false`, `1`, `0`, `yes`, `no`; any other value stops the server at startup.

| Flag | Off | On |
|---|---|---|
| `MAIL_ALLOW_SEND` | `mail_send_email`, `mail_send_draft`, and the auto-reply write tools are not registered. Drafts are still saved for a human to send. | These five tools register, and reply and forward can send. |
| `MAIL_ALLOW_PERMANENT_DELETE` | `mail_purge_folder` is not registered. `mail_delete_email` only moves mail to Trash. | Both can delete permanently. |
| `KDRIVE_ALLOW_PUBLIC_LINKS` | No tool is removed, but kDrive tools reject public share link rights. | Public links are allowed. |

Local file attachments from disk are always off in this server.

Example: mail (read and draft only), calendar, contacts, and kDrive. No kChat, no sending, no public links.

```env
KDRIVE_ID=123456
# KCHAT_TEAM_NAME is unset, so kChat is skipped
MAIL_ALLOW_SEND=false
MAIL_ALLOW_PERMANENT_DELETE=false
KDRIVE_ALLOW_PUBLIC_LINKS=false
```

At startup, the server stops if two products register the same tool name.

## Authentication

Every request to `/mcp` needs `Authorization: Bearer <token>`. Two kinds of token work.

- A shared token. Set `MCP_BEARER_TOKEN` (at least 32 characters) and `INFOMANIAK_TOKEN`. A client that sends the shared token acts through the one `INFOMANIAK_TOKEN` account. If you leave `MCP_BEARER_TOKEN` unset, this path is off.
- A user's own Infomaniak API token. The server checks it against the Infomaniak profile endpoint and accepts it only when the account email domain is in `ALLOWED_EMAIL_DOMAINS` (comma-separated). Other accounts get 403. The server then calls Infomaniak with that user's token. Results of the check are cached for 5 minutes (30 seconds for a failure).

Set `ALLOWED_EMAIL_DOMAINS` to your own domain. The built-in default is `versa.training`, the maintainers' domain, so without it only versa.training accounts get in.

A user's token needs the scopes `user_info`, `user_email`, `workspace:mail`, `mail`, `workspace:calendar`, `kmeet`, `workspace:contact`, `drive`, and `kchat`.

The server-side product and flag settings apply to everyone. A user's token sets whose data is read, not which tools exist.

## Connect a client

```bash
claude mcp add --transport http infomaniak https://your-host.example/mcp \
  --header "Authorization: Bearer <your Infomaniak API token>"
```

Use `http://127.0.0.1:8787/mcp` when you run the server on your own machine. Web clients such as claude.ai need a public HTTPS URL.

## Tools

102 tools with every product and flag on. Counted from the tools the built server registers.

| Product | Tools | Count |
|---|---|---|
| Mail | `mail_list_mailboxes` `mail_list_identities` `mail_list_forwarding` `mail_list_folders` `mail_create_folder` `mail_delete_folder` `mail_rename_folder` `mail_list_emails` `mail_search_emails` `mail_read_email` `mail_download_attachment` `mail_create_draft` `mail_update_draft` `mail_delete_draft` `mail_list_drafts` `mail_mark_email` `mail_move_email` `mail_flag_email` `mail_archive_email` `mail_delete_email` `mail_reply` `mail_forward` `mail_read_thread` `mail_list_auto_replies` | 24 |
| Mail, with `MAIL_ALLOW_SEND` | `mail_send_email` `mail_send_draft` `mail_create_auto_reply` `mail_update_auto_reply` `mail_delete_auto_reply` | 5 |
| Mail, with `MAIL_ALLOW_PERMANENT_DELETE` | `mail_purge_folder` | 1 |
| Calendar | `calendar_list_calendars` `calendar_list_events` `calendar_get_event` `calendar_create_event` `calendar_update_event` `calendar_delete_event` `calendar_list_resources` `calendar_find_free_slots` | 8 |
| kDrive | `kdrive_search` `kdrive_upload_file` `kdrive_list` `kdrive_rename` `kdrive_move` `kdrive_delete` `kdrive_share_link` `kdrive_share_access` `kdrive_list_access` `kdrive_remove_access` `kdrive_update_access` `kdrive_set_favorite` `kdrive_find_by_name` `kdrive_create_folder` `kdrive_restore` `kdrive_download_file` `kdrive_info` `kdrive_recents` `kdrive_shared_with_me` `kdrive_read_text` `kdrive_list_trash` `kdrive_get_share_link` `kdrive_update_share_link` `kdrive_delete_share_link` `kdrive_copy` `kdrive_list_versions` `kdrive_restore_version` `kdrive_get_download_url` `kdrive_list_favorites` `kdrive_list_my_shared` `kdrive_list_file_activities` `kdrive_drive_info` `kdrive_create_office_file` `kdrive_list_comments` `kdrive_add_comment` | 35 |
| Contacts | `contact_list_contacts` `contact_search_contacts` | 2 |
| kChat | `kchat_list_channels` `kchat_post_message` `kchat_reply_to_thread` `kchat_add_reaction` `kchat_get_channel_history` `kchat_get_thread_replies` `kchat_get_users` `kchat_send_direct_message` `kchat_send_group_message` `kchat_get_user_profile` `kchat_search_messages` `kchat_get_unread` `kchat_search_channels` `kchat_search_users` `kchat_edit_message` `kchat_delete_message` `kchat_pin_message` `kchat_get_post_files` `kchat_download_file` `kchat_upload_file` `kchat_remove_reaction` `kchat_get_reactions` `kchat_get_pinned_messages` `kchat_get_channel` `kchat_mark_channel_read` `kchat_get_channel_members` `kchat_get_saved_messages` | 27 |

With all flags off, Mail has 24 tools and the total is 96.

## Improvements over the originals

- **One combined server.** One process, one endpoint, one token check for five products. The operator sets the products and risky tools at deploy time, and each user can turn off tools in their client (see [Tool selection](#tool-selection)). Startup fails on duplicate tool names.

The rest comes from the fork branches. Each item names the branch or commit it came from.

**Security**

- Mail: send tools can be switched off, and then drafts are saved for a human to send (`fix/mail-send-guard`). Send tools carry a warning (`fix/send-forwarding-security`).
- Mail: permanent delete is its own switch (`MAIL_ALLOW_PERMANENT_DELETE`, `fix/mail-polish`).
- Mail: local file paths are gated, and attachments can be passed as base64 (`fix/mail-attachments-base64`).
- Mail: text hidden by style rules, tiny fonts, or hidden elements is dropped from message text (`fix/hidden-text`, `fix/html-text-hardening`, `fix/html-text-limits`).
- Mail: attachment file names are encoded and downloads are capped at 5 MB (`fix/attachment-limits`).
- kDrive: public share links can be switched off, and the guard also covers updates, download URLs, and merged results (`fix/share-link-guards`, `fix/share-link-rules`).
- kDrive: unknown boolean env values are rejected (commit "reject unknown boolean env values").
- kChat: message content is returned in fields marked as untrusted (`fix/output-shaping`), and `untrusted_content` tags are stripped from text files (`fix/kchat-untrusted-wrapper`). Other members' read activity is omitted (`fix/kchat-member-privacy`).
- kDrive: file activity users are reduced to a display name (`fix/kdrive-activities-privacy`).
- All products: path segments and IDs are encoded and validated before they go into a request URL (commits "encode path segments", "validate ids").

**Reliability**

- All products: responses are checked for status, errors are bounded, and requests time out. Reads retry (`fix/http-errors`, plus `fix/http-resilience` in Mail and `fix/http-retry-limits` in Contacts).
- All products: one deadline per tool call, cancellation is honored, and a timed-out call is not retried (`fix/http-resilience`, `fix/request-deadlines`, `fix/kchat-deadlines`, `fix/calendar-requests-3`, `fix/timeouts-cancel`). Calendar also retries writes after a 429.
- All products: `Retry-After` is honored (`fix/http-resilience` in Mail, `fix/truncation-paging` in Calendar, kDrive, and kChat, `fix/http-retry-limits` in Contacts). Mail also parses date values (`fix/client-cache-and-headers`).
- Mail: a send that timed out comes with a warning that it may have gone out (`fix/send-failure-advice`).
- Calendar, Contacts, kChat: shared cached loads no longer depend on one call's cancel signal (`fix/shared-load-cancellation`, `fix/shared-load-signal`).
- Mail: account caches refresh, and draft quotes and recipients survive a reload (`fix/client-cache-and-headers`, `fix/draft-reload`).
- All products: SDK and zod ship as runtime dependencies with caret ranges, and each fork exports its client and `registerTools` (`fix/library-packaging`, `fix/export-register-tools`, and caret ranges in `fix/dependency-ranges`, `fix/kchat-dependency-ranges`, `fix/calendar-packaging-3`).

**Output shaping and paging**

- All products: tools register with titles and annotations, inputs are validated with schemas, and output is compact structured JSON under a size cap (`fix/register-tool-annotations`, `fix/input-schemas`, `fix/output-shaping`).
- All products: oversize results are trimmed without skipping items, and truncated lists can resume (`fix/truncation-paging`, `fix/size-cap-arrays`, `fix/page-fitting`, `fix/kchat-resume-inputs`).
- kDrive and kChat: list tools take a limit and cursor or offset (`fix/kdrive-paging`, `fix/kchat-resume-inputs`, `fix/kchat-paging`).
- Contacts: search ranks results, folds accents and characters like ss and o-slash, ignores punctuation, and shows what matched (`fix/contact-search`, `fix/contact-search-index`, `fix/search-matching`, `fix/contact-query-punctuation`).
- Calendar: event listings are capped and cached, and partial calendars come back with warnings (`fix/calendar-listing`, `fix/calendar-listing-3`).
- Mail: thread reads have a size budget and keep folders on messages (`fix/thread-rows-and-reading`, `fix/thread-message-refs`).
- kChat: author names, reactions, attachment text, and DM names appear in results (`fix/kchat-author-context`). Channel lists are cached, with unread channels read fresh (`fix/kchat-channel-cache`, `fix/kchat-unread-channels`).

**New tools and inputs**

- Mail: `mail_reply`, `mail_forward`, `mail_read_thread`, and the auto-reply tools (`cf493b9` "add reply, forward, thread read, and auto-reply tools").
- Mail: `mail_list_identities`, and recipients can be given with names (`fix/mail-ux`).
- Mail: `mail_list_forwarding`, read-only (`feat/mail-list-forwarding`).
- Calendar: `calendar_find_free_slots` and more event fields (`feat/calendar-event-fields`); free slots count own time (`fix/calendar-free-slots-3`); `calendar_list_resources` (`fix/calendar-polish`).
- Calendar: kMeet links for any event, with lobby and password (`feat/calendar-kmeet`, `fix/calendar-kmeet-3`). All-day events (commit "support all-day events").
- Calendar: invitation control and attendee merging (`fix/calendar-attendees`); organizer and owner entries are kept on update (`fix/calendar-attendees-2`, `fix/calendar-attendees-3`).
- kDrive: text reading, trash, links, copy, versions (commit "add text reading, trash, links, copy, versions").
- kDrive: list, update, and remove access, team access, favorites, and find by name (`feat/access-management`, `feat/access-favorites-lookup`).
- kDrive: upload into a folder path (`feat/upload-directory-path`). File activities and drive info (`feat/file-activities`).
- kChat: search, unread counts, edit and delete own posts (commit "search, unread counts, edit and delete own posts").
- kChat: group messages, reactions, and pinned messages (`feat/kchat-new-tools`). Channel, members, saved messages, and mark-read (`feat/kchat-more-tools`). Thread replies with a cursor (`feat/kchat-thread-paging`).

**Correctness**

- Mail: localized reply and forward prefixes are recognized (`fix/subject-prefixes`). Thread references are added, and drafts with unmapped attachments are refused (`fix/thread-draft-refs`).
- Mail: drafts load before a change, and forwards are escaped (`fix/draft-safety`). Delete refs are grouped by folder before the Trash check (`fix/delete-folder-refs`).
- Calendar: dates are predictable, time zone names are canonicalized, and `rrule` parts may come in any order (`fix/calendar-dates`, `fix/calendar-timezone-3`, `fix/calendar-validation`).
- Calendar: updates keep stored values and send explicit clears (`fix/calendar-update-semantics`).
- kDrive: enums, password links, and uploads are corrected (commit "correct enums, password links, and uploads"). Page-based lists always request page 1 (`fix/kdrive-first-page`).
- kChat: history is ordered, uploads send query params, and downloads are type-aware (commits "order history, list own channels", "upload with query params, type-aware downloads").

Each package README in `packages/` lists its breaking input changes.

## Run locally

Node 22 or newer. The repository is an npm workspace: the root server plus the five packages in `packages/`.

```bash
git clone https://github.com/versa-training/infomaniak-mcp.git
cd infomaniak-mcp
npm ci
npm run build
MCP_BEARER_TOKEN=$(openssl rand -hex 24) INFOMANIAK_TOKEN=... \
  ALLOWED_EMAIL_DOMAINS=example.com KDRIVE_ID=... KCHAT_TEAM_NAME=... npm start
```

`npm run build` compiles each package, then the root. The server listens on `127.0.0.1:8787` by default (`HOST`, `PORT`).

`npm test` runs the tests of every package, then the root tests. All use `node --test` with stubbed `fetch`, so they make no Infomaniak calls.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MCP_BEARER_TOKEN` | unset | Optional shared bearer token, at least 32 characters. Needs `INFOMANIAK_TOKEN`. |
| `INFOMANIAK_TOKEN` | unset | Token used for requests that carry the shared bearer token. |
| `ALLOWED_EMAIL_DOMAINS` | `versa.training` | Email domains whose users may bring their own token, comma-separated. Set your own domain. |
| `PORT` | `8787` | Listen port. |
| `HOST` | `127.0.0.1` | Listen address. |
| `KDRIVE_ID` | unset | Enables kDrive. |
| `KCHAT_TEAM_NAME` | unset | Enables kChat (team subdomain). |
| `MAIL_ALLOW_SEND` | `false` | See [Tool selection](#tool-selection). |
| `MAIL_ALLOW_PERMANENT_DELETE` | `false` | See [Tool selection](#tool-selection). |
| `KDRIVE_ALLOW_PUBLIC_LINKS` | `false` | See [Tool selection](#tool-selection). |

Limits: request body 1 MB (413), request timeout 150 s. Tokens and request bodies are not logged.

## Docker

The build context is the repository root:

```bash
docker build -t infomaniak-mcp .
docker run -p 8787:8787 -e MCP_BEARER_TOKEN=... -e INFOMANIAK_TOKEN=... \
  -e ALLOWED_EMAIL_DOMAINS=example.com infomaniak-mcp
```

The image runs as the `node` user, listens on `0.0.0.0:8787`, and has a health check on `/healthz`.

## Credits

This project builds on the Infomaniak MCP servers. All original code is by Infomaniak and MIT-licensed (`"license": "MIT"` in each `package.json`, and a License section in each README).

- [mcp-server-mail](https://github.com/Infomaniak/mcp-server-mail)
- [mcp-server-calendar](https://github.com/Infomaniak/mcp-server-calendar)
- [mcp-server-kdrive](https://github.com/Infomaniak/mcp-server-kdrive)
- [mcp-server-contact](https://github.com/Infomaniak/mcp-server-contact)
- [mcp-server-kchat](https://github.com/Infomaniak/mcp-server-kchat)

The code in `packages/` is vendored from our forks, which add the changes listed above on top of the upstream `main` branches.

## About

infomaniak-mcp is from the team behind [versa.training](https://versa.training). Looking for a tool to help your team master difficult conversations? Check out [versa.training](https://versa.training).

## License

[MIT](LICENSE). The code in `packages/` is copyright Infomaniak and also MIT-licensed.

---

<div align="center">

**One server, five Infomaniak products.**

<sub>
<a href="https://github.com/versa-training/infomaniak-mcp/issues">Issues</a>
</sub>

</div>
