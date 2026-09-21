# ALIFO AI Article Editor

URL / RSS → Web情報取得 → 自動記事編集 → 審査待ちボックス

## OpenAI APIについて

この版は **OpenAI APIを使用しません**。
取得したWeb本文を、重複除去・段落整理・要約・見出し化して記事ドラフトにします。

そのため `OPENAI_API_KEY` と `OPENAI_MODEL` は不要です。

## Render

- Build Command: `npm install`
- Start Command: `npm start`

必要な環境変数:

- `CRON_SECRET`（任意。GitHub Actionsなど外部から定期巡回する場合は設定推奨）

## 注意

取得した本文・画像の利用権限は、元サイトの利用規約・著作権・ライセンスを確認してください。
画像は元ページのURLを表示する方式です。
