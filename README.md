# ALIFO AI Article Editor

URL / RSS → Web情報取得 → AI記事生成 → 審査待ちボックス

## Render
- Build Command: `npm install`
- Start Command: `npm start`
- Environment Variables:
  - `OPENAI_API_KEY`
  - `OPENAI_MODEL` (optional)
  - `CRON_SECRET`

## GitHub Actions
Repository Secrets に以下を登録:
- `ALIFO_ARTICLE_EDITOR_URL` = RenderのサービスURL
- `ALIFO_CRON_SECRET` = Render側のCRON_SECRETと同じ値

1時間ごとにRSS巡回します。

## 注意
取得した本文・画像の利用権限は、元サイトの利用規約・著作権・ライセンスを確認してください。
このMVPは画像を元ページのURLから表示します。画像を自サーバーへ無断転載する仕様にはしていません。
