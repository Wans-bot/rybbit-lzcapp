// Rybbit 导出/下载 → 懒猫网盘「保存至…」桥
//
// 背景：
//   Rybbit 的导出按钮大多是 fetch → Blob → a[download] + blob:，这类已被官方
//   open-save-chooser 注入（lzc-file-chooser-inject.js）的 downloadAnchor 钩子接管。
//   但应用里还有「同源普通 HTTP 下载」（直接指向自身后端、没有 download 属性、
//   href 也不是 blob:/data:），官方 isDownloadAnchor() 不认，点了就是浏览器原生下载，
//   绕过了网盘选择器（审核意见「导出/下载需要网盘文件拦截」即指此类）。
//
// 本脚本把这类点击改造成「先 fetch 成 Blob → 造一个 a[download] + blob: 锚点 → click()」，
// 于是官方注入的 HTMLAnchorElement.prototype.click 钩子（installDownloadAnchorHooks）
// 就会接管，弹出「保存至懒猫」选择器。改造失败时退回原生下载，绝不吞掉用户的点击。
//
// 重要：本文件必须存在于包内。上一版（2.9.2，review 21432）lzc-manifest.yml 引用了它但
// content.tar 里没有该文件，网盘下载桥线上实际不生效；缺文件还会让 lzcinit 注入失败。
(() => {
  "use strict";

  const MARK = "__lzcRybbitDownloadBridge";
  if (window[MARK]) return;
  const state = { version: 1, intercepted: 0, lastError: "" };
  try {
    Object.defineProperty(window, MARK, { value: state, configurable: true });
  } catch {
    window[MARK] = state;
  }

  // Rybbit 的同源下载/导出入口（v2.9.2 实测）：
  //   /api/sites/:siteId/export/pdf?startDate=…&endDate=…&timeZone=…
  //     —— server/src/index.ts: fastify.get("/sites/:siteId/export/pdf", authAnalyticsRead, generatePdfReport)
  //   CSV/JSON 导出（client/src/lib/export.ts downloadBlob）走 blob: 锚点，已由官方钩子接管。
  // 这里除了明确的 /export/ 段，再兜住「路径以附件扩展名结尾」的同源下载。
  const isExportUrl = (href) => {
    try {
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) return false;
      return (
        /^\/api\/sites\/[^/]+\/export\/[^/]+\/?$/i.test(url.pathname) ||
        /\/export\//i.test(url.pathname) ||
        /\.(?:csv|tsv|zip|xlsx?|pdf)$/i.test(url.pathname)
      );
    } catch {
      return false;
    }
  };

  const filenameFrom = (response, fallback) => {
    const header = response.headers.get("content-disposition") || "";
    // 形如: attachment; filename="report.pdf" / filename*=UTF-8''%E6%8A%A5%E8%A1%A8.pdf
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
    if (!match || !match[1]) return fallback;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  };

  // 把普通导出链接变成官方注入认得的「a[download] + blob:」
  const handOffToSaveChooser = async (href) => {
    const response = await fetch(href, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`export returned HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.size) throw new Error("export returned empty body");

    const name = filenameFrom(response, "rybbit-export");
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = name;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    try {
      // 官方钩子在这里接管：a[download] + blob: → 弹「保存至懒猫」
      anchor.click();
    } finally {
      anchor.remove();
      // 用户选目录可能要等一会儿，别立刻回收
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 120000);
    }
    return { name, size: blob.size };
  };

  // 兜底：改造失败就用原生下载语义（服务端本来就是 attachment 响应）
  const nativeDownload = (anchor) => {
    anchor.removeAttribute("target");
    anchor.setAttribute("download", "");
    anchor.click();
  };

  document.addEventListener(
    "click",
    (event) => {
      // 只处理左键、无修饰键的普通点击
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target instanceof Element ? event.target : null;
      const anchor = target && target.closest ? target.closest("a[href]") : null;
      if (!anchor) return;
      // 已经是官方注入认得的形态（a[download] + blob:/data:）→ 交给它，不插手
      if (anchor.hasAttribute("download")) return;
      if (!isExportUrl(anchor.getAttribute("href") || anchor.href)) return;

      event.preventDefault();
      event.stopPropagation();
      state.intercepted += 1;

      handOffToSaveChooser(anchor.href).catch((error) => {
        state.lastError = String(error && error.message ? error.message : error);
        try {
          nativeDownload(anchor);
        } catch {
          /* 兜底也失败就只能放弃，不要抛到页面 */
        }
      });
    },
    true,
  );
})();
