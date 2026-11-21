# AR作業支援システム

機器の説明書PDFから型番別の手順・図・3Dモデルを作る。Quest 3で対象部品を撮影し、配信PCで実物とモデルを比較して手順を改訂できる。

## 配信PCで起動する

WindowsにPython 3.11以降、Node.jsとnpmを用意する。説明書の生成にはPopplerとログイン済みのCodex CLI、Wi-Fi配信にはOpenSSLまたはGit for Windowsも必要。

```powershell
python -m pip install -r requirements.txt
npm ci --prefix web
./tools/Open-QuestCapture.ps1
```

[配信PCの管理画面](http://127.0.0.1:52393/)を開き、個人端末またはDEMOのQRを発行する。PCだけで使うときは最後のコマンドを `python serve.py` に替える。

## 仕様と開発

- [実装状況・成果物・検証した機種](docs/README.md)
- [端末登録と会場デモ](docs/access.md) ／ [Questで最初の写真を撮る](docs/capture.md)
- [撮影を基にS2を改訂](docs/s4.md) ／ [実機との位置合わせ](docs/s4-alignment.md)

配信の入口は `serve.py`、生成処理は `production.py`。サーバーの補助処理は `server/`、ブラウザ画面は `web/`、生成指示は `generation/`、運用コマンドは `tools/`、検証コードは `tests/` にある。PDF・撮影・端末登録など配信PC固有のデータは `.local/` に保存する。

```powershell
python -m unittest discover
node tests/check-alignment-fit.mjs
```
