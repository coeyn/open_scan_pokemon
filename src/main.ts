import './style.css';
import {
  attachStream,
  cameraApisAvailable,
  cameraContextAllowed,
  type CameraDevice,
  type CameraStatus,
  describeCameraError,
  getActiveDeviceId,
  getCameraStream,
  getStoredPreferredCameraId,
  listCameraDevices,
  stopMediaStream,
  storePreferredCameraId,
} from './camera';
import {
  type CardLanguage,
  type OcrResultSummary,
  type OcrStatus,
  recognizeCanvas,
  setOcrProgressListener,
  terminateOcrWorker,
  warmupOcr,
} from './ocr';

type AppState = {
  activeDeviceId: string;
  currentStream: MediaStream | null;
  devices: CameraDevice[];
  isBusy: boolean;
  lastOcrResult: OcrResultSummary | null;
  ocrBusy: boolean;
  ocrLanguageReady: CardLanguage | null;
  ocrMessage: string;
  ocrProgress: number;
  ocrSnapshotUrl: string;
  ocrStatus: OcrStatus;
  selectedCardLanguage: CardLanguage;
  status: CameraStatus;
};

const statusLabels: Record<CameraStatus, string> = {
  denied: 'Bloquee',
  error: 'Erreur',
  idle: 'En attente',
  ready: 'Active',
  requesting: 'Ouverture',
  unavailable: 'Indispo',
};

const defaultMessages: Record<CameraStatus, string> = {
  denied:
    'Autorise la camera pour voir le flux et choisir le capteur le plus adapte.',
  error: 'Le flux camera ne peut pas etre lance pour le moment.',
  idle: 'Preparation du scan web. Le flux camera va se lancer automatiquement.',
  ready: 'Camera active. Cadre la carte dans le gabarit pour preparer la suite.',
  requesting: 'Le navigateur demande l acces a la camera en cours.',
  unavailable:
    'Aucune camera exploitable n a ete detectee ou le contexte n est pas securise.',
};

const ocrStatusLabels: Record<OcrStatus, string> = {
  done: 'Lecture faite',
  error: 'OCR en erreur',
  idle: 'OCR en veille',
  loading: 'Modele OCR',
  ready: 'OCR pret',
  scanning: 'Lecture OCR',
};

