const RELEASE_INDEX = "./releases/release-index.json";

const elements = {
  badge: document.querySelector("#environment-badge"),
  status: document.querySelector("#release-status"),
  message: document.querySelector("#release-message"),
  refresh: document.querySelector("#refresh-release"),
  download: document.querySelector("#download-link"),
  detail: document.querySelector("#installer-detail"),
  guide: document.querySelector("#guide-link"),
  repository: document.querySelector("#repository-link"),
  supportedTools: document.querySelector("#supported-tools"),
  projectSetup: document.querySelector("#project-setup"),
  updatePolicy: document.querySelector("#update-policy")
};

const TOOL_LABELS = {
  codex: "Codex",
  "claude-code": "Claude Code",
  "google-antigravity": "Google Antigravity",
  "claude-desktop": "Claude Desktop (Git gate)",
  "chatgpt-codex-desktop": "ChatGPT/Codex Desktop (Git gate)",
  "lovable-github": "Lovable + GitHub PR gate"
};

function setDownloadUnavailable(text) {
  elements.download.textContent = "Installer unavailable";
  elements.download.classList.add("is-disabled");
  elements.download.setAttribute("aria-disabled", "true");
  elements.download.removeAttribute("download");
  elements.download.href = "#";
  elements.detail.textContent = text;
}

function renderRelease(index) {
  elements.badge.textContent = index.environment === "production" ? "Production" : "Demonstration";
  elements.message.textContent = index.message || "Check the installer status.";
  elements.guide.href = index.support?.installation_guide || elements.guide.href;
  elements.repository.href = index.support?.repository_url || elements.repository.href;
  const capabilities = index.capabilities || {};
  const tools = Array.isArray(capabilities.supported_tools) ? capabilities.supported_tools : [];
  elements.supportedTools.textContent = tools.length
    ? `Supported: ${tools.map((tool) => TOOL_LABELS[tool] || tool).join(", ")}`
    : "Supported tool information is not available.";
  elements.projectSetup.textContent = capabilities.project_setup || "Project setup information is not available.";
  elements.updatePolicy.textContent = capabilities.update_policy || "Update policy information is not available.";

  const installer = index.installer;
  const officialReady = index.status === "installer_published"
    && installer?.download_url
    && /^[a-f0-9]{64}$/i.test(installer.sha256 || "")
    && installer.signature_status === "authenticode_verified";
  const demonstrationReady = index.status === "demo_installer_published"
    && installer?.download_url
    && /^[a-f0-9]{64}$/i.test(installer.sha256 || "")
    && installer.signature_status === "pem_bundle_verified_unsigned_demo";

  if (!officialReady && !demonstrationReady) {
    elements.status.textContent = "Official installer unavailable";
    setDownloadUnavailable("Download is enabled only after signed installer metadata is registered.");
    return;
  }

  elements.status.textContent = officialReady ? "Signed installer available" : "Unsigned demonstration installer available";
  elements.download.textContent = officialReady ? "Download Windows installer" : "Download unsigned demonstration EXE";
  elements.download.classList.remove("is-disabled");
  elements.download.removeAttribute("aria-disabled");
  elements.download.href = installer.download_url;
  elements.download.download = "";
  elements.detail.textContent = officialReady
    ? `Version ${installer.version}; SHA-256 ${installer.sha256}; Authenticode verified.`
    : `Demonstration only; PEM bundle verified, EXE intentionally unsigned. SHA-256 ${installer.sha256}`;
}

async function loadRelease() {
  elements.refresh.disabled = true;
  try {
    const response = await fetch(`${RELEASE_INDEX}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error("release index unavailable");
    renderRelease(await response.json());
  } catch {
    elements.status.textContent = "Unable to check installer status";
    elements.message.textContent = "Check network and deployment settings, then try again.";
    setDownloadUnavailable("The release state could not be verified.");
  } finally {
    elements.refresh.disabled = false;
  }
}

elements.refresh.addEventListener("click", loadRelease);
loadRelease();
