#!/usr/bin/env python3
"""オンライン版（online/）を、このPCのIPアドレスと空いているポートで配信する。

使い方：python3 tools/serve_online.py            … IPアドレスを自動で選び、空いているポートで起動
        python3 tools/serve_online.py --host 0.0.0.0 --port 36621   … 常駐用（systemd）。すべてのアドレスで待ち受け、ポートを固定
        python3 tools/serve_online.py --host 192.168.1.10 --port 8123   … 指定して起動
- どのフォルダから実行しても online/ を配信する。
- 前回使ったポートが空いていれば同じポートを使う（Google のキーに登録した URL を変えずに済むように）。
  空いていなければ OS が空いているポートを割り当てる。
- 表示された URL を、Google Cloud のキーの「ウェブサイトの制限」に登録する（例：http://192.168.1.10:8123/*）。
- 同じネットワーク（社内LAN）の人も開ける。社外には出さないこと（情報区分「社内」）。止めるときは Ctrl+C。
"""
import argparse, functools, http.server, os, socket, sys
sys.stdout.reconfigure(line_buffering=True)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', 'online'))
PORT_FILE = os.path.join(HERE, '.serve_port')

def lan_ip():
    # 外へ向かう経路の送信元アドレスを調べる（UDP の connect はパケットを送らない）
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('192.0.2.1', 9)); return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()

def all_ips():
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET): ips.add(info[4][0])
    except OSError:
        pass
    return sorted(i for i in ips if not i.startswith('127.'))

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 設定とデータは毎回取り直す（キーや現場台帳を差し替えたらすぐ反映）
        if self.path.split('?')[0].startswith('/data/'): self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))

def main():
    ap = argparse.ArgumentParser(description='オンライン版を配信する')
    ap.add_argument('--host', help='待ち受けるIPアドレス（省略時は自動）')
    ap.add_argument('--port', type=int, help='ポート番号（省略時は前回のポート、使えなければ自動）')
    a = ap.parse_args()
    if not os.path.exists(os.path.join(ROOT, 'index.html')):
        sys.exit(f'online/index.html が見つかりません：{ROOT}')
    host = a.host or lan_ip()
    want = a.port
    if want is None and os.path.exists(PORT_FILE):
        try: want = int(open(PORT_FILE).read().strip())
        except ValueError: want = None
    sys.stdout.reconfigure(line_buffering=True)
    H = functools.partial(Handler, directory=ROOT)
    try:
        srv = http.server.ThreadingHTTPServer((host, want or 0), H)
    except OSError:
        if a.port: sys.exit(f'ポート {a.port} は使用中です。--port を変えるか、省略してください。')
        srv = http.server.ThreadingHTTPServer((host, 0), H)   # 空いているポートを OS が割り当てる
    port = srv.server_address[1]
    open(PORT_FILE, 'w').write(str(port))
    shown = lan_ip() if host in ('0.0.0.0', '') else host   # すべてのアドレスで待ち受けるときは、このPCのLAN側アドレスで案内する
    url = f'http://{shown}:{port}/'
    print('みらい建設工業 3D現場ポータル（オンライン版）を配信しています')
    print(f'  開く URL       : {url}')
    print(f'  キーに登録する : {url}*   （Google Cloud → 認証情報 → キー → ウェブサイトの制限）')
    if want and port != want: print(f'  ※前回のポート {want} は使用中のため {port} に変わりました。キーの登録も合わせてください。')
    others = [i for i in all_ips() if i != shown]
    if others: print('  ほかのアドレス : ' + ', '.join(others) + '（--host で指定できます）')
    print(f'  配信フォルダ   : {ROOT}')
    print(f'  キー設定       : {"あり（data/config.json）" if os.path.exists(os.path.join(ROOT, "data", "config.json")) else "なし（画面の 🔑 APIキー で入力、または data/config.json を作成）"}')
    print('  止めるとき     : Ctrl+C')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n停止しました')

if __name__ == '__main__':
    main()
