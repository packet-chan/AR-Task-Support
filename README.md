# AR作業支援システム

参加者ごとに機器と説明書PDFを登録し、選択した型番の手順・図・初版3Dモデルを作成します。

配信PCで初回に `npm ci --prefix web` を実行します。生成にはログイン済みのCodex CLIとPopplerを使います。Python 3.11以降で `python serve.py` を実行し、[ユーザー選択](http://127.0.0.1:52393/)を開きます。

[実装状況と仕様書](仕様書/README.md)
