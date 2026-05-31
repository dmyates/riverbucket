import { currentTab, extensionApi, getSettings, saveLink, showSaveToast, trimSlash } from "./shared.js";

const statusNode = document.querySelector("#status");

document.querySelector("#savePage").addEventListener("click", async () => {
  const tab = await currentTab();
  await saveLinkFromPopup({
    url: tab.url,
    title: tab.title || tab.url,
    source_page_url: tab.url,
    source_page_title: tab.title || ""
  });
});

document.querySelector("#subscribe").addEventListener("click", async () => {
  const tab = await currentTab();
  const detected = await getDetectedFeeds(tab.id);
  const feed = detected.feeds?.[0];
  const payload = feed ? { feedUrl: feed.feedUrl, url: detected.url } : { url: tab.url };
  try {
    await extensionApi("/api/extension/subscribe", payload);
    setStatus(feed ? `Subscribed to ${feed.title}` : "Subscription added");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Request failed");
  }
});

document.querySelector("#openRiver").addEventListener("click", async () => openApp("/#/river"));
document.querySelector("#openBucket").addEventListener("click", async () => openApp("/#/bucket"));
document.querySelector("#options").addEventListener("click", () => chrome.runtime.openOptionsPage());

async function saveLinkFromPopup(payload) {
  try {
    const result = await saveLink(payload);
    const tab = await currentTab();
    await showSaveToast(tab.id, result);
    setStatus(result.created ? "Saved" : "Already saved");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Save failed");
  }
}

async function getDetectedFeeds(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "riverbucket:feeds" });
  } catch {
    return { feeds: [] };
  }
}

async function openApp(path) {
  const { appUrl } = await getSettings();
  if (!appUrl) {
    chrome.runtime.openOptionsPage();
    return;
  }
  await chrome.tabs.create({ url: `${trimSlash(appUrl)}${path}` });
}

function setStatus(text) {
  statusNode.textContent = text;
}
