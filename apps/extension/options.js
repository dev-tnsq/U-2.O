const form = document.getElementById("settingsForm");
const collectorBaseUrl = document.getElementById("collectorBaseUrl");
const adminApiKey = document.getElementById("adminApiKey");
const deviceKey = document.getElementById("deviceKey");
const defaultUserId = document.getElementById("defaultUserId");
const status = document.getElementById("status");

function setStatus(msg) {
  status.textContent = msg;
}

async function loadSettings() {
  const data = await chrome.storage.sync.get([
    "collectorBaseUrl",
    "adminApiKey",
    "deviceKey",
    "defaultUserId"
  ]);

  collectorBaseUrl.value = data.collectorBaseUrl || "http://localhost:4040";
  adminApiKey.value = data.adminApiKey || "";
  deviceKey.value = data.deviceKey || "";
  defaultUserId.value = data.defaultUserId || "";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  await chrome.storage.sync.set({
    collectorBaseUrl: collectorBaseUrl.value.trim(),
    adminApiKey: adminApiKey.value.trim(),
    deviceKey: deviceKey.value.trim(),
    defaultUserId: defaultUserId.value.trim()
  });

  setStatus("Settings saved.");
});

loadSettings().catch((error) => {
  setStatus(error instanceof Error ? error.message : "Failed to load settings");
});
