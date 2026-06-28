// Background service worker
// Reads the auth token from Ninja Tracker localStorage and stores it in extension storage
// Runs silently whenever the tracker page is visited

chrome.webNavigation.onCompleted.addListener(details => {
  // When user visits the tracker, grab their token
  chrome.scripting.executeScript({
    target: { tabId: details.tabId },
    func: () => localStorage.getItem("nt_token"),
  }).then(results => {
    const token = results?.[0]?.result;
    if (token) {
      chrome.storage.local.set({ nt_token: token });
    }
  }).catch(() => {});
}, { url: [{ hostContains: "zerosoara.github.io" }] });
