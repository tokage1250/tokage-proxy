const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const dns = require("node:dns").promises;
const net = require("node:net");
const path = require("node:path");

const app = express();
const PORT = process.env.PORT || 3000;

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;
const MAX_REQUESTS_PER_MINUTE = 60;

// 許可されたドメインのみアクセス可能。
// Render の Environment で ALLOWED_HOSTS を設定して変更できます。
const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_HOSTS ||
    "example.com,wikipedia.org,mozilla.org")
    .split(",")
    .map(host => host.trim().toLowerCase())
    .filter(Boolean)
);

app.disable("x-powered-by");
app.use(express.static(__dirname));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Tokage Proxy"
  });
});

// ----------------------------------------
// URL とホストの検証
// ----------------------------------------

function normalizeUrl(raw) {
  let value = String(raw || "").trim();

  if (!value) {
    throw new Error("URLを入力してください。");
  }

  if (!/^https?:\/\//i.test(value)) {
    value = "https://" + value;
  }

  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "URLの形式を確認してください。例：https://example.com"
    );
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("HTTP または HTTPS のURLを入力してください。");
  }

  if (url.username || url.password) {
    throw new Error("認証情報を含むURLには対応していません。");
  }

  return url;
}

function isAllowedHost(host) {
  const normalized = host
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();

  for (const allowed of ALLOWED_HOSTS) {
    if (
      normalized === allowed ||
      normalized.endsWith("." + allowed)
    ) {
      return true;
    }
  }

  return false;
}

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);

  if (
    p.length !== 4 ||
    p.some(n => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return true;
  }

  return (
    p[0] === 0 ||
    p[0] === 10 ||
    p[0] === 127 ||
    p[0] >= 224 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
  );
}

function isPrivateIPv6(ip) {
  const s = ip.toLowerCase();

  return (
    s === "::" ||
    s === "::1" ||
    s.startsWith("fc") ||
    s.startsWith("fd") ||
    /^fe[89ab]/.test(s) ||
    s.startsWith("ff") ||
    s.startsWith("::ffff:")
  );
}

function isPublicAddress(ip) {
  const version = net.isIP(ip);

  if (version === 4) {
    return !isPrivateIPv4(ip);
  }

  if (version === 6) {
    return !isPrivateIPv6(ip);
  }

  return false;
}

async function validateTarget(raw) {
  const url = normalizeUrl(raw);

  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    throw new Error("ローカルネットワークには接続できません。");
  }

  if (!isAllowedHost(host)) {
    throw new Error(
      "このドメインは許可リストに登録されていません。"
    );
  }

  if (net.isIP(host)) {
    if (!isPublicAddress(host)) {
      throw new Error("このIPアドレスには接続できません。");
    }

    return url;
  }

  let records;

  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw new Error("ホスト名を確認できませんでした。");
  }

  if (
    !records.length ||
    records.some(record => !isPublicAddress(record.address))
  ) {
    throw new Error("このホスト名の接続先は許可されていません。");
  }

  return url;
}

// ----------------------------------------
// プロキシURLとページ内URLの変換
// ----------------------------------------

function throughProxy(url) {
  return "/proxy?url=" + encodeURIComponent(url);
}

function rewriteUrl(value, baseUrl) {
  if (!value) return value;

  const trimmed = value.trim();

  if (
    /^(#|javascript:|mailto:|tel:|data:|blob:|about:)/i.test(trimmed)
  ) {
    return value;
  }

  try {
    const absolute = new URL(trimmed, baseUrl);

    if (!["http:", "https:"].includes(absolute.protocol)) {
      return value;
    }

    // 許可されたサイトへのリンクだけをプロキシ経由にする。
    if (isAllowedHost(absolute.hostname)) {
      return throughProxy(absolute.href);
    }

    // 許可リスト外のサイトは直接の絶対URLにする。
    return absolute.href;
  } catch {
    return value;
  }
}

function rewriteSrcset(value, baseUrl) {
  if (!value) return value;

  return value
    .split(",")
    .map(item => {
      const parts = item.trim().split(/\s+/);

      if (parts[0]) {
        parts[0] = rewriteUrl(parts[0], baseUrl);
      }

      return parts.join(" ");
    })
    .join(", ");
}

function rewriteCss(css, baseUrl) {
  // CSS の url(...) を変換
  let result = css.replace(
    /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
    (match, quote, value) => {
      const rewritten = rewriteUrl(value, baseUrl);
      return `url("${rewritten}")`;
    }
  );

  // @import "style.css" の形式にも対応
  result = result.replace(
    /@import\s+(["'])(.*?)\1/gi,
    (match, quote, value) => {
      return `@import "${rewriteUrl(value, baseUrl)}"`;
    }
  );

  return result;
}

// ----------------------------------------
// リダイレクトを検証しながらページを取得
// ----------------------------------------

async function fetchPage(initialUrl) {
  let currentUrl = initialUrl;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    // 転送先も毎回検証する
    const target = await validateTarget(currentUrl);

    const response = await axios.get(target.href, {
      timeout: TIMEOUT_MS,
      maxRedirects: 0,
      responseType: "arraybuffer",
      maxContentLength: MAX_BYTES,
      maxBodyLength: MAX_BYTES,

      // リダイレクトやエラーステータスを自分で処理する
      validateStatus: status => status >= 200 && status < 600,

      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TokageProxy/1.2)",
        "Accept":
          "text/html,application/xhtml+xml,application/xml," +
          "text/css,image/avif,image/webp,*/*;q=0.8"
      }
    });

    const location = response.headers.location;
    const isRedirect = [301, 302, 303, 307, 308]
      .includes(response.status);

    if (isRedirect && location) {
      if (redirects === MAX_REDIRECTS) {
        throw new Error("リダイレクト回数の上限に達しました。");
      }

      currentUrl = new URL(location, target.href).href;
      continue;
    }

    return { response, target };
  }

  throw new Error("ページを読み込めませんでした。");
}

