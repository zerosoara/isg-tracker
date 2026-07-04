function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m + " min ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + " hr ago";
  return Math.round(h / 24) + " day(s) ago";
}

chrome.storage.local.get(["nt_token", "nt_last_token_capture", "nt_last_attempt"], data => {
  const loginEl = document.getElementById("login-status");
  if (data.nt_token) {
    loginEl.textContent = "✅ Logged in";
    loginEl.className = "val ok";
  } else {
    loginEl.textContent = "❌ Not logged in — open Ninja Tracker, log in, then reload that page.";
    loginEl.className = "val bad";
  }

  const syncEl = document.getElementById("sync-status");
  const timeEl = document.getElementById("sync-time");
  const a = data.nt_last_attempt;
  if (!a) {
    syncEl.textContent = "No sync attempted yet — submit a sale on the ISG portal to test.";
    syncEl.className = "val";
  } else {
    syncEl.textContent = (a.ok ? "✅ " : "❌ ") + a.reason;
    syncEl.className = "val " + (a.ok ? "ok" : "bad");
    timeEl.textContent = timeAgo(a.time);
  }
});
