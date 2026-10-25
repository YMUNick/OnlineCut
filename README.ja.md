<div align="center">

<img src="assets/img/favicon.svg" width="64" height="64" alt="OnlineCut logo">

# OnlineCut

**ブラウザを開くだけで動画編集。無料・インストール不要・登録不要。ファイルはあなたのパソコンから一切出ません。**

[English](README.md) · [繁體中文](README.zh-TW.md) · **日本語**

<a href="https://ymunick.github.io/OnlineCut/editor.html?lang=en"><img src="https://img.shields.io/badge/%E2%96%B6%20%20%E3%82%A8%E3%83%87%E3%82%A3%E3%82%BF%E3%82%92%E9%96%8B%E3%81%8F-%E7%84%A1%E6%96%99%E3%83%BB%E7%99%BB%E9%8C%B2%E4%B8%8D%E8%A6%81-ff5c39?style=for-the-badge" alt="エディタを開く" height="40"></a>

[![Tests](https://img.shields.io/github/actions/workflow/status/YMUNick/OnlineCut/test.yml?branch=main&label=tests&style=flat-square)](https://github.com/YMUNick/OnlineCut/actions/workflows/test.yml)
[![Live site](https://img.shields.io/github/actions/workflow/status/YMUNick/OnlineCut/live-check.yml?label=live%20site&style=flat-square)](https://github.com/YMUNick/OnlineCut/actions/workflows/live-check.yml)
[![License: MIT](https://img.shields.io/github/license/YMUNick/OnlineCut?style=flat-square&color=blue)](LICENSE)
[![アップロード：なし](https://img.shields.io/badge/%E3%82%A2%E3%83%83%E3%83%97%E3%83%AD%E3%83%BC%E3%83%89-%E3%81%AA%E3%81%97-2ea44f?style=flat-square)](#-プライバシー)
[![GitHub stars](https://img.shields.io/github/stars/YMUNick/OnlineCut?style=flat-square)](https://github.com/YMUNick/OnlineCut/stargazers)

<a href="https://ymunick.github.io/OnlineCut/editor.html?lang=en"><img src="assets/img/demo-en.gif" width="880" alt="OnlineCut でステッカー、円形ワイプ、左右分割をワンクリックで追加している様子"></a>

<sub>※ 画面の表示言語は英語と繁体字中国語に対応しています（日本語 UI は今後対応予定）。</sub>

</div>

## なぜ OnlineCut？

多くのオンライン動画編集ツールは、**何 GB もの素材をアップロード**させ、**アカウント登録**を求め、書き出した動画に**ウォーターマーク**を入れます。OnlineCut にはそのどれもありません。

- **アップロード待ちゼロ**：10 GB のファイルも読み込んだ瞬間から編集できます。デコード・編集・エンコードはすべてあなたの端末上で行われます。
- **登録なし・ウォーターマークなし・課金なし**：ページを開けばすぐ使えます。サーバー費用がかからないので、ずっと無料です。
- **インストール不要**：ただの静的 Web ページです。PC 版の Chrome・Edge・Safari で動きます。
- **作業が消えない**：プロジェクトはブラウザに自動保存。`.onlinecut` ファイルとしてダウンロードすれば、バックアップや別のパソコンでの続きもできます。

## ✨ 主な機能

| | |
|---|---|
| 🎬 **マルチトラック・タイムライン** | 動画・画像・テキスト・音楽をそれぞれのトラックに。ドラッグ、トリム、分割（`S`）、リップル削除、スナップ、端までドラッグすると自動スクロール。 |
| 🪟 **ワイプ・画面分割** | ワンクリックでレイアウト適用：四隅のワイプ（ピクチャ・イン・ピクチャ）、円形ワイプ、左右分割、上下分割、3 分割、4 分割。形・枠線・影の調整や、枠内のトリミング位置の調整も可能。 |
| 🎨 **内蔵グラフィック** | 文字を自由に書き換えられるテキストステッカー 23 種（爆発バッジ、吹き出し、考え中の雲、ネオンサイン、ハンコ、マスキングテープ、名前テロップ、LIVE など）、背景 18 種、ステッカー 24 種、フレーム 13 種（ポラロイド、漫画の集中線、ライブ配信風、雪、ハートなど）。すべてベクターなので拡大しても鮮明。 |
| 🔤 **テロップ・字幕** | **プレビュー上の文字をダブルクリックするとその場で書き換え**、フォント・サイズ・太さ・色も変更できます。ワンクリックのテキストスタイル 15 種（ネオン、バラエティ番組風、手書き、映画字幕、タイプライターなど）、フォント 11 種、縁取り、影、発光、17 種類の装飾シェイプ。 |
| ⬛ **単色画面とカウントダウン** | 黒・白・好きな色の画面を再生ヘッドの位置にワンクリックで挿入（後ろのクリップは自動で後ろへ）。テキスト内の数字を 2152 → 2132 のようにだんだんゆっくりカウントさせることもできます。 |
| 🎛️ **フィルター・速度・フェード** | 明るさ、コントラスト、彩度、モノクロ、ぼかしとプリセット。0.25×〜4× の速度変更、音量は最大 200%。フェードはタイムライン上でドラッグするだけ。動画の音声だけを別にフェードアウトすることもできます。 |
| 📐 **あらゆるアスペクト比** | 16:9、9:16（Reels / Shorts / TikTok）、1:1、4:5。縦長の動画を読み込むと自動で切り替わります。 |
| 📦 **フレーム単位で正確な MP4 書き出し** | H.264 + AAC、最大 1080p 60fps。WebCodecs で 1 フレームずつレンダリングし、通常は実時間より速く書き出せます。 |
| 🐘 **大きなファイルも OK** | 大きなファイルはブラウザにコピーせず、音声はストリーミングでデコード。メモリ使用量はファイルサイズに依存しません。 |

## 🚀 今すぐ試す

**👉 [ymunick.github.io/OnlineCut](https://ymunick.github.io/OnlineCut/?lang=en)**

素材がなくても大丈夫。「Load sample project」を押せば数秒で試せます。

## 🛠 自分で動かす

ビルド不要です。どんな静的ファイルサーバーでも動きます。

```bash
git clone https://github.com/YMUNick/OnlineCut && cd OnlineCut && npx serve
```

```bash
python3 -m http.server 8080                                          # Python
docker run --rm -p 8080:80 -v "$PWD":/usr/share/nginx/html:ro nginx:alpine   # Docker
```

**自分のコピーを無料で公開**：このリポジトリを Fork し、**Settings → Pages → Deploy from a branch → `main` / root** を選ぶと、`https://<ユーザー名>.github.io/OnlineCut/` で公開されます。

## 🔒 プライバシー

OnlineCut は**バックエンドを持たない**純粋な静的サイトです。読み込んだファイル、編集、書き出しはすべてブラウザ内で処理され、どこにもアップロードされません。プロジェクトはあなたのブラウザの IndexedDB にだけ保存されます。

外部への通信は、UI とテキストスタイル用の Google Fonts の読み込みのみです。

## 🧪 テスト

```bash
npm test                 # 180 以上のユニットテスト（依存パッケージ不要）
npm run test:e2e         # 75 以上の E2E テスト（ffmpeg と Playwright / Chromium が必要）
```

ユニットテストには、数千回のランダム編集と破損した保存データを使うファズテストが含まれます。E2E テストでは実際のブラウザで読み込み・編集・書き出しを行い、出力された MP4 を ffprobe で検証します（画面分割は領域ごとの色まで確認）。

## 🤝 コントリビュート

Issue や PR を歓迎します！フレームワークもバンドラーも使わない、素の ES Modules です。**日本語 UI の翻訳**も大歓迎です。`assets/js/i18n-en.js` をコピーして翻訳し、`i18n.js` に登録してください。`tests/unit/i18n.test.js` のチェックを新しい辞書に向ければ、未翻訳の文字列がすべて一覧表示されます。

## 📄 ライセンス

[MIT](LICENSE)。`assets/vendor/mediabunny.min.mjs` は [mediabunny](https://github.com/Vanilagy/mediabunny) 1.61.3（Mozilla Public License 2.0、無改変）です。

<div align="center">

**OnlineCut でアップロードやウォーターマークの手間が省けたら、⭐ で応援してください。**

</div>