// ----------------------------------------
// 簡易アクセス制限
// ----------------------------------------

const requestCounts = new Map();

app.use("/proxy", (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const windowMs = 60 * 1000;

  let record = requestCounts.get(ip);

  if (!record || now - record.start >= windowMs) {
    record = { start: now, count: 0 };
  }

  record.count += 1;
  requestCounts.set(ip, record);

  if (record.count > MAX_REQUESTS_PER_MINUTE) {
    res.set("Retry-After", "60");

    return res
      .status(429)
      .type("text")
      .send("アクセスが多すぎます。しばらくしてから再度お試しください。");
  }

  next();
});

// ----------------------------------------
// メインのプロキシ処理
// ----------------------------------------

app.get("/proxy", async (req, res) => {
  const raw = typeof req.query.url === "string"
    ? req.query.url
    : "";

  if (!raw) {
    return res
      .status(400)
      .type("text")
      .send("URLを入力してください。");
  }

  try {
    const initialUrl = normalizeUrl(raw).href;
    const { response, target } = await fetchPage(initialUrl);

    const contentType = String(
      response.headers["content-type"] || "application/octet-stream"
    );

    res.set("X-Content-Type-Options", "nosniff");
    res.set("Cache-Control", "no-store");

    if (contentType.includes("text/html")) {
      const html = Buffer.from(response.data).toString("utf8");

      // 管理システムのブロック画面は、そのまま案内する
      if (/INTERSAFE|Gateway Connection/i.test(html)) {
        return res
          .status(451)
          .type("text")
          .send(
            "アクセス先がネットワーク管理システムによって制限されています。\n" +
            "ネットワーク管理者にアクセス許可を確認してください。"
          );
      }

      const $ = cheerio.load(html);

      // 相対URLの基準をプロキシ側に誤認させない
      $("base, meta[http-equiv='refresh']").remove();

      $("[href]").each((_, el) => {
        const value = $(el).attr("href");

        if (value) {
          $(el).attr("href", rewriteUrl(value, target.href));
        }
      });

      $("[src]").each((_, el) => {
        const value = $(el).attr("src");

        if (value) {
          $(el).attr("src", rewriteUrl(value, target.href));
        }
      });

      $("[poster]").each((_, el) => {
        const value = $(el).attr("poster");

        if (value) {
          $(el).attr("poster", rewriteUrl(value, target.href));
        }
      });

      $("[srcset]").each((_, el) => {
        const value = $(el).attr("srcset");

        if (value) {
          $(el).attr("srcset", rewriteSrcset(value, target.href));
        }
      });

      $("[action]").each((_, el) => {
        const value = $(el).attr("action");

        if (value) {
          $(el).attr("action", rewriteUrl(value, target.href));
        }
      });

      $("[style]").each((_, el) => {
        const value = $(el).attr("style");

        if (value) {
          $(el).attr("style", rewriteCss(value, target.href));
        }
      });

      $("style").each((_, el) => {
        $(el).text(rewriteCss($(el).text(), target.href));
      });

      return res
        .status(response.status)
        .type("html")
        .send($.html());
    }

    if (contentType.includes("text/css")) {
      const css = Buffer.from(response.data).toString("utf8");

      return res
        .status(response.status)
        .type("text/css")
        .send(rewriteCss(css, target.href));
    }

    res.status(response.status);
    res.set("Content-Type", contentType);

    return res.send(Buffer.from(response.data));

  } catch (error) {
    console.error("Proxy error:", error.message);

    let message = "ページを読み込めませんでした。";

    if (error.code === "ECONNABORTED") {
      message = "接続がタイムアウトしました。";
    } else if (
      error.code === "ERR_BAD_RESPONSE" ||
      error.message?.includes("maxContentLength")
    ) {
      message = "ページのデータが大きすぎるため表示できません。";
    } else if (error.message) {
      message = error.message;
    }

    return res
      .status(502)
      .type("text")
      .send("ページを開けませんでした。\n\n" + message);
  }
});

app.listen(PORT, () => {
  console.log(`Tokage Proxy running on port ${PORT}`);
});