const cardLanguageStorageKey = 'preferredCardLanguage';
const cardLanguageOptions: Array<{ label: string; value: CardLanguage }> = [
  { label: 'Francais', value: 'fra' },
  { label: 'Anglais', value: 'eng' },
  { label: 'Mixte FR + EN', value: 'eng+fra' },
];

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="app-shell">
    <div class="ambient ambient-left" aria-hidden="true"></div>
    <div class="ambient ambient-right" aria-hidden="true"></div>

    <header class="hero-card">
      <p class="eyebrow">open source / scan web / beta camera</p>
      <div class="hero-copy">
        <p class="kicker">Lecture OCR</p>
        <h1>Cadre une carte et inspecte tout le texte que la camera comprend.</h1>
        <p class="intro">
          Ce lot ajoute une analyse OCR du cadre courant pour verifier ce qui est
          bien lu avant d identifier la carte de facon fiable.
        </p>
      </div>
    </header>

    <main class="scanner-grid">
      <section class="viewer-panel">
        <div class="panel-head">
          <div>
            <p class="panel-label">Zone de scan</p>
            <h2>Apercu camera</h2>
          </div>
          <span id="camera-state" class="status-pill" data-status="idle">En attente</span>
        </div>

        <div id="video-shell" class="video-shell" data-stream="off">
          <video
            id="camera-preview"
            autoplay
            muted
            playsinline
            aria-label="Apercu camera en direct"
          ></video>
          <p class="video-fallback">
            Le flux camera apparaitra ici des qu une camera compatible sera
            ouverte.
          </p>
          <div class="scan-frame" aria-hidden="true">
            <span class="frame-corner corner-top-left"></span>
            <span class="frame-corner corner-top-right"></span>
            <span class="frame-corner corner-bottom-left"></span>
            <span class="frame-corner corner-bottom-right"></span>
            <div class="frame-copy">Centre la carte dans le cadre puis lance la lecture</div>
          </div>
        </div>
      </section>

      <aside class="control-panel">
        <p class="panel-label">Pilotage</p>
        <h2>Camera et OCR</h2>
        <p id="camera-message" class="status-message">
          Preparation du flux video.
        </p>

        <label class="field" for="camera-select">
          <span>Camera disponible</span>
          <div class="select-shell">
            <select id="camera-select" name="camera-select" disabled>
              <option>Detection en cours...</option>
            </select>
          </div>
        </label>

        <label class="field" for="language-select">
          <span>Langue de la carte</span>
          <div class="select-shell">
            <select id="language-select" name="language-select">
              ${cardLanguageOptions
                .map(
                  (option) =>
                    `<option value="${option.value}">${option.label}</option>`,
                )
                .join('')}
            </select>
          </div>
        </label>

        <div class="button-stack">
          <button id="camera-refresh" class="action-button" type="button">
            Activer la camera
          </button>
          <button id="ocr-scan" class="secondary-button" type="button">
            Lire le texte du cadre
          </button>
        </div>

        <section class="tips" aria-label="Infos de fonctionnement">
          <p class="tips-title">Notes utiles</p>
          <ul>
            <li>La premiere lecture OCR telecharge le modele de langue puis le met en cache.</li>
            <li>Cette etape lit tout le texte du cadre, pas seulement les infos utiles.</li>
            <li>Une photo nette et bien cadree fera une enorme difference sur la suite.</li>
          </ul>
        </section>
      </aside>

      <section class="results-panel">
        <div class="results-head">
          <div>
            <p class="panel-label">Diagnostic OCR</p>
            <h2>Texte detecte dans le cadre</h2>
          </div>
          <span id="ocr-state" class="status-pill ocr-pill" data-ocr-status="idle">OCR en veille</span>
        </div>

        <p id="ocr-message" class="status-message">
          Charge le modele OCR puis analyse le cadre pour afficher toutes les lignes detectees.
        </p>

        <div class="progress-shell" aria-hidden="true">
          <div id="ocr-progress-bar" class="progress-bar" style="width: 0%"></div>
        </div>

        <div class="ocr-grid">
          <section class="snapshot-card">
            <p class="panel-label">Capture analysee</p>
            <img id="ocr-snapshot" class="snapshot-image" alt="Capture OCR la plus recente" />
            <div id="ocr-snapshot-empty" class="snapshot-empty">
              La capture analysee apparaitra ici apres une lecture OCR.
            </div>
          </section>

          <section class="results-card">
            <div class="results-block">
              <div class="results-subhead">
                <p class="panel-label">Signaux reperes</p>
                <span id="ocr-confidence" class="confidence-badge">Confiance 0%</span>
              </div>
              <ul id="ocr-signals" class="signal-list">
                <li class="empty-item">Aucune information OCR pour le moment.</li>
              </ul>
            </div>

            <div class="results-block">
              <p class="panel-label">Zones precises</p>
              <div id="ocr-zones" class="zone-grid">
                <article class="zone-card zone-empty">
                  <p class="empty-item">Les zones OCR apparaitront ici.</p>
                </article>
              </div>
            </div>

            <div class="results-block">
              <p class="panel-label">Candidats numero</p>
              <ul id="ocr-collector-candidates" class="candidate-list">
                <li class="empty-item">Les candidats de numero apparaitront ici.</li>
              </ul>
            </div>

            <div class="results-block">
              <p class="panel-label">Texte brut</p>
              <pre id="ocr-raw-text" class="raw-text">Aucune lecture lancee.</pre>
            </div>

            <div class="results-block">
              <p class="panel-label">Lignes detectees</p>
              <ul id="ocr-lines" class="result-list">
                <li class="empty-item">Les lignes OCR apparaitront ici.</li>
              </ul>
            </div>

            <div class="results-block">
              <p class="panel-label">Mots reconnus</p>
              <div id="ocr-words" class="word-cloud">
                <span class="empty-item chip-empty">Les mots OCR apparaitront ici.</span>
              </div>
            </div>
          </section>
        </div>
      </section>
    </main>
  </div>
