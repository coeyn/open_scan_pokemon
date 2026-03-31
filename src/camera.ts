export type CameraStatus =
  | 'idle'
  | 'requesting'
  | 'ready'
  | 'denied'
  | 'unavailable'
  | 'error';

export interface CameraDevice {
  deviceId: string;
  kind: MediaDeviceKind;
  label: string;
}

const localHosts = new Set(['localhost', '127.0.0.1', '::1']);

export const preferredCameraStorageKey = 'preferredCameraId';

export function cameraApisAvailable(): boolean {
  const mediaDevices = navigator.mediaDevices;

  return (
    typeof mediaDevices !== 'undefined' &&
    typeof mediaDevices.getUserMedia === 'function' &&
    typeof mediaDevices.enumerateDevices === 'function'
  );
}

export function cameraContextAllowed(): boolean {
  return window.isSecureContext || localHosts.has(window.location.hostname);
}

export async function listCameraDevices(): Promise<CameraDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoDevices = devices.filter(
    (device): device is MediaDeviceInfo => device.kind === 'videoinput',
  );

  return videoDevices.map((device, index) => ({
    deviceId: device.deviceId,
    kind: device.kind,
    label: device.label || `Camera ${index + 1}`,
  }));
}

export function getStoredPreferredCameraId(): string | null {
  try {
    return window.localStorage.getItem(preferredCameraStorageKey);
  } catch {
    return null;
  }
}

export function storePreferredCameraId(deviceId?: string): void {
  try {
    if (deviceId) {
      window.localStorage.setItem(preferredCameraStorageKey, deviceId);
      return;
    }

    window.localStorage.removeItem(preferredCameraStorageKey);
  } catch {
    // Ignore local storage failures and keep the stream usable.
  }
}

export function stopMediaStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export function getActiveDeviceId(
  stream: MediaStream | null | undefined,
): string | undefined {
  const [videoTrack] = stream?.getVideoTracks() ?? [];

  return videoTrack?.getSettings().deviceId;
}

export async function getCameraStream(
  preferredDeviceId?: string,
): Promise<MediaStream> {
  let lastError: unknown;

  for (const constraints of buildConstraints(preferredDeviceId)) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      lastError = error;

      if (isFatalCameraError(error)) {
        throw error;
      }
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new DOMException('No camera available', 'NotFoundError');
}

export async function attachStream(
  videoElement: HTMLVideoElement,
  stream: MediaStream,
): Promise<void> {
  videoElement.srcObject = stream;
  videoElement.muted = true;
  videoElement.playsInline = true;

  await videoElement.play().catch(() => undefined);
}

export function describeCameraError(error: unknown): {
  message: string;
  status: CameraStatus;
} {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return {
          status: 'denied',
          message:
            'Acces refuse. Autorise la camera dans le navigateur puis relance le flux.',
        };
      case 'NotFoundError':
        return {
          status: 'unavailable',
          message: 'Aucune camera exploitable n a ete detectee sur cet appareil.',
        };
      case 'NotReadableError':
        return {
          status: 'error',
          message:
            'La camera semble deja utilisee ailleurs. Ferme les autres applis puis reessaie.',
        };
      case 'OverconstrainedError':
        return {
          status: 'error',
          message:
            'La camera selectionnee ne prend pas en charge la configuration demandee.',
        };
      default:
        return {
          status: 'error',
          message: 'Impossible de demarrer la camera pour le moment.',
        };
    }
  }

  return {
    status: 'error',
    message: 'Une erreur inattendue a empeche l acces a la camera.',
  };
}

function buildConstraints(
  preferredDeviceId?: string,
): MediaStreamConstraints[] {
  const sharedVideoConfig = {
    aspectRatio: { ideal: 5 / 7 },
    height: { ideal: 1080 },
    width: { ideal: 1440 },
  } as const;

  const candidates: MediaStreamConstraints[] = [];

  if (preferredDeviceId) {
    candidates.push({
      audio: false,
      video: {
        ...sharedVideoConfig,
        deviceId: { exact: preferredDeviceId },
      },
    });
  }

  candidates.push({
    audio: false,
    video: {
      ...sharedVideoConfig,
      facingMode: { ideal: 'environment' },
    },
  });

  candidates.push({
    audio: false,
    video: sharedVideoConfig,
  });

  return candidates;
}

function isFatalCameraError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'SecurityError')
  );
}
