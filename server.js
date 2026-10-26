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

app.use(express.static(__dirname));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}
function isPrivateIPv6(ip) {
  const s = ip.toLowerCase();
  return s === "::" || s === "::1" || s.startsWith("fc") ||
    s.startsWith("fd") || s.startsWith("fe80:") || s.startsWith("::ffff:127.");
}
async function validateTarget(raw) {
  let url;
  try { url = new URL(raw); }
  catch { throw new Error("URLの形式を確認してください。例：https://example.com"); }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("http または https のURLを入力してください。");
  }
  if (url.username || url.password) throw new Error("認証情報を含むURLには対応していません。");

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("ローカルネットワークのアドレスには接続できません。");
  }
  if (net.isIP(host) === 4 && isPrivateIPv4(host)) throw new Error("プライベートIPアドレスには接続できません。");
  if (net.isIP(host) === 6 && isPrivateIPv6(host)) throw new Error("プライベートIPアドレスには接続できません。");

  if (!net.isIP(host)) {
    let records;
    try { records = await dns.lookup(host, { all: true }); }
    catch { throw new Error("ホスト名を確認できませんでした。"); }
    if (!records.length || records.some(r =>
      net.isIP(r.address) === 4 ? isPrivateIPv4(r.address) : isPrivateIPv6(r.address))) {
      throw new Error("このホスト名には接続できません。");
    }
  }
  return url;
}
function throughProxy(url) {
  return "/proxy?url=" + encodeURIComponent(url);
}
function proxify(value, baseUrl) {
  if (!value || /^(#|javascript:|mailto:|tel:|data:|blob:)/i.test(value.trim())) return value;
  try { return throughProxy(new URL(value, baseUrl).href); } catch { return value; }
}
function rewriteSrcset(value, baseUrl) {
  return value.split(",").map(item => {
    const parts = item.trim().split(/\s+/);
    if (parts[0]) parts[0] = proxify(parts[0], baseUrl);
    return parts.join(" ");
  }).join(", ");
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "Tokage Proxy" }));

app.get("/proxy", async (req, res) => {
  const raw = typeof req.query.url === "string" ? req.query.url : "";
  if (!raw) return res.status(400).type("text").send("URLを入力してください。");

  try {
    const target = await validateTarget(raw);
    const response = await axios.get(target.href, {
      timeout: TIMEOUT_MS,
      maxRedirects: 0,
      responseType: "arraybuffer",
      maxContentLength: MAX_BYTES,
      maxBodyLength: MAX_BYTES,
      validateStatus: status => status >= 200 && status < 500,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TokageProxy/1.1)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
      }
    });

    const contentType = String(response.headers["content-type"] || "application/octet-stream");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Cache-Control", "no-store");

    if (contentType.includes("text/html")) {
      const $ = cheerio.load(Buffer.from(response.data).toString("utf8"));
      $("base, meta[http-equiv='refresh']").remove();

      $("[href]").each((_, el) => {
        const value = $(el).attr("href");
        if (value) $(el).attr("href", proxify(value, target.href));
      });
      $("[src]").each((_, el) => {
        const value = $(el).attr("src");
        if (value) $(el).attr("src", proxify(value, target.href));
      });
      $("[poster]").each((_, el) => {
        const value = $(el).attr("poster");
        if (value) $(el).attr("poster", proxify(value, target.href));
      });
      $("[srcset]").each((_, el) => {
        $(el).attr("srcset", rewriteSrcset($(el).attr("srcset"), target.href));
      });
      $("[action]").each((_, el) => {
        const value = $(el).attr("action");
        if (value) $(el).attr("action", proxify(value, target.href));
      });
      res.status(response.status).type("html").send($.html());
    } else {
      res.status(response.status);
      res.set("Content-Type", contentType);
      res.send(Buffer.from(response.data));
    }
  } catch (error) {
    const message = error.code === "ECONNABORTED"
      ? "接続がタイムアウトしました。"
      : error.code === "ERR_BAD_RESPONSE" || error.message?.includes("maxContentLength")
        ? "ページのデータが大きすぎるため表示できません。"
        : (error.message || "ページを読み込めませんでした。");
    res.status(502).type("text").send("ページを開けませんでした。\n\n" + message);
  }
});

app.listen(PORT, () => console.log(`Tokage Proxy running on port ${PORT}`));
