// WebKit 下的滚动帧率 A/B：融入模式原样 vs 去掉网页里的 backdrop-filter(毛玻璃)
// 编译：swiftc -O .tmp/wk-perf.swift -o .tmp/wk-perf-bin
// 运行：.tmp/wk-perf-bin http://127.0.0.1:4173/
import Cocoa
import WebKit

let args = CommandLine.arguments
let urlStr = args.count > 1 ? args[1] : "http://127.0.0.1:4173/"
let seedHTML = (try? String(contentsOfFile: (ProcessInfo.processInfo.environment["HOME"] ?? ".") + "/Documents/简记/.assets/html-20261107-141713-64ae.html", encoding: .utf8)) ?? ""

final class Runner: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
  var web: WKWebView!
  var win: NSWindow!
  var step = 0

  func start() {
    let cfg = WKWebViewConfiguration()
    let ucc = WKUserContentController()
    ucc.add(self, name: "log")
    let data = try! JSONSerialization.data(withJSONObject: [seedHTML], options: [])
    var lit = String(data: data, encoding: .utf8)!; lit.removeFirst(); lit.removeLast()
    ucc.addUserScript(WKUserScript(source: "window.__JJ_HTML__ = \(lit);", injectionTime: .atDocumentStart, forMainFrameOnly: true))
    cfg.userContentController = ucc

    let rect = NSRect(x: 0, y: 0, width: 1200, height: 820)
    web = WKWebView(frame: rect, configuration: cfg)
    web.navigationDelegate = self
    win = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
    win.contentView = web
    win.setFrameOrigin(NSPoint(x: 40, y: 40))
    win.orderFront(nil) // 不 makeKey，不抢焦点
    web.load(URLRequest(url: URL(string: urlStr)!))
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    step += 1
    if step == 1 {
      let seed = """
      localStorage.clear();
      (function(){
        var fm = '---\\ntitle: 光伏板块\\ncreated: 2026-11-07T10:00:00.000Z\\nupdated: 2026-11-07T10:00:00.000Z\\npinned: false\\n---\\n\\n';
        var meta = JSON.stringify({file:'html-jitter.html', title:'光伏工序级竞争格局全表', height:900});
        var note = fm + '```jianji-html\\n' + meta + '\\n```\\n';
        var a = {}; a['html-jitter.html'] = window.__JJ_HTML__ || '';
        localStorage.setItem('jianji.assets.v1', JSON.stringify(a));
        var n = {}; n['股市/光伏板块.md'] = note;
        localStorage.setItem('jianji.notes.v1', JSON.stringify(n));
        location.reload();
      })();
      """
      webView.evaluateJavaScript(seed) { _, _ in }
    } else if step == 2 {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
        let js = self.bench()
        webView.evaluateJavaScript(js) { _, err in
          if let err = err { print("JS 错误：\(err)") }
        }
      }
    }
  }

  func bench() -> String {
    return """
    (async () => {
      const post = (o) => window.webkit.messageHandlers.log.postMessage(JSON.stringify(o));
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const it = [...document.querySelectorAll('.note-item, .note-title')].find(e => e.textContent.includes('光伏板块'));
      (it?.closest('.note-item') || it)?.click();
      await sleep(2500);
      const btn = [...document.querySelectorAll('.html-card button')].find(x => x.textContent.includes('融入'));
      if (btn) btn.click();
      await sleep(2800);

      const card = document.querySelector('.html-card');
      let n = card.parentElement, sc = null;
      while (n) { const st = getComputedStyle(n); if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 1) { sc = n; break } n = n.parentElement }
      if (!sc) sc = document.scrollingElement;

      async function run(label) {
        sc.scrollTop = 0;
        await sleep(300);
        const dts = [];
        let last = performance.now();
        let stop = false;
        const tick = () => {
          if (stop) return;
          const now = performance.now();
          dts.push(now - last);
          last = now;
          sc.scrollTop += 25;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        await sleep(1800);
        stop = true;
        const sorted = dts.slice().sort((a, b) => a - b);
        const pick = (p) => Math.round(sorted[Math.floor(sorted.length * p)] * 10) / 10;
        return { label, frames: dts.length, p50: pick(0.5), p90: pick(0.9), max: Math.round(sorted[sorted.length - 1] * 10) / 10, scrolled: Math.round(sc.scrollTop) };
      }

      const before = await run('原样');
      // 去掉毛玻璃再看
      const f = card.querySelector('iframe');
      const d = f.contentDocument;
      const st = d.createElement('style');
      st.textContent = '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';
      d.head.appendChild(st);
      await sleep(400);
      const after = await run('去掉 backdrop-filter');
      post({ before, after });
    })().catch(e => window.webkit.messageHandlers.log.postMessage(JSON.stringify({ error: String(e && e.message || e) })));
    """
  }

  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    print(String(describing: message.body))
    NSApp.terminate(nil)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let runner = Runner()
runner.start()
app.run()
