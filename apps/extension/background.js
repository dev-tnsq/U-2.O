const DEFAULT_COLLECTOR_BASE_URL = "http://localhost:4040";

async function getSettings() {
  const data = await chrome.storage.sync.get([
    "collectorBaseUrl",
    "adminApiKey",
    "deviceKey",
    "defaultUserId"
  ]);

  return {
    collectorBaseUrl: data.collectorBaseUrl || DEFAULT_COLLECTOR_BASE_URL,
    adminApiKey: data.adminApiKey || "",
    deviceKey: data.deviceKey || "",
    defaultUserId: data.defaultUserId || ""
  };
}

function makeIdempotencyKey(prefix = "ext") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function submitCapture({ endpoint, payload, idempotencyPrefix }) {
  const settings = await getSettings();

  if (!settings.adminApiKey && !settings.deviceKey) {
    throw new Error("Configure admin API key or device key in extension options.");
  }

  const headers = {
    "content-type": "application/json",
    "x-idempotency-key": makeIdempotencyKey(idempotencyPrefix)
  };

  if (settings.deviceKey) {
    headers["x-u-device-key"] = settings.deviceKey;
  } else {
    headers["x-u-api-key"] = settings.adminApiKey;
  }

  const response = await fetch(`${settings.collectorBaseUrl}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Collector API error (${response.status}): ${text}`);
  }

  return response.json();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === "capture-url") {
      const settings = await getSettings();
      const payload = {
        userId: message.userId || settings.defaultUserId,
        url: message.url,
        sourceType: message.sourceType || "article"
      };
      const result = await submitCapture({
        endpoint: "/v1/collect/url",
        payload,
        idempotencyPrefix: "url"
      });
      sendResponse({ ok: true, result });
      return;
    }

    if (message.type === "capture-note") {
      const settings = await getSettings();
      const payload = {
        userId: message.userId || settings.defaultUserId,
        title: message.title,
        content: message.content
      };
      const result = await submitCapture({
        endpoint: "/v1/collect/note",
        payload,
        idempotencyPrefix: "note"
      });
      sendResponse({ ok: true, result });
      return;
    }

    if (message.type === "get-job-status") {
      const settings = await getSettings();
      const headers = {};
      if (settings.deviceKey) {
        headers["x-u-device-key"] = settings.deviceKey;
      } else {
        headers["x-u-api-key"] = settings.adminApiKey;
      }
      const response = await fetch(`${settings.collectorBaseUrl}/v1/jobs/${message.jobId}`, {
        headers
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Job status error (${response.status}): ${text}`);
      }
      const result = await response.json();
      sendResponse({ ok: true, result });
      return;
    }

    sendResponse({ ok: false, error: "unknown message type" });
  })().catch((error) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : "unknown error" });
  });

  return true;
});
