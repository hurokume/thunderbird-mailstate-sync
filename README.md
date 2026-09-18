# MailState Sync

MailState Sync synchronizes read/unread state and folder moves between **existing copies of POP3 mail** on your own PCs, using your Dropbox account. It does not transfer message bodies or attachments. Thunderbird **128 or later** is required. Runtime code has no third-party dependencies or Experiment APIs.

## Setup

1. Install the XPI through Thunderbird → Add-ons and Themes → gear menu → Install Add-on From File. Open the add-on's settings.
2. Review the data disclosure and privacy policy. Check consent, select the POP3 accounts, and enable synchronization. Empty account selection never means all accounts.
3. Create your own app in [Dropbox App Console](https://www.dropbox.com/developers/apps): Scoped access, **App folder**. Enable `files.metadata.read`, `files.content.read`, and `files.content.write`, and submit the permission changes.
4. Paste the **App key**, not the App secret, into settings. Use the same app and Dropbox account on every PC. Open authorization, grant Dropbox access, copy the authorization code, and connect. This out-of-band PKCE flow does not use a redirect URI. Access tokens renew using the stored refresh token.
5. On the PC with the correct mail layout, select **Scan local mail and upload**. On the other PC, select **Fetch and apply Dropbox state**.

New installations and upgrades without recorded consent remain inactive. The existing add-on ID is preserved so upgrades retain settings and history. Existing short-lived authorizations can be reconnected to enable refresh tokens and the corrected Dropbox scopes.

## Behavior and limits

- Accounts are matched by their primary email identity; messages are matched by Message-ID. Use the same account email address on each PC. Copies without a Message-ID cannot be synchronized; duplicated Message-IDs may affect multiple copies in the account.
- Supports moves **within the same POP3 account**. Cross-account moves, Local Folders, IMAP, and synchronizing deletions, tags, or stars are outside its scope.
- Folder prefixes apply to collection and application. Include both the source and destination, or leave the list empty for all folders in selected accounts. Thunderbird API paths may differ from display names.
- Read wins concurrent read/unread changes; causally later actions retain their intent. Folder conflicts use history and then timestamps. Keep device clocks accurate.
- Automatic Dropbox checks run approximately once a minute while Thunderbird is running. Pending uploads retry every five minutes. Thunderbird event-page suspension does not lose the persisted pending flag; alarms provide the fallback to the short debounce timer.
- Optional JSON exports and deletion of empty custom folders default to **off** and request their permissions only when enabled. Standard folders and folders with messages or children are protected.
- This is metadata synchronization, not a mail backup. Dropbox stores readable JSON; there is no extra end-to-end encryption. An App folder app stores `thunderbird_backup/state.json` under `Apps/<your app>`. Existing Full Dropbox apps use their existing accessible root; changing app type does not migrate old files automatically.

## Privacy and controls

Only the selected account email addresses, Message-ID headers, read state, folder names/paths/counts, change history, and a random client identifier are uploaded. No message bodies, subjects, attachments, address books, mail passwords, analytics, or developer telemetry are uploaded. Read the full [English policy](docs/PRIVACY.en.md) or [日本語ポリシー](docs/PRIVACY.ja.md), also available offline in settings.

Disable sync and save to stop synchronization. Uncheck consent and save to also remove locally stored authorization. Disconnect removes local tokens; authorization can additionally be revoked on Dropbox's Connected apps page. Clear local data removes the add-on's settings, tokens and cache, without deleting mail. Dropbox files, exported mirrors and backups remain until you delete them. Stop sync on all PCs before deleting all copies.

## Development and packaging

Requires Node.js 22+ and PowerShell 7+. There are no npm dependencies to install.

```powershell
npm test
npm run check
npm run build
```

`build-xpi.ps1` runs release checks and regression tests, creates a deterministic XPI and source ZIP from explicit allowlists, verifies the XPI content against the source, and writes SHA-256 sums. The same sources and PowerShell/.NET runtime yield identical archive bytes. Tests, developer tools, caches, credentials, and submission notes are excluded from the XPI. Human-readable runtime source is included without bundling or minification.

- `settings.js`: shared configuration, defaults and account eligibility.
- `dropbox-client.js`: HTTPS transport, PKCE, refresh tokens and disconnect.
- `background.js`: state resolution, mail events, apply/scan pipelines and alarms.
- `options.js`, `i18n.js`, `_locales/`: accessible setup and English/Japanese UI.

See [reviewer notes](docs/REVIEWER-NOTES.md) and the [release checklist](docs/RELEASE-CHECKLIST.md) for ATN submission. A passing local check is not an ATN approval. Real Thunderbird/Dropbox testing is documented separately from API-mock tests.

## 日本語の導入要点

設定画面は日本語に対応しています。すべてのPCで同じDropboxアプリとアカウントを設定し、データ送信に同意して対象POP3アカウントを選択してください。初回は正しい配置のPCで「ローカル総スキャン→アップロード」、別PCで「クラウド取得→反映」の順に実行します。0.9.0への更新後も、同意を保存するまで同期は開始しません。

## License

Mozilla Public License 2.0. See [LICENSE](LICENSE).
