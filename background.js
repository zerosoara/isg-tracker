// Background service worker
// Reads the auth token from Ninja Tracker localStorage and stores it in extension storage.
// Runs whenever the tracker page is visited. Records every attempt (success or failure) so the
// popup can show what actually happened, instead of failing silently.

function recordTokenCapture(found, host) {
  chrome.storage.local.set({ nt_last_token_capture: { time: Date.now(), found, host: host || "" } });
}

chrome.webNavigation.onCompleted.addListener(details => {
  chrome.scripting.executeScript({
    target: { tabId: details.tabId },
    func: () => localStorage.getItem("nt_token"),
  }).then(results => {
    const token = results?.[0]?.result;
    if (token) {
      chrome.storage.local.set({ nt_token: token });
      recordTokenCapture(true, details.url);
    } else {
      recordTokenCapture(false, details.url);  // page loaded but no token found (not logged in yet)
    }
  }).catch(err => {
    recordTokenCapture(false, details.url + " (error: " + (err && err.message || err) + ")");
  });
}, { url: [{ hostContains: "zerosoara.github.io" }] });
