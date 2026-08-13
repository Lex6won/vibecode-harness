const RELEASE_INDEX = "./releases/release-index.json";

const elements = {
  badge: document.querySelector("#environment-badge"),
  status: document.querySelector("#release-status"),
  message: document.querySelector("#release-message"),
  refresh: document.querySelector("#refresh-release"),
  download: document.querySelector("#download-link"),
  detail: document.querySelector("#installer-detail"),
  guide: document.querySelector("#guide-link"),
  repository: document.querySelector("#repository-link")
};

function setDownloadUnavailable(text) {
  elements.download.textContent = "설치 파일 준비 중";
  elements.download.classList.add("is-disabled");
  elements.download.setAttribute("aria-disabled", "true");
  elements.download.removeAttribute("download");
  elements.download.href = "#";
  elements.detail.textContent = text;
}

function renderRelease(index) {
  elements.badge.textContent = index.environment === "production" ? "운영" : "시범 운영";
  elements.message.textContent = index.message || "승인된 설치 파일 정보를 확인하세요.";
  elements.guide.href = index.support?.installation_guide || elements.guide.href;
  elements.repository.href = index.support?.repository_url || elements.repository.href;

  const installer = index.installer;
  const ready = index.status === "installer_published"
    && installer?.download_url
    && /^[a-f0-9]{64}$/i.test(installer.sha256 || "")
    && installer.signature_status === "authenticode_verified";

  if (!ready) {
    elements.status.textContent = "공식 설치 파일 준비 중";
    setDownloadUnavailable("승인된 설치 파일과 SHA-256, Authenticode 확인값이 등록된 경우에만 다운로드할 수 있습니다.");
    return;
  }

  elements.status.textContent = "설치 파일 사용 가능";
  elements.download.textContent = "Windows 설치 파일 받기";
  elements.download.classList.remove("is-disabled");
  elements.download.removeAttribute("aria-disabled");
  elements.download.href = installer.download_url;
  elements.download.download = "";
  elements.detail.textContent = `버전 ${installer.version} · SHA-256 ${installer.sha256} · 코드서명 확인됨`;
}

async function loadRelease() {
  elements.refresh.disabled = true;
  elements.refresh.textContent = "확인 중";
  try {
    const response = await fetch(`${RELEASE_INDEX}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error("release index unavailable");
    renderRelease(await response.json());
  } catch {
    elements.status.textContent = "설치 상태를 확인할 수 없음";
    elements.message.textContent = "네트워크 또는 배포 설정을 확인한 뒤 다시 시도하세요.";
    setDownloadUnavailable("상태를 확인할 수 없는 경우 설치 파일을 제공하지 않습니다.");
  } finally {
    elements.refresh.disabled = false;
    elements.refresh.textContent = "상태 새로 고침";
  }
}

elements.refresh.addEventListener("click", loadRelease);
loadRelease();
