"""Temporary, localhost-only DOM/UI test harness. Never runs the monitor."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
import mimetypes

ROOT = Path(__file__).resolve().parents[1]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        name = self.path.split("?", 1)[0].strip("/") or "dashboard.html"
        if name == "collector-test":
            body = (ROOT / "tests/fixtures/search.html").read_text(encoding="utf-8")
            body += '<script src="/shared.js"></script><script src="/collector.js"></script><script src="/fixture-run.js"></script>'
            content = body.encode()
            kind = "text/html; charset=utf-8"
        elif name == "fixture-run.js":
            content = b'''const sample=MercariCollector.readDocument();
const result={ids:sample.items.map(i=>i.id),ignored:sample.ignored,pending:sample.pending,prices:sample.items.map(i=>i.price)};
const expected=["m100","2JWXY4bD3f97JZ5u7U68aR","m103","m104","m105"];
const passed=JSON.stringify(result.ids)===JSON.stringify(expected)&&result.ignored===2&&JSON.stringify(result.pending)==="[8]"&&result.prices[1]==="\\u00a51,200";
const pre=document.createElement("pre");pre.id="test-result";pre.textContent=JSON.stringify({passed,...result},null,2);document.body.prepend(pre);'''
            kind = "application/javascript"
        elif name == "mock-chrome.js":
            content = (ROOT / "tools/dashboard-demo.js").read_bytes()
            kind = "application/javascript"
        elif name == "dashboard.html":
            body = (ROOT / "extension/dashboard.html").read_text(encoding="utf-8")
            body = body.replace('<script type="module"', '<script src="mock-chrome.js"></script><script type="module"')
            content = body.encode()
            kind = "text/html; charset=utf-8"
        elif name in {p.name for p in (ROOT / "extension").iterdir() if p.is_file()}:
            content = (ROOT / "extension" / name).read_bytes()
            kind = "application/javascript" if name.endswith(".js") else mimetypes.guess_type(name)[0] or "application/octet-stream"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)


if __name__ == "__main__":
    print("DOM/UI test server: http://127.0.0.1:8769", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8769), Handler).serve_forever()
