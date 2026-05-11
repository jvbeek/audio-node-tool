// ── WebSocket client with binary frame protocol ─────────────────────

class AudioWebSocket {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.onStatus = null;
    this.onPCM = null;
    this.reconnectTimer = null;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}`;
    console.log('[ws] Connecting to', url);
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.connected = true;
      console.log('[ws] Connected');
      // Flush any pending commands
      if (this.pendingCommands && this.pendingCommands.length > 0) {
        console.log('[ws] Flushing', this.pendingCommands.length, 'pending commands');
        while (this.pendingCommands.length > 0) {
          this.ws.send(JSON.stringify(this.pendingCommands.shift()));
        }
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      console.log('[ws] Disconnected');
      this._reconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[ws] Error:', err);
    };

    this.ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        // Text message (future use)
        return;
      }
      this._handleBinary(new Uint8Array(event.data));
    };
  }

  _handleBinary(data) {
    if (data.length < 5) return;
    const type = data[0];
    const length = (data[1] << 16) | (data[2] << 8) | data[3];
    const payload = data.slice(5);

    if (type === 0x02 && this.onPCM) {
      // Playback PCM
      this.onPCM(new Int16Array(payload.buffer));
    } else if (type === 0x03 && this.onStatus) {
      // Status text
      this.onStatus(new TextDecoder().decode(payload));
    }
  }

  sendPCM(pcm) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const data = new Uint8Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
    const len = data.byteLength;
    const frame = new Uint8Array(5 + len);
    frame[0] = 0x01; // mic PCM
    frame[1] = (len >> 16) & 0xff;
    frame[2] = (len >> 8) & 0xff;
    frame[3] = len & 0xff;
    frame.set(data, 5);
    this.ws.send(frame);
  }

  sendCommand(cmd) {
    if (!this.ws || this.ws.readyState !== 1) {
      console.error('[ws] Cannot send command - WebSocket not connected (state:', this.ws ? this.ws.readyState : 'no socket', ')');
      // Queue command to send when connected
      if (!this.pendingCommands) this.pendingCommands = [];
      this.pendingCommands.push(cmd);
      return;
    }
    this.ws.send(JSON.stringify(cmd));
  }

  _reconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

// Polyfill for Buffer.concat in browser
if (typeof Buffer === 'undefined') {
  globalThis.Buffer = {
    concat: (buffers) => {
      const totalLength = buffers.reduce((sum, b) => sum + b.byteLength, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const b of buffers) {
        result.set(b, offset);
        offset += b.byteLength;
      }
      return result;
    }
  };
}
