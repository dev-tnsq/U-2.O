const userIdInput = document.getElementById("userId");
const sourceTypeSelect = document.getElementById("sourceType");
const saveTabButton = document.getElementById("saveTabButton");
const noteTitleInput = document.getElementById("noteTitle");
const noteContentInput = document.getElementById("noteContent");
const saveNoteButton = document.getElementById("saveNoteButton");
const jobIdInput = document.getElementById("jobId");
const checkJobButton = document.getElementById("checkJobButton");
const statusBox = document.getElementById("status");

function setStatus(value) {
  statusBox.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

async function getCurrentTabUrl() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.url;
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response));
  });
}

saveTabButton.addEventListener("click", async () => {
  try {
    const url = await getCurrentTabUrl();
    if (!url) {
      setStatus("No active tab URL found.");
      return;
    }

    const response = await sendMessage({
      type: "capture-url",
      userId: userIdInput.value.trim(),
      sourceType: sourceTypeSelect.value,
      url
    });

    if (!response?.ok) {
      setStatus(response?.error || "Unknown error");
      return;
    }

    setStatus(response.result);
    if (response.result?.jobId) {
      jobIdInput.value = response.result.jobId;
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unknown error");
  }
});

saveNoteButton.addEventListener("click", async () => {
  try {
    const title = noteTitleInput.value.trim();
    const content = noteContentInput.value.trim();

    if (!title || !content) {
      setStatus("Note title and content are required.");
      return;
    }

    const response = await sendMessage({
      type: "capture-note",
      userId: userIdInput.value.trim(),
      title,
      content
    });

    if (!response?.ok) {
      setStatus(response?.error || "Unknown error");
      return;
    }

    setStatus(response.result);
    if (response.result?.jobId) {
      jobIdInput.value = response.result.jobId;
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unknown error");
  }
});

checkJobButton.addEventListener("click", async () => {
  try {
    const jobId = jobIdInput.value.trim();
    if (!jobId) {
      setStatus("Job ID is required.");
      return;
    }

    const response = await sendMessage({ type: "get-job-status", jobId });
    if (!response?.ok) {
      setStatus(response?.error || "Unknown error");
      return;
    }

    setStatus(response.result);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unknown error");
  }
});
