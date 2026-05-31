import { getSettings, saveSettings } from "./shared.js";

const fields = {
  appUrl: document.querySelector("#appUrl"),
  token: document.querySelector("#token"),
  defaultTag: document.querySelector("#defaultTag")
};
const statusNode = document.querySelector("#status");

getSettings().then((values) => {
  fields.appUrl.value = values.appUrl || "";
  fields.token.value = values.token || "";
  fields.defaultTag.value = values.defaultTag || "";
});

document.querySelector("#save").addEventListener("click", async () => {
  await saveSettings({
    appUrl: fields.appUrl.value,
    token: fields.token.value,
    defaultTag: fields.defaultTag.value
  });
  statusNode.textContent = "Saved.";
});
