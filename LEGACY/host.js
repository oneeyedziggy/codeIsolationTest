const frameEl = document.getElementById('iso-frame');
const statusInputEl = document.getElementById('status-input');
const sendValueBtn = document.getElementById('send-value-btn');
const clearLogsBtn = document.getElementById('clear-logs-btn');
const logEl = document.getElementById('host-log');
const frameStatusEl = document.getElementById('frame-status');

const ISO_FRAME_URL = 'http://iso.localhost:8000/';

const CHILD_FRAME_ORIGIN = '*';
//const CHILD_FRAME_ORIGIN = 'http://iso.localhost:8000';

// Map iframe windows to their authoritative subdomain prefix so the child cannot spoof it.
const windowToSubdomain = new WeakMap();

function extractIsoPrefix(srcUrl) {
  try {
    const { hostname } = new URL(srcUrl, window.location.href);
    const [firstLabel] = hostname.split('.');
    return firstLabel && firstLabel.startsWith('iso') ? firstLabel : null;
  } catch {
    return null;
  }
}

function logFromHost(message, detail) {
  const line = `[logged by outer host] ${message}${
    detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''
  }`;
  console.log(line);
  logEl.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function registerFrame(iframe) {
  if (!iframe.contentWindow) return;
  const prefix = extractIsoPrefix(iframe.src);
  if (prefix) {
    windowToSubdomain.set(iframe.contentWindow, prefix);
  }
}

// Count iframe load events. Load #1 is the intended boot (guaranteed observable
// because src is only assigned after this listener is attached). Any later load
// means the frame navigated or reloaded itself — display it (display-only policy).
let frameLoads = 0;

frameEl.addEventListener('load', () => {
  frameLoads += 1;
  if (frameLoads > 1) {
    frameStatusEl.textContent = `⚠ Unexpected frame load #${frameLoads} — frame navigated or reloaded after initial boot.`;
    frameStatusEl.classList.add('frame-alert');
    logFromHost(`unexpected iframe load #${frameLoads} (frame may have navigated)`);
    return;
  }
  frameStatusEl.textContent = 'Frame: initial load OK.';
  registerFrame(frameEl);
  runProbe();
  pushDisplayedValue(statusInputEl.value);
});

function runProbe() {
  if (!frameEl.contentWindow) return;
  console.log('run probe found contentWindow');
  frameEl.contentWindow.postMessage(
    {
      type: 'RUN_PROBE',
    },
    CHILD_FRAME_ORIGIN,
  );
}

// 1. Host -> Isolated Frame: update displayed value
function pushDisplayedValue(value) {
  console.log('pushDisplayedValue', value);
  if (!frameEl.contentWindow) return;
  console.log('pushDisplayedValue found contentWindow and is proceeding');
  frameEl.contentWindow.postMessage(
    {
      type: 'SET_DISPLAYED_VALUE',
      value: String(value),
    },
    CHILD_FRAME_ORIGIN,
  );
}

sendValueBtn.addEventListener('click', () => {
  pushDisplayedValue(statusInputEl.value);
});

clearLogsBtn.addEventListener('click', () => {
  logEl.textContent = '';
});

// Safe host-side localStorage wrapper (handles quota or restricted browser storage)
function safeHostStorage(op) {
  try {
    return { ok: true, value: op(window.localStorage) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Listen for messages from the isolated child frame
window.addEventListener('message', (event) => {
  console.log('host received message', event.data);
  // Verify the message came from our registered sandboxed iframe window
  const subdomainPrefix = windowToSubdomain.get(event.source);
  if (!subdomainPrefix) return;

  // With sandbox="allow-scripts" (no allow-same-origin), opaque frames report origin "null".
  // If you add allow-same-origin, check `event.origin === TARGET_FRAME_ORIGIN`.
  if (event.origin !== 'null' && event.origin !== CHILD_FRAME_ORIGIN) return;

  const data = event.data;
  if (!data || typeof data !== 'object') return;

  // 2. Unsolicited/autonomous telemetry events from isolated child -> outer host log
  if (data.type === 'CHILD_AUTONOMOUS_EVENT') {
    console.log('message to host has data type of CHILD_AUTONOMOUS_EVENT');
    logFromHost(`from ${subdomainPrefix} (autonomous)`, {
      eventName: String(data.eventName ?? 'tick'),
      seq: Number(data.seq ?? 0),
      payload: data.payload ?? null,
    });
    return;
  }

  // 3. Proxy localStorage requests from isolated child -> host localStorage with forced prefix
  if (data.type === 'STORAGE_PROXY_REQUEST') {
    console.log('message to host has data type of STORAGE_PROXY_REQUEST');
    const requestId = String(data.requestId ?? '');
    const action = String(data.action ?? '');
    const rawKey = typeof data.key === 'string' ? data.key.trim() : '';

    if (!requestId || !rawKey || rawKey.length > 128) {
      event.source.postMessage(
        {
          type: 'STORAGE_PROXY_RESPONSE',
          requestId,
          ok: false,
          error: 'Invalid key or requestId',
        },
        '*',
      );
      return;
    } else {
      console.log(
        'message to host missing requestId, rawKey, or has excessive rawKeyLength',
      );
    }

    // Authoritatively prepend the verified subdomain prefix (ignore any client prefix)
    const namespacedKey = `${subdomainPrefix}:${rawKey}`;

    if (action === 'get') {
      console.log('message to host STORAGE_PROXY_REQUEST type get');
      const res = safeHostStorage((ls) => ls.getItem(namespacedKey));
      logFromHost(`storage GET (${namespacedKey})`, res);
      event.source.postMessage(
        { type: 'STORAGE_PROXY_RESPONSE', requestId, key: rawKey, ...res },
        '*',
      );
    } else if (action === 'set') {
      console.log('message to host STORAGE_PROXY_REQUEST type set');
      const serializedValue =
        typeof data.value === 'string'
          ? data.value
          : JSON.stringify(data.value ?? '');
      if (serializedValue.length > 250_000) {
        event.source.postMessage(
          {
            type: 'STORAGE_PROXY_RESPONSE',
            requestId,
            ok: false,
            error: 'Value too large',
          },
          '*',
        );
        return;
      }
      const res = safeHostStorage((ls) => {
        ls.setItem(namespacedKey, serializedValue);
        return true;
      });
      logFromHost(`storage SET (${namespacedKey})`, res);
      event.source.postMessage(
        { type: 'STORAGE_PROXY_RESPONSE', requestId, key: rawKey, ...res },
        '*',
      );
    } else if (action === 'remove') {
      console.log('message to host STORAGE_PROXY_REQUEST type remove');
      const res = safeHostStorage((ls) => {
        ls.removeItem(namespacedKey);
        return true;
      });
      logFromHost(`storage REMOVE (${namespacedKey})`, res);
      event.source.postMessage(
        { type: 'STORAGE_PROXY_RESPONSE', requestId, key: rawKey, ...res },
        '*',
      );
    } else {
      event.source.postMessage(
        {
          type: 'STORAGE_PROXY_RESPONSE',
          requestId,
          ok: false,
          error: 'Unsupported action',
        },
        '*',
      );
    }
  }
});

// Boot the frame only after the load listener is attached so load #1 is never missed.
frameEl.src = ISO_FRAME_URL;
