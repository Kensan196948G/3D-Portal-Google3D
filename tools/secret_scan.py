#!/usr/bin/env python3
"""リポジトリに入っている（git 管理下の）ファイルに秘密情報らしい文字列がないか調べる。見つかれば終了コード 1。
値は表示しない（ファイル名・行番号・種類だけ）。"""
import re, subprocess, sys

PATTERNS = {
    'Google API キー': re.compile(rb'AIza[0-9A-Za-z_\-]{35}'),
    '秘密鍵': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----'),
    'Anthropic API キー': re.compile(rb'sk-ant-[0-9A-Za-z_\-]{20,}'),
    'GitHub トークン': re.compile(rb'gh[pousr]_[0-9A-Za-z]{30,}'),
    'Slack トークン': re.compile(rb'xox[abprs]-[0-9A-Za-z-]{10,}'),
    '接続文字列のパスワード': re.compile(rb'postgres(?:ql)?://[^:\s/]+:[^@\s]{4,}@'),
}
files = subprocess.run(['git', 'ls-files', '-z'], capture_output=True, check=True).stdout.split(b'\0')
hits = []
for f in filter(None, files):
    try:
        data = open(f, 'rb').read()
    except OSError:
        continue
    for name, pat in PATTERNS.items():
        for m in pat.finditer(data):
            hits.append((f.decode(), data.count(b'\n', 0, m.start()) + 1, name))
for f, line, name in hits:
    print(f'{f}:{line}: {name}らしい文字列')
print(f'検査したファイル {len([x for x in files if x])} 件／見つかった件数 {len(hits)}')
sys.exit(1 if hits else 0)
