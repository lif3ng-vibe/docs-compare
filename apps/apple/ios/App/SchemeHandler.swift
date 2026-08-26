import Foundation
import WebKit

/// dcapp://bundle/<path> → bundle 内 web/ 目录(Tauri 版自定义协议的平移)。
/// 自定义 scheme 给 controller 页非 null origin:selftest 的
/// `${location.origin}/fixtures/...`、同源 fetch sites.json 都靠它。
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private static let mimeTypes: [String: String] = [
        "html": "text/html; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8",
        "json": "application/json; charset=utf-8",
        "map": "application/json; charset=utf-8",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
        "svg": "image/svg+xml",
        "ico": "image/x-icon",
        "txt": "text/plain; charset=utf-8",
        "woff": "font/woff",
        "woff2": "font/woff2",
    ]

    /// stop 之后回调 scheme task 会抛异常,记录已停止的任务防御
    private var stopped = Set<ObjectIdentifier>()

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        if DC_DEBUG { NSLog("[dc] scheme start=%@", task.request.url?.absoluteString ?? "?") }
        guard let url = task.request.url, url.host == "bundle" else {
            fail(task, status: 400, message: "bad request")
            return
        }
        let rel = url.path // 形如 /controller.html
        guard !rel.contains("..") else {
            fail(task, status: 403, message: "forbidden")
            return
        }
        guard let base = Bundle.main.resourceURL?
            .appendingPathComponent("web") else {
            fail(task, status: 500, message: "no resourceURL")
            return
        }
        // url.path 带前导斜杠;直接当 fileURLWithPath 会成绝对路径丢掉 base
        let relNoSlash = rel.hasPrefix("/") ? String(rel.dropFirst()) : rel
        let fileURL = base.appendingPathComponent(relNoSlash).standardized
        guard let data = try? Data(contentsOf: fileURL) else {
            NSLog("[dc] scheme 404 %@", rel)
            fail(task, status: 404, message: "not found: \(rel)")
            return
        }
        let ext = fileURL.pathExtension.lowercased()
        let mime = Self.mimeTypes[ext] ?? "application/octet-stream"
        respond(task: task, url: url, status: 200, mime: mime, data: data)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        if DC_DEBUG { NSLog("[dc] scheme stop=%@", urlSchemeTask.request.url?.absoluteString ?? "?") }
        stopped.insert(ObjectIdentifier(urlSchemeTask))
    }

    /// 统一经 HTTPURLResponse 应答:主文档加载用裸 URLResponse 会永不提交
    /// (WKWebView 已知行为),必须带 statusCode/长度头
    private func respond(task: WKURLSchemeTask, url: URL, status: Int, mime: String, data: Data) {
        guard !stopped.contains(ObjectIdentifier(task)) else { return }
        let resp = HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": mime,
                "Content-Length": String(data.count),
                "Cache-Control": "no-store",
            ]
        )!
        task.didReceive(resp)
        task.didReceive(data)
        task.didFinish()
        if DC_DEBUG { NSLog("[dc] scheme served=%@ %d bytes=%d", url.path, status, data.count) }
    }

    private func fail(_ task: WKURLSchemeTask, status: Int, message: String) {
        respond(task: task, url: task.request.url ?? URL(fileURLWithPath: "/"), status: status, mime: "text/plain; charset=utf-8", data: Data(message.utf8))
    }
}
