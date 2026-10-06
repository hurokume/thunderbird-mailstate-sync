# MailState Sync

## Summary

Sync POP3 read/unread state and folder moves through Dropbox. Requires a Dropbox App key.

## Description

Use MailState Sync when you receive the same POP3 mail on more than one PC. Read a message on one PC and it becomes read on the other. Move it to another folder in the same account and that move is synchronized too. Missing destination folders are created.

Each PC must already have a copy of the mail. The add-on does not copy message bodies or attachments, or sync deletions, tags, or stars. IMAP, moves between accounts, and Local Folders are not supported.

### Setup

Requires Thunderbird 128 or later and a Dropbox account.

1. Create a Dropbox API app with Scoped access and App folder access. Under Permissions, enable files.metadata.read, files.content.read, and files.content.write, then select Submit.
2. In the add-on settings, select your POP3 accounts and enable synchronization. Read Data sharing and check the consent box.
3. Paste the App key, select Save and authorize, and connect using the code Dropbox provides.
4. Use the same Dropbox app and Dropbox account on each PC. The POP3 accounts must also use the same email address.
5. On the PC with the mail layout you want to use, select Scan this PC and upload. On the other PCs, select Apply Dropbox changes.

No developer-issued key or membership is required.

### Sync behavior

While Thunderbird is running, the add-on sends changes as you make them. With automatic application enabled, it checks Dropbox about once a minute. Messages are matched by Message-ID. Messages without one cannot sync; duplicate IDs can affect multiple copies.

Read takes precedence when PCs change read/unread state concurrently. Folder conflicts use change history and timestamps, so keep PC clocks accurate.

JSON export to Downloads and empty-folder deletion are available under Advanced. Both are off by default and request additional permissions when enabled. Folder deletion requires both source and destination to report the folder empty. Standard folders and folders with children are kept.

### Stored data

Dropbox receives selected account email addresses, Message-IDs, read/unread state, folder names, paths and message counts, change history, and a device identifier. Folder names and identifiers may contain personal information. Transfers use HTTPS. Sync data and credentials are also stored in the Thunderbird profile.

Message bodies, subjects, attachments, address books, and mail passwords are not uploaded. No usage data is sent to the developer. The full privacy policy is available on this listing and in settings.

The Dropbox sync file is readable JSON without additional end-to-end encryption. It cannot restore lost message bodies.

### Stopping sync

Uncheck Enable synchronization and save. Uncheck consent as well to delete this PC's credentials. Settings also provides controls to disconnect or delete settings and local sync data.

Dropbox files and exported JSON remain. To remove them, stop sync on every PC and delete them manually. To revoke access at Dropbox, remove the app from Connected apps in Dropbox settings.

Dropbox's service terms and storage limits apply. The add-on has no payment, advertising, or affiliate features and is not an official Dropbox or Thunderbird product.

## Version 0.9.0

Adds English and Japanese settings, data-sharing consent, account selection, and local data removal. Dropbox authorization renews automatically. JSON export and empty-folder deletion are now off by default. The mail-move fixes from 0.8.1 are included.

After updating, accept data sharing and save settings to resume sync.
