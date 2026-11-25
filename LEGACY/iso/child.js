const originReadoutEl = document.getElementById('origin-readout');
const displayedValueEl = document.getElementById('displayed-value');
const keyInputEl = document.getElementById('storage-key');
const valInputEl = document.getElementById('storage-val');
const setBtn = document.getElementById('storage-set-btn');
const getBtn = document.getElementById('storage-get-btn');
const delBtn = document.getElementById('storage-del-btn');
const statusEl = document.getElementById('child-status');

const PARENT_FRAME_ORIGIN = 'http://localhost:8000';
console.log = (...rest) => {
  window.parent.postMessage(
    {
      type: 'CHILD_AUTONOMOUS_EVENT',
      eventName: 'just logging',
      seq,
      payload: {
        message: JSON.stringify(rest),
      },
    },
    PARENT_FRAME_ORIGIN,
  );
};

originReadoutEl.textContent = window.origin;

const pendingRequests = new Map();
let seq = 0;

function writeChildStatus(msg) {
  statusEl.textContent = msg;
}

// 1. Receive message from host and update displayed value
window.addEventListener('message', (event) => {
  console.log('received message inside isolation', event);
  // In this local setup, host runs on http://localhost:8000
  if (event.origin !== 'http://localhost:8000') return;

  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'SET_DISPLAYED_VALUE') {
    console.log(
      'about to SET_DISPLAYED_VALUE from inside isolation',
      data.value,
    );
    displayedValueEl.textContent = String(data.value ?? '');
    return;
  }

  if (data.type === 'RUN_PROBE') {
    console.log('about to RUN_PROBE from inside isolation');
    runSandboxProbe();
    return;
  }

  if (
    data.type === 'STORAGE_PROXY_RESPONSE' &&
    typeof data.requestId === 'string'
  ) {
    console.log('about to STORAGE_PROXY_RESPONSE from inside isolation');
    const resolver = pendingRequests.get(data.requestId);
    if (resolver) {
      pendingRequests.delete(data.requestId);
      resolver(data);
      return;
    } else {
      console.log('no resolver from inside isolation');
      return;
    }
  }
});

// // 2. Generate autonomous events without user interaction -> post to outer host
// setInterval(() => {
//   console.log('posting message from child');
//   seq += 1;
//   window.parent.postMessage(
//     {
//       type: 'CHILD_AUTONOMOUS_EVENT',
//       eventName: 'heartbeat_telemetry',
//       seq,
//       payload: {
//         uptimeMs: Math.round(performance.now()),
//         viewport: { width: window.innerWidth, height: window.innerHeight },
//       },
//     },
//     PARENT_FRAME_ORIGIN,
//   );
// }, 10000);

// 3. User-triggered localStorage proxy calls through host
function requestHostStorage(action, key, value) {
  return new Promise((resolve) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingRequests.set(requestId, resolve);

    window.parent.postMessage(
      {
        type: 'STORAGE_PROXY_REQUEST',
        requestId,
        action,
        key,
        value,
      },
      PARENT_FRAME_ORIGIN,
    );
  });
}

setBtn.addEventListener('click', async () => {
  const key = keyInputEl.value.trim();
  const val = valInputEl.value;
  const res = await requestHostStorage('set', key, val);
  writeChildStatus(
    res.ok ? `SET "${key}" succeeded via host.` : `SET failed: ${res.error}`,
  );
});

getBtn.addEventListener('click', async () => {
  const key = keyInputEl.value.trim();
  const res = await requestHostStorage('get', key);
  writeChildStatus(
    res.ok
      ? `GET "${key}" -> ${res.value === null ? '(null)' : JSON.stringify(res.value)}`
      : `GET failed: ${res.error}`,
  );
});

delBtn.addEventListener('click', async () => {
  const key = keyInputEl.value.trim();
  const res = await requestHostStorage('remove', key);
  writeChildStatus(
    res.ok
      ? `REMOVE "${key}" succeeded via host.`
      : `REMOVE failed: ${res.error}`,
  );
});

function runSandboxProbe() {
  const probe = {
    origin: window.origin,
    href: window.location.href,
    hasParent: window.parent !== window,
    localStorage: 'unavailable',
    sessionStorage: 'unavailable',
    indexedDB: 'unavailable',
    cookie: 'unavailable',
  };

  for (const [label, fn] of [
    [
      'localStorage',
      () => {
        window.localStorage.setItem('_p', '1');
        window.localStorage.removeItem('_p');
      },
    ],
    [
      'sessionStorage',
      () => {
        window.sessionStorage.setItem('_p', '1');
        window.sessionStorage.removeItem('_p');
      },
    ],
    [
      'indexedDB',
      () => {
        if (!window.indexedDB) throw new Error('missing');
      },
    ],
    [
      'cookie',
      () => {
        void document.cookie;
      },
    ],
  ]) {
    try {
      fn();
      probe[label] = 'accessible';
    } catch (err) {
      probe[label] =
        `blocked (${err instanceof Error ? err.name : String(err)})`;
    }
  }

  window.parent.postMessage(
    {
      type: 'CHILD_AUTONOMOUS_EVENT',
      eventName: 'sandbox_probe',
      seq: ++seq,
      payload: probe,
    },
    PARENT_FRAME_ORIGIN,
  );
}
