import { saveLink, showSaveToast, showToast } from "./shared.js";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "save-page",
    title: "Save page to Riverbucket",
    contexts: ["page"]
  });
  chrome.contextMenus.create({
    id: "save-link",
    title: "Save link to Riverbucket",
    contexts: ["link"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.url) return;
  try {
    if (info.menuItemId === "save-page") {
      const result = await saveLink({
        url: tab.url,
        title: tab.title || tab.url,
        source_page_url: tab.url,
        source_page_title: tab.title || ""
      });
      await showSaveToast(tab.id, result);
    }
    if (info.menuItemId === "save-link" && info.linkUrl) {
      const result = await saveLink({
        url: info.linkUrl,
        source_page_url: tab.url,
        source_page_title: tab.title || "",
        link_text: info.selectionText || ""
      });
      await showSaveToast(tab.id, result);
    }
  } catch (error) {
    await showToast(tab.id, {
      kind: "error",
      title: "Riverbucket",
      text: error instanceof Error ? error.message : "Save failed"
    });
  }
});
