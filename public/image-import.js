const fileInput = document.getElementById("fileInput");
const uploadBtn = document.getElementById("uploadBtn");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");

uploadBtn.addEventListener("click", async () => {
  const files = Array.from(fileInput.files || []);

  if (!files.length) {
    statusEl.textContent = "Select JPEG files first.";
    return;
  }

  statusEl.textContent = "Uploading...";
  logEl.textContent = "";

  const form = new FormData();

  files.forEach(f => {
    form.append("files", f, f.name);
  });

  try {
    const res = await fetch("/api/image-import", {
      method: "POST",
      body: form
    });

    const json = await res.json();

    if (!res.ok || !json.ok) {
      statusEl.textContent = json.error || "Error during upload.";
      return;
    }

    statusEl.textContent = `Done. Processed ${json.count} file(s).`;

    logEl.textContent = json.results
      .map(r => JSON.stringify(r, null, 2))
      .join("\n\n");

  } catch (err) {
    statusEl.textContent = "Upload failed.";
    logEl.textContent = String(err);
  }
});