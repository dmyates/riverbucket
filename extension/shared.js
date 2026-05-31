export async function getSettings() {
  const [synced, local] = await Promise.all([
    chrome.storage.sync.get(["appUrl", "defaultTag", "token"]),
    chrome.storage.local.get(["token"])
  ]);
  if (!local.token && synced.token) {
    await chrome.storage.local.set({ token: synced.token });
    await chrome.storage.sync.remove("token");
    local.token = synced.token;
  }
  return {
    appUrl: synced.appUrl || "",
    defaultTag: synced.defaultTag || "",
    token: local.token || ""
  };
}

export async function saveSettings({ appUrl, token, defaultTag }) {
  await Promise.all([
    chrome.storage.sync.set({ appUrl: appUrl.trim(), defaultTag: defaultTag.trim() }),
    chrome.storage.local.set({ token: token.trim() })
  ]);
  await chrome.storage.sync.remove("token");
}

export async function extensionApi(path, payload) {
  const { appUrl, token } = await getSettings();
  if (!appUrl || !token) {
    chrome.runtime.openOptionsPage();
    throw new Error("Set App URL and token in Options.");
  }
  const response = await fetch(`${trimSlash(appUrl)}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

export async function saveLink(payload) {
  const { defaultTag } = await getSettings();
  const tags = defaultTag ? [defaultTag] : [];
  return extensionApi("/api/extension/save-link", { ...payload, tags });
}

export async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

export async function showSaveToast(tabId, result) {
  await showToast(tabId, {
    kind: result.created ? "success" : "duplicate",
    title: "Riverbucket",
    text: result.created ? "Added to bucket" : "Already in bucket"
  });
}

export async function showToast(tabId, payload) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "riverbucket:toast", ...payload });
  } catch {
    // Some browser pages cannot receive extension content-script messages.
  }
}

export function trimSlash(value) {
  return value.replace(/\/+$/, "");
}