`;

const videoElement = getRequiredElement<HTMLVideoElement>('#camera-preview');
const videoShell = getRequiredElement<HTMLDivElement>('#video-shell');
const cameraState = getRequiredElement<HTMLSpanElement>('#camera-state');
const cameraMessage = getRequiredElement<HTMLParagraphElement>('#camera-message');
const cameraSelect = getRequiredElement<HTMLSelectElement>('#camera-select');
const languageSelect = getRequiredElement<HTMLSelectElement>('#language-select');
const cameraRefresh = getRequiredElement<HTMLButtonElement>('#camera-refresh');
const ocrScanButton = getRequiredElement<HTMLButtonElement>('#ocr-scan');
const ocrStateLabel = getRequiredElement<HTMLSpanElement>('#ocr-state');
const ocrMessage = getRequiredElement<HTMLParagraphElement>('#ocr-message');
const ocrProgressBar = getRequiredElement<HTMLDivElement>('#ocr-progress-bar');
const ocrSnapshot = getRequiredElement<HTMLImageElement>('#ocr-snapshot');
const ocrSnapshotEmpty = getRequiredElement<HTMLDivElement>('#ocr-snapshot-empty');
const ocrConfidence = getRequiredElement<HTMLSpanElement>('#ocr-confidence');
const ocrSignals = getRequiredElement<HTMLUListElement>('#ocr-signals');
const ocrZones = getRequiredElement<HTMLDivElement>('#ocr-zones');
const ocrCollectorCandidates = getRequiredElement<HTMLUListElement>(
  '#ocr-collector-candidates',
);
const ocrRawText = getRequiredElement<HTMLElement>('#ocr-raw-text');
const ocrLines = getRequiredElement<HTMLUListElement>('#ocr-lines');
const ocrWords = getRequiredElement<HTMLDivElement>('#ocr-words');

const state: AppState = {
  activeDeviceId: '',
  currentStream: null,
  devices: [],
  isBusy: false,
  lastOcrResult: null,
  ocrBusy: false,
  ocrLanguageReady: null,
  ocrMessage:
    'Charge le modele OCR puis analyse le cadre pour afficher toutes les lignes detectees.',
  ocrProgress: 0,
  ocrSnapshotUrl: '',
  ocrStatus: 'idle',
  selectedCardLanguage: getStoredCardLanguage(),
  status: 'idle',
};

languageSelect.value = state.selectedCardLanguage;

setOcrProgressListener((message) => {
  state.ocrProgress = Math.max(0, Math.min(100, Math.round(message.progress * 100)));
  state.ocrMessage = translateOcrProgress(message.status);
  renderOcrState();
});

function getRequiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }

  return element;
}

function setStatus(status: CameraStatus, message?: string): void {
  state.status = status;
  cameraState.dataset.status = status;
  cameraState.textContent = statusLabels[status];
  cameraMessage.textContent = message ?? defaultMessages[status];
  syncControls();
}

function setStreamPresence(hasStream: boolean): void {
  videoShell.dataset.stream = hasStream ? 'on' : 'off';
}

function syncControls(): void {
  cameraRefresh.disabled = state.isBusy;
  cameraSelect.disabled = state.isBusy || state.devices.length === 0;
  languageSelect.disabled = state.ocrBusy;
  ocrScanButton.disabled = state.ocrBusy || state.status !== 'ready';
  cameraRefresh.textContent = state.isBusy
    ? 'Ouverture en cours...'
    : state.status === 'ready'
      ? 'Relancer la camera'
      : 'Activer la camera';
  ocrScanButton.textContent = state.ocrBusy
    ? 'Lecture OCR en cours...'
    : 'Lire le texte du cadre';
}

function renderCameraOptions(
  devices: CameraDevice[],
  activeDeviceId: string,
): void {
  state.devices = devices;
  state.activeDeviceId = activeDeviceId;

  cameraSelect.innerHTML = '';

  if (devices.length === 0) {
    cameraSelect.add(new Option('Aucune camera detectee', '', true, true));
    return;
  }

  devices.forEach((device, index) => {
    const label = device.label || `Camera ${index + 1}`;
    cameraSelect.add(
      new Option(label, device.deviceId, false, device.deviceId === activeDeviceId),
    );
  });

  if (!activeDeviceId && devices[0]) {
    cameraSelect.value = devices[0].deviceId;
    state.activeDeviceId = devices[0].deviceId;
  }
}

function renderOcrState(): void {
  ocrStateLabel.dataset.ocrStatus = state.ocrStatus;
  ocrStateLabel.textContent = ocrStatusLabels[state.ocrStatus];
  ocrMessage.textContent = state.ocrMessage;
  ocrProgressBar.style.width = `${state.ocrProgress}%`;

  if (state.ocrSnapshotUrl) {
    ocrSnapshot.src = state.ocrSnapshotUrl;
    ocrSnapshot.hidden = false;
    ocrSnapshotEmpty.hidden = true;
  } else {
    ocrSnapshot.removeAttribute('src');
    ocrSnapshot.hidden = true;
    ocrSnapshotEmpty.hidden = false;
  }

  const result = state.lastOcrResult;

  if (!result) {
    ocrConfidence.textContent = 'Confiance 0%';
    ocrSignals.innerHTML =
      '<li class="empty-item">Aucune information OCR pour le moment.</li>';
    ocrZones.innerHTML = `
      <article class="zone-card zone-empty">
        <p class="empty-item">Les zones OCR apparaitront ici.</p>
      </article>
    `;
    ocrCollectorCandidates.innerHTML =
      '<li class="empty-item">Les candidats de numero apparaitront ici.</li>';
    ocrRawText.textContent = 'Aucune lecture lancee.';
    ocrLines.innerHTML =
      '<li class="empty-item">Les lignes OCR apparaitront ici.</li>';
    ocrWords.innerHTML =
      '<span class="empty-item chip-empty">Les mots OCR apparaitront ici.</span>';
    syncControls();
    return;
  }

  ocrConfidence.textContent = `Confiance ${Math.round(result.averageConfidence)}%`;
  ocrSignals.innerHTML =
    result.signals.length > 0
      ? result.signals
          .map(
            (signal) => `
              <li class="signal-item">
                <span class="signal-label">${escapeHtml(signal.label)}</span>
                <strong>${escapeHtml(signal.value)}</strong>
                <span class="signal-meta">${Math.round(signal.confidence)}%</span>
              </li>
            `,
          )
          .join('')
      : '<li class="empty-item">Aucun signal clair n a ete repere dans cette lecture.</li>';
  ocrZones.innerHTML =
    result.zones.length > 0
      ? result.zones
          .map(
            (zone) => `
              <article class="zone-card">
                <div class="zone-head">
                  <span class="zone-title">${escapeHtml(zone.label)}</span>
                  <span class="zone-confidence">${Math.round(zone.confidence)}%</span>
                </div>
                ${
                  zone.debugImageUrl
                    ? `<img class="zone-image" src="${zone.debugImageUrl}" alt="Zone ${escapeHtml(zone.label)}" />`
                    : `<div class="zone-image zone-image-empty">Pas d image</div>`
                }
                <p class="zone-debug">${escapeHtml(zone.debugLabel || 'zone OCR')}</p>
                <p class="zone-text">${escapeHtml(zone.text || 'Aucune lecture exploitable')}</p>
              </article>
            `,
          )
          .join('')
      : `
        <article class="zone-card zone-empty">
          <p class="empty-item">Les zones OCR apparaitront ici.</p>
        </article>
      `;
  ocrCollectorCandidates.innerHTML =
    result.collectorNumberCandidates.length > 0
      ? result.collectorNumberCandidates
          .map(
            (candidate) => `
              <li class="candidate-item">
                <strong>${escapeHtml(candidate.value)}</strong>
                <span class="candidate-meta">${Math.round(candidate.confidence)}% · ${escapeHtml(candidate.source)}</span>
              </li>
            `,
          )
          .join('')
      : '<li class="empty-item">Aucun candidat solide pour le numero de carte.</li>';
  ocrRawText.textContent = result.rawText || 'Aucun texte brut n a ete remonte.';
  ocrLines.innerHTML =
    result.lines.length > 0
      ? result.lines
          .map(
            (line) => `
              <li class="result-item">
                <span class="result-text">${escapeHtml(line.text)}</span>
                <span class="result-confidence">${Math.round(line.confidence)}%</span>
              </li>
            `,
          )
          .join('')
      : '<li class="empty-item">Aucune ligne OCR exploitable.</li>';
  ocrWords.innerHTML =
    result.words.length > 0
      ? result.words
          .map(
            (word) => `
              <span class="word-chip" title="Confiance ${Math.round(word.confidence)}%">
                ${escapeHtml(word.text)}
              </span>
            `,
          )
          .join('')
      : '<span class="empty-item chip-empty">Aucun mot OCR exploitable.</span>';
  syncControls();
}

function setOcrStatus(status: OcrStatus, message: string, progress?: number): void {
  state.ocrStatus = status;
  state.ocrMessage = message;

  if (typeof progress === 'number') {
    state.ocrProgress = progress;
  }

  renderOcrState();
}

function getStoredCardLanguage(): CardLanguage {
  try {
    const storedValue = window.localStorage.getItem(cardLanguageStorageKey);

    if (
      storedValue === 'fra' ||
      storedValue === 'eng' ||
      storedValue === 'eng+fra'
    ) {
      return storedValue;
    }
  } catch {
    // Ignore local storage failures and fall back to French.
  }

  return 'fra';
}

function storeCardLanguage(language: CardLanguage): void {
  try {
    window.localStorage.setItem(cardLanguageStorageKey, language);
  } catch {
    // Ignore local storage failures and keep the UI working.
  }
}

function getCardLanguageLabel(language: CardLanguage): string {
  return (
    cardLanguageOptions.find((option) => option.value === language)?.label ??
    'Francais'
  );
}

function resolveActiveDeviceId(
  stream: MediaStream | null,
  devices: CameraDevice[],
  requestedDeviceId?: string,
): string {
  const liveDeviceId = getActiveDeviceId(stream);

  if (liveDeviceId && devices.some((device) => device.deviceId === liveDeviceId)) {
    return liveDeviceId;
  }

  if (
    requestedDeviceId &&
    devices.some((device) => device.deviceId === requestedDeviceId)
  ) {
    return requestedDeviceId;
  }

  return devices[0]?.deviceId ?? '';
}

async function safeListDevices(): Promise<CameraDevice[]> {
  try {
    return await listCameraDevices();
  } catch {
    return [];
  }
}

function explainUnavailableContext(): string {
  if (!cameraApisAvailable()) {
    return 'Ce navigateur ne prend pas en charge l acces camera requis par l application.';
  }

  return 'La camera web demande un contexte securise. Utilise localhost en dev ou GitHub Pages en HTTPS.';
}

function watchTrackEnd(stream: MediaStream): void {
  stream.getVideoTracks().forEach((track) => {
    track.addEventListener(
      'ended',
      () => {
        if (state.currentStream !== stream) {
          return;
        }

        setStreamPresence(false);
        setStatus(
          'error',
          'Le flux video s est arrete. Relance la camera pour reprendre le scan.',
        );
        void refreshDeviceList();
      },
      { once: true },
    );
  });
}

async function maybeWarmupOcr(): Promise<void> {
  if (state.ocrLanguageReady === state.selectedCardLanguage) {
    return;
  }

  setOcrStatus(
    'loading',
    `Chargement du modele OCR ${getCardLanguageLabel(state.selectedCardLanguage).toLowerCase()}. La premiere lecture peut prendre un peu de temps.`,
    0,
  );

  try {
    await warmupOcr(state.selectedCardLanguage);
    state.ocrLanguageReady = state.selectedCardLanguage;
    setOcrStatus(
      'ready',
      `Modele OCR ${getCardLanguageLabel(state.selectedCardLanguage).toLowerCase()} pret. Lance une lecture du cadre pour afficher tout le texte detecte.`,
      100,
    );
  } catch {
    state.ocrLanguageReady = null;
    setOcrStatus(
      'error',
      'Le modele OCR n a pas pu etre charge. Verifie le reseau puis reessaie.',
      0,
    );
  }
}

async function startCamera(requestedDeviceId?: string): Promise<void> {
  if (!cameraApisAvailable() || !cameraContextAllowed()) {
    stopMediaStream(state.currentStream);
    state.currentStream = null;
    renderCameraOptions([], '');
    setStreamPresence(false);
    setStatus('unavailable', explainUnavailableContext());
    return;
  }

  state.isBusy = true;
  setStatus('requesting');
  stopMediaStream(state.currentStream);
  state.currentStream = null;
  setStreamPresence(false);

  const preferredDeviceId =
    requestedDeviceId ?? getStoredPreferredCameraId() ?? undefined;

  try {
    const stream = await getCameraStream(preferredDeviceId);
    state.currentStream = stream;
    await attachStream(videoElement, stream);

    const devices = await safeListDevices();
    const activeDeviceId = resolveActiveDeviceId(
      stream,
      devices,
      preferredDeviceId,
    );

    renderCameraOptions(devices, activeDeviceId);
    storePreferredCameraId(activeDeviceId);
    setStreamPresence(true);
    setStatus('ready');
    watchTrackEnd(stream);
    void maybeWarmupOcr();
  } catch (error) {
    const devices = await safeListDevices();
    const fallbackDeviceId =
      devices.find((device) => device.deviceId === preferredDeviceId)?.deviceId ?? '';

    renderCameraOptions(devices, fallbackDeviceId);
    setStreamPresence(false);

    const handledError = describeCameraError(error);
    setStatus(handledError.status, handledError.message);
  } finally {
    state.isBusy = false;
    syncControls();
  }
}

async function refreshDeviceList(): Promise<void> {
  const devices = await safeListDevices();
  const activeDeviceId = resolveActiveDeviceId(
    state.currentStream,
    devices,
    state.activeDeviceId,
  );

  renderCameraOptions(devices, activeDeviceId);
  syncControls();
}

async function scanCurrentFrame(): Promise<void> {
  if (state.status !== 'ready' || !state.currentStream) {
    setOcrStatus(
      'error',
      'La camera doit etre active avant de lancer une lecture OCR.',
      0,
    );
    return;
  }

  if (videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    setOcrStatus(
      'error',
      'Le flux video n est pas encore pret. Attends une seconde puis relance la lecture.',
      0,
    );
    return;
  }

  const canvas = captureVideoFrame(videoElement);

  if (!canvas) {
    setOcrStatus(
      'error',
      'Impossible de capturer une image du flux video pour l OCR.',
      0,
    );
    return;
  }

  state.ocrBusy = true;
  state.ocrProgress = 0;
  setOcrStatus(
    state.ocrLanguageReady === state.selectedCardLanguage ? 'scanning' : 'loading',
    'Preparation de la capture OCR.',
    0,
  );

  try {
    await maybeWarmupOcr();
    state.ocrStatus = 'scanning';
    state.ocrMessage =
      'Lecture du texte en cours. La premiere carte peut prendre plus de temps.';
    state.ocrProgress = 0;
    renderOcrState();

    const snapshotUrl = canvas.toDataURL('image/jpeg', 0.92);
    const result = await recognizeCanvas(canvas, state.selectedCardLanguage);

    state.lastOcrResult = result;
    state.ocrSnapshotUrl = result.debugImageUrl || snapshotUrl;
    state.ocrProgress = 100;
    setOcrStatus(
      'done',
      result.rawText
        ? `Lecture terminee via ${result.debugLabel}: ${result.lines.length} ligne(s), ${result.words.length} mot(s) et numero ${result.collectorNumber || 'non verrouille'}.`
        : 'Lecture terminee mais aucun texte exploitable n a ete remonte.',
      100,
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? `OCR indisponible: ${error.message}`
        : 'OCR indisponible pour le moment.';

    setOcrStatus('error', message, 0);
  } finally {
    state.ocrBusy = false;
    syncControls();
  }
}

function captureVideoFrame(video: HTMLVideoElement): HTMLCanvasElement | null {
  const width = video.videoWidth;
  const height = video.videoHeight;

  if (!width || !height) {
    return null;
  }

  const cropBounds = getScanCropBounds(width, height);
  const longestEdge = Math.max(cropBounds.width, cropBounds.height);
  const scale = longestEdge > 1600 ? 1600 / longestEdge : 1;
  const targetWidth = Math.max(1, Math.round(cropBounds.width * scale));
  const targetHeight = Math.max(1, Math.round(cropBounds.height * scale));
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  if (!context) {
    return null;
  }

  canvas.width = targetWidth;
  canvas.height = targetHeight;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    video,
    cropBounds.left,
    cropBounds.top,
    cropBounds.width,
    cropBounds.height,
    0,
    0,
    targetWidth,
    targetHeight,
  );

  return canvas;
}

function getScanCropBounds(
  width: number,
  height: number,
): { height: number; left: number; top: number; width: number } {
  const ratio = 5 / 7;
  const maxWidth = width * 0.9;
  const maxHeight = height * 0.9;
  let cropWidth = maxWidth;
  let cropHeight = cropWidth / ratio;

  if (cropHeight > maxHeight) {
    cropHeight = maxHeight;
    cropWidth = cropHeight * ratio;
  }

  return {
    height: cropHeight,
    left: (width - cropWidth) / 2,
    top: (height - cropHeight) / 2,
    width: cropWidth,
  };
}

function translateOcrProgress(status: string): string {
  const normalized = status.toLowerCase();

  if (normalized.includes('loading language')) {
    return 'Chargement des modeles de langue OCR.';
  }

  if (normalized.includes('loading tesseract core')) {
    return 'Chargement du coeur OCR dans le navigateur.';
  }

  if (normalized.includes('initializing')) {
    return 'Initialisation du moteur OCR.';
  }

  if (normalized.includes('recognizing text')) {
    return 'Lecture du texte de la carte en cours.';
  }

  return `OCR: ${status}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

