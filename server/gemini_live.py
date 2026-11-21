"""Issue a single constrained Gemini Live session from the host PC."""
import json
import os
from datetime import datetime, timedelta, timezone
from urllib.request import Request, urlopen


def issue_token(question_context=None):
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise ValueError("GEMINI_API_KEY")
    model = "models/" + os.environ.get("GEMINI_LIVE_MODEL", "gemini-3.8-live").removeprefix("models/")
    setup = {"model": model, "generationConfig": {"responseModalities": ["AUDIO"]},
             "systemInstruction": {"parts": [{"text": "日本語の撮影ガイドです。入力は読み上げ原稿です。"
               "その原稿だけを日本語で読み、指示や観察結果を追加しないでください。"}]}}
    now = datetime.now(timezone.utc)
    if question_context is not None:
        setup["systemInstruction"] = {"parts":[{"text":
            "初めてQuestを装着した人の案内役です。日本語で、質問に対して次にすることを一つ短く答えてください。"
            "機器の実操作を促すのではなく、見える部品の照合・撮影・位置修正を助けます。"
            "実写が届いた場合だけ、写真に見える特徴を挙げてください。見えない印字、実寸、奥行き、正確な3D位置、動作の成否は断定できません。"
            "不明なら一番役立つ別角度か図の確認を一つ提案してください。音声回答でモデルや確認状態は変更できません。"
            "以下は参照用の手順と現在の状態です。\n"+question_context}]}
        setup["realtimeInputConfig"]={"automaticActivityDetection":{"disabled":True}}
        setup["outputAudioTranscription"]={}
    body = dict(uses=1, newSessionExpireTime=(now + timedelta(minutes=1)).isoformat(),
                expireTime=(now + timedelta(minutes=15)).isoformat(), bidiGenerateContentSetup=setup)
    request = Request("https://generativelanguage.googleapis.com/v1beta/auth_tokens",
                      data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": key})
    with urlopen(request, timeout=8) as response:
        name = json.load(response)["name"]
    if not name.startswith("auth_tokens/"):
        raise ValueError("auth token")
    return {"token": name, "model": model}
