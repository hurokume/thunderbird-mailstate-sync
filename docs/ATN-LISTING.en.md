# MailState Sync

## Summary

Sync POP3 read state and folder moves via your Dropbox account. Requires your own Dropbox App key.

## Description

Keep existing copies of POP3 mail organized across your own computers. MailState Sync synchronizes read/unread state and moves within the same account through a JSON state file in your Dropbox account. It can create missing destination folders.

Open MailState Sync settings in Thunderbird's Add-ons Manager. Review the privacy information, accept data sharing, select your POP3 accounts, and enable sync. Create a Dropbox API app with App folder access and the three permissions listed in settings, then connect using its App key and the authorization code from Dropbox. Use the same Dropbox app/account on every PC. Start with a local scan on the PC with the correct layout, then fetch and apply on the other PC. Full setup instructions are included in the settings page. A Dropbox account and a user-created Dropbox API app are required; no developer-issued access key or private membership is required.

The add-on sends selected account email addresses, Message-ID headers, read state, folder paths and names, folder message counts, change history, and a random client identifier to Dropbox over HTTPS. These values may contain personal information. Metadata and authorization tokens are stored in your Thunderbird profile. Message bodies, subjects, attachments, address books, and mail passwords are not uploaded. The developer receives no telemetry. See the full privacy policy on this listing and in settings.

Read wins simultaneous read/unread conflicts; moves use change history and timestamps. Keep PC clocks accurate. Optional readable JSON exports in Downloads and deletion of empty custom folders are disabled by default and request additional permissions when enabled. Folder deletion requires both sides to report the folder empty; standard folders and folders with children are protected.

Supports Thunderbird 128+ and matching POP3 accounts with the same email identity. Does not copy mail between PCs, synchronize deletions/tags/stars, or handle IMAP, cross-account moves, or Local Folders. Messages need matching Message-ID headers. Thunderbird must be running for background synchronization. Dropbox storage is readable JSON without extra end-to-end encryption. This is not a mail backup.

Disable sync, revoke consent, disconnect, or clear local data in settings. Existing Dropbox files and exported mirrors remain until removed manually. Disconnecting locally does not revoke the grant on Dropbox; use Dropbox's Connected apps page to do that. Dropbox's own service terms and storage limits apply. The add-on itself has no payment, advertising, or affiliate features and is not affiliated with Dropbox or Thunderbird.

## Version 0.9.0 notes

Publication preparation: explicit opt-in, strict account selection, optional permissions, bilingual setup, privacy controls, renewable Dropbox authorization, and reproducible packaging. Existing installations must accept the disclosure again before synchronization resumes. The folder move fixes from 0.8.1 are retained.
