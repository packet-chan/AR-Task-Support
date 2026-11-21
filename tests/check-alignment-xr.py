from pathlib import Path
import contextlib, json, os, queue, shutil, subprocess, sys, tempfile, threading
from http.server import ThreadingHTTPServer
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root))
import serve, production
result=queue.Queue()
class Handler(serve.Library):
    def do_GET(self):
        if self.path.startswith('/support.html?'):
            data=(serve.WEB/'support.html').read_text(encoding='utf-8').replace('</head>','<script src="/fixture.js"></script></head>')
            return self.payload(200,'text/html; charset=utf-8',data.encode())
        if self.path=='/fixture.js':
            return self.payload(200,'text/javascript',Path(__file__).with_suffix('.js').read_bytes())
        return super().do_GET()
    def do_POST(self):
        if self.path=='/report':
            result.put(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            return self.json_response(200,{})
        return super().do_POST()
    def log_message(self,*args): pass
with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp, ThreadingHTTPServer(('127.0.0.1',0),Handler) as server:
    server.database=Path(tmp)/'manuals.sqlite3'
    src=Path(sys.argv[1]).resolve()
    uid=production.read_json(src/'S4/alignment.json')['pdf']
    path=serve.library_path(server.database,'P1')
    with contextlib.closing(serve.open_library(path,True)) as db,db:
        gen=db.execute('SELECT generation FROM identity').fetchone()[0]
        db.execute('INSERT INTO manuals VALUES(?,?,?,?,?)',(uid,'Coffee','HD8943',b'',None))
        db.execute("INSERT INTO production(id,stage) VALUES(?,'ready')",(uid,))
    dest=production.stage_root(path,gen,uid,'HD8943')
    for stage in ['S1','S2']:shutil.copytree(src/stage,dest/stage)
    plan=production.read_json(src/'S4/alignment.json')
    rev=Path('S4')/plan['round']/'revisions'/plan['revision']/'S2'
    shutil.copytree(src/rev,dest/rev)
    shutil.copy2(src/'S4/alignment.json',dest/'S4/alignment.json')
    shutil.copytree(src/'S4/alignment-plans',dest/'S4/alignment-plans')
    threading.Thread(target=server.serve_forever,daemon=True).start()
    chrome=Path(os.environ['ProgramFiles'])/'Google/Chrome/Application/chrome.exe'
    proc=subprocess.Popen([str(chrome),'--headless=new','--enable-unsafe-swiftshader','--disable-background-timer-throttling','--no-first-run','--disable-extensions','--no-proxy-server','--user-data-dir='+str(Path(tmp)/'chrome'),f'http://127.0.0.1:{server.server_port}/support.html?user=P1&id='+uid],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        out=result.get(timeout=55)
        print(out,flush=True);assert out['ok']
        record=production.read_json(next((dest/'S4/alignment-records').glob('*.json')))['record']
        assert record['parts'].keys()=={'Socket','Display'}
        assert abs(record['parts']['Socket']['offset'][0]-.035)<.00001
        socket=record['parts']['Socket']
        assert socket['method']=='single-point' and 'repeat' not in socket and len(socket['viewerMatrix'])==16
        assert (dest/'S4/alignment-photos'/socket['photo']).read_bytes().startswith(bytes.fromhex('ffd8ff'))
        assert 'photo' not in record['parts']['Display']
        assert sum(abs(n) for n in record['parts']['Display']['offset'])<1e-6
        assert not record['groups']['body']['verified'] and not record['groups']['panel']['verified']
        assert sum(p is not None for p in record['groups']['body']['locations'])==3
        assert record['parts']['Display']['provisional'] and not record['parts']['Display']['verified']
        print("Browser: four-corner controller and pinch resizing, fixed-machine registration, temporary outlines, animated spout and cup, STEP navigation, figure zoom, isolated 35 mm correction and save verified.")
    finally:
        proc.terminate();proc.wait(timeout=10)
        server.shutdown()
