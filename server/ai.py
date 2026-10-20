"""遅れの分析を、AI（Claude）が日本語の文章にする（任意。既定は無効）。

- 有効にするには server/.env に AI_ENABLED=1 と ANTHROPIC_API_KEY を設定する（FortiGate で api.anthropic.com の許可も必要）
- 送るのは画面が計算した「分析の結果（数値と要因）」だけ。工事は架空のサンプルで、個人情報は含まない
- 文章はあくまで説明の補助。数値はワールドモデルの計算が正
"""
import json
import os

import anthropic

MODEL = 'claude-opus-5-5'
SYSTEM = (
    'あなたは港湾・海洋土木の施工管理の専門家です。与えられた工程の分析結果（JSON）だけを根拠に、'
    '支店の工程会議で読み上げられる日本語の説明文を書きます。'
    '数値は JSON にあるものだけを使い、推測で新しい数値を作らないでください。'
    '構成：①竣工予測と遅れの日数を1文、②遅れの主な理由を重要な順に2〜4点（短い文）、'
    '③挽回策の案があれば、追加する機械と効果を1〜2文。全体で400字以内、です・ます調、見出しや記号の装飾は使わない。'
    '分析結果に挽回策がない場合は、編成以外の検討（工程の並び替え・工法の変更など）を一言添えてください。'
)


def enabled() -> bool:
    return os.environ.get('AI_ENABLED', '0') == '1' and bool(os.environ.get('ANTHROPIC_API_KEY'))


_client = None


def _get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        # 応答は短いので 60 秒で打ち切る。再試行は SDK の既定（2 回：接続エラー・429・5xx）
        _client = anthropic.AsyncAnthropic(timeout=60.0, max_retries=2)
    return _client


class AIError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


async def explain(analysis: dict) -> dict:
    payload = json.dumps(analysis, ensure_ascii=False)[:20000]
    try:
        resp = await _get_client().beta.messages.create(
            model=MODEL,
            max_tokens=4000,
            system=SYSTEM,
            messages=[{'role': 'user', 'content': f'次の分析結果を説明文にしてください。\n\n{payload}'}],
            betas=['server-side-fallback-2026-07-01'],
            # 安全側の判定で断られたときは、推奨のモデルで自動的にやり直す（サーバ側のフォールバック）
            extra_body={'fallbacks': 'default', 'output_config': {'effort': 'low'}},
        )
    except anthropic.AuthenticationError:
        raise AIError(502, 'AI の認証に失敗しました（ANTHROPIC_API_KEY を確認してください）')
    except anthropic.PermissionDeniedError:
        raise AIError(502, 'AI の利用権限がありません')
    except anthropic.RateLimitError:
        raise AIError(503, 'AI が混み合っています。しばらくしてからやり直してください')
    except anthropic.BadRequestError as e:
        raise AIError(502, f'AI への依頼が受け付けられませんでした（{e.message[:200]}）')
    except anthropic.APITimeoutError:
        raise AIError(504, 'AI の応答が時間内に返りませんでした')
    except anthropic.APIConnectionError:
        raise AIError(502, 'AI に接続できません（社内ネットワークでは api.anthropic.com の通信許可が必要です）')
    except anthropic.APIStatusError as e:
        raise AIError(502, f'AI の呼び出しに失敗しました（HTTP {e.status_code}）')
    if resp.stop_reason == 'refusal':
        raise AIError(422, 'AI がこの依頼への回答を控えました')
    text = ''.join(b.text for b in resp.content if b.type == 'text').strip()
    if not text:
        raise AIError(502, 'AI から文章が返りませんでした')
    return {'text': text, 'model': resp.model}
