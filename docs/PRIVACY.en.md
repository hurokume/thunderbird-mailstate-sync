# MailState Sync privacy policy

Effective date: 18 September 2026. Applies to MailState Sync 0.9.0.

## Purpose and consent

MailState Sync synchronizes existing POP3 mail across your own PCs. Collection and synchronization remain off until you accept the data disclosure, select accounts, and enable synchronization. Existing installations must also provide this consent after updating to 0.9.0.

## Data used

The add-on reads account identities and folder lists to show the account selector. For selected POP3 accounts it processes account email addresses, Message-ID headers, read/unread values, folder paths and display-name hierarchies, folder message counts and empty status, change timestamps and causal history, and a random per-installation client identifier.

Thunderbird’s message-list API also supplies header details in memory; only the listed synchronization fields are persisted or transmitted. No message bodies, subjects, sender/recipient lists, attachments, address books, or mail passwords are stored in synchronization files or uploaded.

## Recipients and network access

Metadata goes directly from Thunderbird to your Dropbox account using HTTPS at api.dropboxapi.com and content.dropboxapi.com. notify.dropboxapi.com receives a change cursor to check for updates. Dropbox sees normal connection data such as your IP address and request timing.

OAuth authorization opens www.dropbox.com in your system browser; Dropbox controls its sign-in page and cookies. The add-on does not install cookies, use analytics or advertising, or send data to the add-on developer. The developer does not operate a synchronization server.

Dropbox handles received data under its own privacy policy. No app-level end-to-end encryption is applied.

## Storage and retention

Settings, consent, synchronization metadata, cursors, your App key, and access/refresh tokens are stored in the Thunderbird profile using storage.local until you clear them or remove the add-on. Treat profile backups as sensitive; this storage is not an encrypted credential vault.

Temporary PKCE verifiers are removed after connection or disconnection and expire for use after 15 minutes.

Dropbox keeps thunderbird_backup/state.json within the app’s accessible folder (Apps/<your app> for an App folder app). Dropbox retention and version-history settings apply.

If enabled, a readable metadata mirror is also written under Downloads. Tokens are never included in cloud or mirror files. Diagnostic console logging is disabled by default.

## Your controls

Uncheck Enable synchronization and save to stop collection and sync. Uncheck consent and save to also delete this PC’s credentials.

Disconnect this device deletes local credentials. To revoke access at Dropbox, remove the app from Connected apps in Dropbox settings. Delete settings and local sync data removes settings, credentials, and cached metadata. Mail is kept.

Deselecting an account stops new collection for it. Data already in Dropbox remains and may be retained when the shared file is updated so other PCs can continue using it.

To remove all saved copies, stop synchronization on every PC and delete settings and local sync data on each one. Then manually delete the Dropbox file and any history available for deletion, exported JSON files, and backups.

## Changes and contact

Material changes to data handling will be disclosed in the add-on and publication notes, with renewed consent where needed. Use the support contact shown on the MailState Sync listing on addons.thunderbird.net. Do not include mail metadata, tokens, or authorization codes in public reviews.
