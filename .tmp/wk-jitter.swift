// 用 WKWebView（和简记桌面端同一个渲染引擎）打开预览版应用，跑 .tmp/wk-jitter.js 里的量的脚本。
// 编译：swiftc -O .tmp/wk-jitter.swift -o .tmp/wk-jitter-bin
// 运行：.tmp/wk-jitter-bin http://127.0.0.1:4173/ .tmp/wk-jitter.js
import Cocoa
import WebKit

let args = CommandLine.arguments
let urlStr = args.count > 1 ? args[1] : "http://127.0.0.1:4173/"
let scriptPath = args.count > 2 ? args[2] : ".tmp/wk-jitter.js"

let seedHTML = (try? String(contentsOfFile: (ProcessInfo.processInfo.environment["HOME"] ?? ".") + "/Documents/简记/.assets/html-20261107-141713-64ae.html", encoding: .utf8)) ?? ""
let sampler = (try? String(contentsOfFile: scriptPath, encoding: .utf8)) ?? ""

final class Runner: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
  var web: WKWebView!
  var win: NSWindow!
  var step = 0

  func start() {
    let cfg = WKWebViewConfiguration()
    let ucc = WKUserContentController()
    ucc.add(self, name: "log")
    let seed = WKUserScript(source: "window.__JJ_HTML__ = \(jsString(seedHTML));", injectionTime: .atDocumentStart, forMainFrameOnly: true)
    ucc.addUserScript(seed)
    cfg.userContentController = ucc

    let rect = NSRect(x: 0, y: 0, width: 1280, height: 940)
    web = WKWebView(frame: rect, configuration: cfg)
    web.navigationDelegate = self
    win = NSWindow(contentRect: rect, styleMask: [.titled], backing: .buffered, defer: false)
    win.contentView = web
    win.setFrameOrigin(NSPoint(x: 2000, y: 2000)) // 挪到屏幕外，不抢用户视线
    win.makeKeyAndOrderFront(nil)
    web.load(URLRequest(url: URL(string: urlStr)!))
  }

  func jsString(_ s: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: [s], options: [])
    var text = String(data: data, encoding: .utf8)!
    text.removeFirst(); text.removeLast()
    return text
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    step += 1
    if step == 1 {
      // 第一次加载：塞数据、刷新
      webView.evaluateJavaScript(seedOnly()) { _, _ in }
    } else if step == 2 {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
        webView.evaluateJavaScript(sampler) { _, err in
          if let err = err { print("JS 错误：\(err)") }
        }
      }
    }
  }

  func seedOnly() -> String {
    return """
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
  }

  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    let text = String(describing: message.body)
    print(text)
    if let data = text.data(using: .utf8),
       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      summarize(obj)
    }
    NSApp.terminate(nil)
  }

  func summarize(_ o: [String: Any]) {
    if let idle = o["idle"] as? [[String: Any]] {
      print("\n=== 静止 2 秒（每 100ms 一次）===")
      print("mode:", o["mode"] ?? "?")
      print("iframe 高度:", idle.map { "\($0["h"]!)" }.joined(separator: " "))
      print("iframe 顶边:", idle.map { "\($0["top"]!)" }.joined(separator: " "))
      print("网页内工具条 top:", idle.map { "\($0["tb"] ?? "-")" }.joined(separator: " "))
    }
    if let rows = o["cardScroll"] as? [[String: Any]] {
      let tops = rows.map { ($0["top"] as? NSNumber)?.doubleValue ?? 0 }
      var backs = 0
      for i in 1..<tops.count where tops[i] < tops[i - 1] - 0.6 { backs += 1 }
      print("\n=== 卡片模式：滚网页内部（每步 +10px）===")
      print("工具条 top 序列:", rows.enumerated().filter { $0.offset % 8 == 0 }.map { "\($0.element["top"]!)" }.joined(separator: " "))
      print("往回跳次数:", backs, "｜最大值:", tops.max() ?? 0)
    }
    if let rows = o["outerScroll"] as? [[String: Any]] {
      let tops = rows.map { ($0["top"] as? NSNumber)?.doubleValue ?? 0 }
      let ms = rows.map { ($0["ms"] as? NSNumber)?.doubleValue ?? 0 }
      var backs = 0
      for i in 1..<tops.count where tops[i] > tops[i - 1] + 1 { backs += 1 }
      print("\n=== 融入模式：滚笔记（每步 +40px）===")
      print("模式:", o["inlineMode"] ?? "?", "｜iframe 高度:", o["frameH"] ?? "?")
      print("iframe 顶边:", rows.enumerated().filter { $0.offset % 7 == 0 }.map { "\($0.element["top"]!)" }.joined(separator: " "))
      print("往回跳次数:", backs)
      print("每帧耗时 ms:", rows.enumerated().filter { $0.offset % 7 == 0 }.map { "\($0.element["ms"]!)" }.joined(separator: " "))
      let sorted = ms.sorted()
      print("帧耗时中位数:", sorted[sorted.count / 2], "｜最慢:", sorted.last ?? 0)
    }
    if let e = o["error"] { print("错误:", e) }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let runner = Runner()
runner.start()
app.run()
