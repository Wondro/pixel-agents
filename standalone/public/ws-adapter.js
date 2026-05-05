/**
 * Browser adapter for the VS Code webview API.
 *
 * The React app calls acquireVsCodeApi().postMessage(). In standalone mode this
 * shim forwards those messages to the local Node server over WebSocket, then
 * replays server messages as normal window MessageEvents.
 */
(function () {
  'use strict';

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  const reconnectDelayMs = 2000;
  const stateKey = 'pixel-agents-state';

  let ws = null;
  const queue = [];

  function getPersistedState() {
    try {
      return JSON.parse(window.localStorage.getItem(stateKey) || '{}');
    } catch {
      return {};
    }
  }

  function setPersistedState(state) {
    try {
      window.localStorage.setItem(stateKey, JSON.stringify(state));
    } catch {
      // localStorage can be unavailable in private mode.
    }
  }

  function sendRaw(message) {
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    } else {
      queue.push(payload);
    }
  }

  function flushQueue() {
    while (queue.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(queue.shift());
    }
  }

  const vscodeApi = {
    postMessage: sendRaw,
    getState: getPersistedState,
    setState(state) {
      setPersistedState(state);
      return state;
    },
  };

  window.acquireVsCodeApi = function () {
    return vscodeApi;
  };

  function connect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }

    ws = new WebSocket(wsUrl);

    ws.onopen = function () {
      console.log('[pixel-agents] connected to standalone server');
      flushQueue();
    };

    ws.onmessage = function (event) {
      try {
        const data = JSON.parse(event.data);
        window.dispatchEvent(new MessageEvent('message', { data }));
      } catch (error) {
        console.error('[pixel-agents] invalid server message', error);
      }
    };

    ws.onclose = function () {
      ws = null;
      setTimeout(connect, reconnectDelayMs);
    };

    ws.onerror = function (error) {
      console.warn('[pixel-agents] WebSocket error', error);
    };
  }

  connect();
})();
