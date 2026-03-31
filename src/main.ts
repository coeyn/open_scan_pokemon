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

type AppState = {
  activeDeviceId: string;
  currentStream: MediaStream | null;
  devices: CameraDevice[];
  isBusy: boolean;
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

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="app-shell">
    <div class="ambient ambient-left" aria-hidden="true"></div>
    <div class="ambient ambient-right" aria-hidden="true"></div>

    <header class="hero-card">
      <p class="eyebrow">open source / scan web / beta camera</p>
      <div class="hero-copy">
        <p class="kicker">Apercu live</p>
        <h1>Cadre ta carte Pokemon et choisis la bonne camera.</h1>
        <p class="intro">
          Ce premier ecran pose la base du scan mobile-first: un flux video,
          un selecteur de camera et des retours clairs sur les permissions.
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
            <div class="frame-copy">Centre la carte dans le cadre</div>
          </div>
        </div>
      </section>

      <aside class="control-panel">
        <p class="panel-label">Pilotage</p>
        <h2>Selection de la camera</h2>
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

        <button id="camera-refresh" class="action-button" type="button">
          Activer la camera
        </button>

        <section class="tips" aria-label="Infos de fonctionnement">
          <p class="tips-title">Notes utiles</p>
          <ul>
            <li>Sur mobile, la camera arriere est preferee quand elle existe.</li>
            <li>Le dernier capteur choisi est memorise sur cet appareil.</li>
            <li>GitHub Pages servira le site en HTTPS pour autoriser la camera.</li>
          </ul>
        </section>
      </aside>
    </main>
  </div>
`;

const videoElement = getRequiredElement<HTMLVideoElement>('#camera-preview');
const videoShell = getRequiredElement<HTMLDivElement>('#video-shell');
const cameraState = getRequiredElement<HTMLSpanElement>('#camera-state');
const cameraMessage = getRequiredElement<HTMLParagraphElement>('#camera-message');
const cameraSelect = getRequiredElement<HTMLSelectElement>('#camera-select');
const cameraRefresh = getRequiredElement<HTMLButtonElement>('#camera-refresh');

const state: AppState = {
  activeDeviceId: '',
  currentStream: null,
  devices: [],
  isBusy: false,
  status: 'idle',
};

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
  cameraRefresh.textContent = state.isBusy
    ? 'Ouverture en cours...'
    : state.status === 'ready'
      ? 'Relancer la camera'
      : 'Activer la camera';
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

if (cameraApisAvailable()) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    void refreshDeviceList();
  });
}

window.addEventListener('beforeunload', () => {
  stopMediaStream(state.currentStream);
});

setStatus('idle');
void startCamera();