cameraSelect.addEventListener('change', () => {
  const nextDeviceId = cameraSelect.value;

  if (!nextDeviceId || nextDeviceId === state.activeDeviceId) {
    return;
  }

  void startCamera(nextDeviceId);
});

cameraRefresh.addEventListener('click', () => {
  const nextDeviceId = cameraSelect.value || state.activeDeviceId || undefined;
  void startCamera(nextDeviceId);
});

languageSelect.addEventListener('change', () => {
  const nextLanguage = languageSelect.value as CardLanguage;

  if (nextLanguage === state.selectedCardLanguage) {
    return;
  }

  state.selectedCardLanguage = nextLanguage;
  state.ocrLanguageReady = null;
  state.lastOcrResult = null;
  state.ocrSnapshotUrl = '';
  storeCardLanguage(nextLanguage);
  setOcrStatus(
    'idle',
    `Langue de carte reglee sur ${getCardLanguageLabel(nextLanguage)}. Relance une lecture pour utiliser ce modele.`,
    0,
  );

  if (state.status === 'ready') {
    void maybeWarmupOcr();
  }
});

ocrScanButton.addEventListener('click', () => {
  void scanCurrentFrame();
});

if (cameraApisAvailable()) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    void refreshDeviceList();
  });
}

window.addEventListener('beforeunload', () => {
  stopMediaStream(state.currentStream);
  void terminateOcrWorker();
});

renderOcrState();
setStatus('idle');
void startCamera();
