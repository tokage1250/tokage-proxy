/*
 * GitHub Pages と Render を分けて使う場合：
 * 1. Render に server.js をデプロイ
 * 2. 下の RENDER_BACKEND_URL を Render のURLに変更
 * 3. GitHub に push
 *
 * Render 側のURL例：https://tokage-proxy.onrender.com
 */
const RENDER_BACKEND_URL = "https://YOUR-RENDER-SERVICE.onrender.com";
const isGithubPages = location.hostname.endsWith("github.io");
const API_BASE = isGithubPages ? RENDER_BACKEND_URL.replace(/\/$/, "") : "";

const form = document.getElementById("proxy-form");
const input = document.getElementById("url-input");
const message = document.getElementById("message");
document.getElementById("year").textContent = new Date().getFullYear();

function openUrl(raw) {
  let value = String(raw || "").trim();
  if (!value) {
    message.textContent = "URLを入力してください。";
    input.focus();
    return;
  }
  if (!/^https?:\/\//i.test(value)) value = "https://" + value;

  let parsed;
  try {
    parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
  } catch {
    message.textContent = "URLの形式を確認してください。例：https://example.com";
    input.focus();
    return;
  }

  if (isGithubPages && RENDER_BACKEND_URL.includes("YOUR-RENDER-SERVICE")) {
    message.textContent = "先に script.js の RENDER_BACKEND_URL を、Renderで公開したURLに変更してください。";
    return;
  }

  message.textContent = "ページを読み込んでいます…";
  const endpoint = `${API_BASE}/proxy?url=${encodeURIComponent(parsed.href)}`;
  window.location.href = endpoint;
}

form.addEventListener("submit", event => {
  event.preventDefault();
  openUrl(input.value);
});
document.querySelectorAll("[data-url]").forEach(button => {
  button.addEventListener("click", () => {
    input.value = button.dataset.url;
    openUrl(button.dataset.url);
  });
});
