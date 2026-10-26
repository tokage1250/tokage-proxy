# Tokage Proxy（初心者向けセットアップ）

## 何が必要？
- GitHub アカウント
- Render アカウント（GitHub 連携）
- このフォルダにある5つのファイル

> このアプリはNode.jsサーバーを使うため、GitHub Pagesだけでは動きません。Renderの「Web Service」にデプロイし、Renderが発行する `onrender.com` のURLを利用します。既存サイトを壊さないため、最初は別のGitHubリポジトリを作るのがおすすめです。

## 1. GitHubにリポジトリを作る
1. GitHubにログインし、右上の `+` → `New repository` を選びます。
2. Repository name に `tokage-proxy` と入力します。
3. `Private` を選んでも大丈夫です（RenderにGitHubアクセスを許可してください）。
4. `Create repository` を押します。

## 2. ファイルをアップロードする
1. ZIPをWindowsで右クリックして `すべて展開` を押します。
2. 展開した `tokage-proxy` フォルダを開きます。
3. `index.html`、`script.js`、`style.css`、`server.js`、`package.json`、`README.md` をGitHubのリポジトリにアップロードします。フォルダごとではなく、ファイルそのものを選んでください。
4. GitHubの `Add file` → `Upload files` でファイルを選び、`Commit changes` を押します。

## 3. Renderで公開する
1. https://render.com/ を開き、GitHubでサインインします。
2. `New` → `Web Service` を選びます。
3. GitHub連携を求められたら許可し、`tokage-proxy` リポジトリを選びます。
4. 設定を次のようにします。
   - Name: `tokage-proxy`（使えない場合は末尾に数字を追加）
   - Language / Runtime: `Node`
   - Branch: `main`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: Free（表示される場合）
5. `Create Web Service` を押して、デプロイが完了するまで待ちます。
6. `Live` になったら、画面上部に表示された `https://...onrender.com` のURLを開きます。

## 4. 動作確認
トップ画面で `https://example.com` を入力して `開く` を押します。RenderのURLがサイトの公開URLです。GitHub PagesのURLではNode.jsのプロキシ処理は動きません。

## 5. あとから更新する
ファイルを変更したらGitHubにコミットします。Renderの自動デプロイが有効なら、GitHubへの変更がRenderにも反映されます。

## 制限・注意
- 一部のサイトはログイン、動画、JavaScript、サイト側の制限、リダイレクト方式などにより正常に動きません。
- ページの表示にはアクセス先のサイトの規約が適用されます。アクセス権のないページや認証を回避する用途には使用しないでください。
- Renderの無料Web Serviceは、一定時間アクセスがないと休止状態になり、次回アクセス時に起動待ちが発生する場合があります。
