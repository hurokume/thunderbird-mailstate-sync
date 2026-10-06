# MailState Sync

Sync the read/unread state and folder location of POP3 mail across your PCs through Dropbox. Each PC must already have a copy of the mail; the add-on does not copy message bodies or attachments.

Requires Thunderbird 128 or later, a Dropbox account, and a Dropbox API app you create yourself. [日本語の設定手順](#日本語の設定手順) · [Privacy policy](docs/PRIVACY.en.md)

## Setup

1. In Thunderbird, open **Add-ons and Themes**, then use the gear menu to install the XPI from a file. Open MailState Sync settings.
2. Select the POP3 accounts to sync and check **Enable synchronization**. Read **Data sharing** and check the consent box.
3. In [Dropbox App Console](https://www.dropbox.com/developers/apps), create an app with **Scoped access** and **App folder** access. Under Permissions, enable `files.metadata.read`, `files.content.read`, and `files.content.write`, then select Submit.
4. Paste the app's **App key** into the add-on settings and select **Save and authorize**. Allow access on Dropbox, paste the code it provides into **Authorization code**, and select **Connect**. App secret and Redirect URIs are not needed.
5. Repeat on each PC, using the same Dropbox app, Dropbox account, and POP3 email address.
6. On the PC with the mail layout you want to use, open **First sync or rescan** and select **Scan this PC and upload**. On the other PCs, select **Apply Dropbox changes**.

Sync stays off until you give consent and select an account. After updating to 0.9.0, review and save consent again. If an older Dropbox connection has expired, reconnect in settings.

## Daily use

While Thunderbird is running, the add-on sends changes as you read or move mail. With automatic application enabled, it checks Dropbox about once a minute. Failed uploads retry every five minutes.

The manual actions save your current settings before running:

| Action | Use |
| --- | --- |
| Apply Dropbox changes | Fetch the shared state and apply it to mail on this PC. |
| Send saved changes | Send changes the add-on has already recorded. |
| Scan this PC and upload | Read the current state of all selected mail and upload it. Use for the first sync or changes made while sync was off. |

To stop syncing, uncheck **Enable synchronization** and save.

## What is synchronized

- Read/unread state and moves within the same POP3 account. Missing destination folders are created.
- Accounts match by their primary email address; messages match by Message-ID. Mail without a Message-ID cannot sync. Duplicate Message-IDs can affect more than one copy.
- Folder filters apply to both collection and application. Include the source and destination paths, or leave the field blank for all folders in the selected accounts. API paths can differ from displayed folder names.

IMAP, Local Folders, moves between accounts, and changes to deletions, tags, or stars are not supported.

If two PCs change read/unread state concurrently, read takes precedence. A change made after receiving the other PC's update keeps its intent. Folder moves are resolved by history, then timestamps, so keep PC clocks accurate.

JSON exports and empty-folder deletion are off by default. Enabling them requests additional permissions. Folder deletion requires the source and destination to report the folder empty; standard folders and folders with children are kept.

## Stored data

Dropbox receives account email addresses, Message-IDs, read/unread state, folder names, paths and counts, change history, and a random device identifier. It receives no message bodies, subjects, attachments, address books, or mail passwords. No usage data is sent to the developer.

With App folder access, the file is `Apps/<your app>/thunderbird_backup/state.json`. It is readable JSON without additional end-to-end encryption and cannot restore lost mail. Existing Full Dropbox apps keep using their accessible root; changing the app type does not move old files.

Disconnecting removes this PC's credentials. To also revoke access at Dropbox, remove the app from **Connected apps** in Dropbox settings. Clearing local data removes the add-on's settings, credentials, and cache; mail remains. Dropbox files and exported JSON remain until you delete them. Stop sync on every PC before deleting all copies.

Full policies: [English](docs/PRIVACY.en.md) · [日本語](docs/PRIVACY.ja.md). They are also available offline from settings.

## 日本語の設定手順

複数のPCにあるPOP3メールの既読・未読と移動先フォルダーを、Dropbox経由で同期します。各PCで同じメールを受信しておく必要があります。本文や添付ファイルはコピーしません。

1. Thunderbirdの「アドオンとテーマ」を開き、歯車メニューの「ファイルからアドオンをインストール」でXPIを選びます。
2. MailState Syncの設定を開き、対象のPOP3アカウントを選んで「同期を有効にする」にチェックを入れます。「データの送信」を確認し、同意にチェックを入れます。
3. [Dropbox App Console](https://www.dropbox.com/developers/apps)で、Scoped access、App folderを選んでアプリを作成します。Permissionsで `files.metadata.read`、`files.content.read`、`files.content.write` を有効にし、Submitで保存します。
4. App keyを設定画面に貼り付け、「保存してDropboxで認証」を押します。Dropboxで許可した後、表示されたコードを「認証コード」欄に貼り付けて「接続」を押します。
5. 他のPCでも同じDropboxアプリ・Dropboxアカウントを使って接続します。POP3アカウントも同じメールアドレスで設定します。
6. 基準にしたい既読状態・フォルダー配置のPCで「初回の同期・メールの再確認」を開き、「このPCのメールを確認して送信」を押します。その後、他のPCで「Dropboxの変更を反映」を実行します。

以後はThunderbirdの起動中に同期します。同期を止めるには「同期を有効にする」のチェックを外して保存してください。0.9.0への更新後も、同意を保存するまで同期は始まりません。

同じPOP3アカウント内の移動に対応します。メールの削除・タグ・スター、IMAP、別アカウントや「ローカルフォルダー」への移動は同期しません。詳しくは[日本語の説明](docs/ATN-LISTING.ja.md)と[プライバシーポリシー](docs/PRIVACY.ja.md)を参照してください。

## Development

Node.js 22+ and PowerShell 7+ are required. There are no npm dependencies to install.

```powershell
npm test
npm run check
npm run build
```

The build runs regression tests and release checks, creates an XPI and source ZIP in `dist/`, verifies the packaged files against the source, and writes SHA-256 sums. Archives are reproducible with the same sources and PowerShell/.NET runtime. The XPI contains unminified runtime source, with no third-party code or Experiment APIs.

Every push to `main` runs the same build in GitHub Actions. Open the **Build XPI** run under **Actions** and download `mailstate-sync-<commit SHA>` from **Artifacts** to get the XPI, source ZIP, and SHA-256 sums. Artifacts are retained for 30 days.

`main`へのpush時にもGitHub Actionsで同じビルドを実行します。**Actions**の**Build XPI**実行結果を開き、**Artifacts**の`mailstate-sync-<commit SHA>`からXPI・ソースZIP・SHA-256チェックサムをダウンロードできます。保存期間は30日です。

- `settings.js`: defaults and account selection.
- `dropbox-client.js`: Dropbox requests, PKCE authorization, and token renewal.
- `background.js`: mail events, conflict resolution, scans, and sync alarms.
- `options.js`, `i18n.js`, `_locales/`: settings and translations.

For ATN submission, see the [reviewer notes](docs/REVIEWER-NOTES.md) and [release checklist](docs/RELEASE-CHECKLIST.md). Automated tests use API mocks; real Thunderbird/Dropbox checks are recorded separately.

## License

[Mozilla Public License 2.0](LICENSE).
