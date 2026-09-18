# MailState Sync 0.9.0 — reviewer notes

## Scope and distribution

This is a public MailExtension for Thunderbird 128+ (Manifest V3). It synchronizes state and moves of existing POP3 messages through the user's own Dropbox app/account. The app key is user-configured; no private membership, unpublished server, developer-issued access credential, Experiment API, native helper, analytics, remote code, or monetization is involved.

The add-on ID `mailstate-sync@example.local` is intentionally retained for upgrades from the existing self-distributed version. It is an identifier, not a support email. The ATN publisher must check its availability when submitting. Author/support metadata is supplied through the publisher's ATN account; no personal identity is inferred from the development machine.

## Data and permissions

| Permission | Use |
| --- | --- |
| `accountsRead` | Display POP3 accounts, read their primary identities, resolve folders. |
| `accountsFolders` | Create missing destination folders. |
| `messagesRead` | Enumerate headers to match Message-IDs and observe mail events. No body/attachment API is used. |
| `messagesUpdate` | Apply the resolved read/unread state. |
| `messagesMove` | Move existing messages within selected accounts. |
| `sensitiveDataUpload` | Disclose transmission of mail metadata to the hardcoded Dropbox service. |
| `storage` | Settings, consent, local canonical metadata, authorization tokens, retry/watch state. |
| `alarms` | Periodic Dropbox checks and persisted-pending upload retries. |
| `downloads` (optional) | User-enabled readable JSON mirror under Downloads. |
| `messagesDelete` (optional) | User-enabled deletion of custom folders confirmed empty on both sides. No `messages.delete()` call. |
| Three Dropbox HTTPS origins | OAuth/token refresh and file metadata (`api`), state file content (`content`), and longpoll (`notify`). Authorization navigation to `www.dropbox.com` does not require host access. |

Fresh installs and legacy upgrades require affirmative in-product consent before collection or sync. Setup opens after installation/update when this consent is missing. No accounts selected means no operation; only POP3 accounts can supply local state. Deprecated account identity calls have been removed in favor of `accounts.get(...).identities[0]`.

Copy **the full text** of `PRIVACY.en.md` / `PRIVACY.ja.md` into ATN's privacy policy field, not just a link. These documents match the offline policy shown in the extension. Detailed data disclosure is also in the listing drafts. Debug console logging is off. Dropbox response bodies, tokens, and authorization codes are not echoed into user-visible errors.

## Build and source

Node.js 22+ and PowerShell 7+ are required. No npm install is needed. From the source archive root:

```powershell
npm run build
```

The build runs syntax/localization/manifest/package checks and `node --test background.test.js`, then writes the XPI, source ZIP and SHA-256 sums to `dist/`. `release-files.json` is the explicit runtime allowlist. Runtime files are human-readable and identical to the corresponding source files. No minification, transpilation, generated executable code, or third-party runtime libraries are used. The SVG icon is original local source. ZIP entry timestamps and order are fixed; repeated builds on the same PowerShell/.NET runtime are byte-identical.

## Functional test instructions

Use **disposable Thunderbird profiles and test mail**, not a personal mailbox.

1. Install the XPI on supported Thunderbird. Verify that setup opens, consent is unchecked, optional features are off, and no messages or Dropbox data are touched before consent/account selection.
2. Create a disposable Dropbox account/app (Scoped access, App folder) with `files.metadata.read`, `files.content.read`, `files.content.write`. A reviewer may use their own test account; there is no proprietary test access. If reviewer credentials are requested by ATN, the publisher must arrange disposable credentials privately through reviewer notes, never in the public listing or XPI.
3. Configure two test POP3 accounts/profiles with the same account email identity and a few identical Message-IDs. Ensure one local folder has a Japanese display name and another is nested under Inbox.
4. Accept the disclosure, select the test POP3 account and enable sync. Enter the same App key on both profiles, open authorization, allow access and paste the displayed code. No redirect URI or client secret is used. Authorization uses PKCE S256 and offline access with refresh tokens.
5. Scan/upload the source, then fetch/apply the destination. Change read state, move a message, and move a group of messages. Verify both changes propagate, including to a newly created folder. Folder moves must remain correct after restarting Thunderbird.
6. Deny optional download/delete permissions and verify core sync still works. When enabling cleanup, test only a disposable custom folder known empty on both sides; standard/nonempty folders must remain.
7. Disable sync or remove consent and save. Verify no subsequent sync occurs. Consent withdrawal/disconnect must remove local tokens. Clear local data must leave mail and remote Dropbox files intact.
8. Verify no duplicate upload/change loop, that expired access tokens refresh, and that interrupted/failed moves retry without falsely acknowledging a revision.

**Evidence boundary:** repository regression tests emulate Thunderbird/Dropbox APIs. They do not prove live OAuth connectivity, installation on every supported release, or ATN approval. The publisher must record the live profile test results before submission.

## Policy references checked on 2026-09-18

- [Thunderbird add-on review policy](https://thunderbird.github.io/atn-review-policy/): disclosure, consent, minimum permissions, reviewable source, and functional review.
- [Thunderbird reviewer guide](https://addons-reviewer-guide.thunderbird.net/add-on-review-guide): privacy policy and `sensitiveDataUpload` for hardcoded services; listing and reviewer access.
- [Thunderbird 128 migration](https://developer.thunderbird.net/add-ons/updating/tb128): MV3 support starts with 128.
- [Thunderbird webext-linter](https://github.com/thunderbird/webext-linter): static API/manifest/review checks; this run uses commit `f559b59c3a3e171b5fa760e012745e830156cb8b` (2.0.0).
- [Dropbox OAuth guide](https://docs.dropboxapi.com/dropbox-api/docs/oauth): App folder access, PKCE, and refresh tokens for desktop background access.
