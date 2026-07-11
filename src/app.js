import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

const $ = (selector) => document.querySelector(selector);
const elements = {
  sidebar: $('#sidebar'), list: $('#session-list'), empty: $('#empty-state'), terminal: $('#terminal'),
  status: $('#connection-status'), current: $('#current-session'), newButton: $('#new-session'),
  closeButton: $('#close-session'), menuButton: $('#menu-button'), overlay: $('#overlay'),
  toast: $('#toast'), keyboardButton: $('#keyboard-button'), mobileInput: $('#mobile-input')
};

let activeSession = null;
let socket = null;
let sessions = [];
const terminal = new Terminal({
  cursorBlink: true, cursorStyle: 'bar', convertEol: false, fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
  fontSize: 14, lineHeight: 1.18, scrollback: 8000, allowProposedApi: true,
  theme: { background: '#0b0d0c', foreground: '#e8e8e3', cursor: '#d7ff64', cursorAccent: '#0b0d0c', selectionBackground: '#d7ff6440', black: '#1c211e', brightBlack: '#6f7771', green: '#b9e75b', brightGreen: '#d7ff64', yellow: '#e7c95b', cyan: '#65d6c3', brightWhite: '#ffffff' }
});
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.loadAddon(new WebLinksAddon());
terminal.open(elements.terminal);

const escapeHtml = (value) => value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const relativeTime = (time) => {
  const seconds = Math.max(1, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

function showToast(message, kind = '') {
  elements.toast.textContent = message;
  elements.toast.className = `toast visible ${kind}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.className = 'toast', 2800);
}

async function api(path, options) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}

function renderSessions() {
  elements.list.innerHTML = sessions.map((session) => `
    <li><button class="session-item ${session.name === activeSession ? 'active' : ''}" data-session="${escapeHtml(session.name)}">
      <span class="session-icon">›_</span><span class="session-copy"><strong>${escapeHtml(session.name)}</strong>
      <small><span class="live-dot"></span>${escapeHtml(session.command || 'shell')} · ${relativeTime(session.created)}</small></span>
      <span class="chevron">›</span></button></li>`).join('');
  $('#session-count').textContent = sessions.length;
  elements.list.querySelectorAll('[data-session]').forEach((button) => button.addEventListener('click', () => connect(button.dataset.session)));
}

async function refreshSessions(selectFirst = false) {
  try {
    sessions = (await api('/api/sessions')).sessions;
    renderSessions();
    if ((selectFirst || (activeSession && !sessions.some((s) => s.name === activeSession))) && sessions[0]) connect(sessions[0].name);
    if (!sessions.length) disconnect();
  } catch (error) { showToast(error.message, 'error'); }
}

function setStatus(state, label) {
  elements.status.className = `connection-status ${state}`;
  elements.status.querySelector('span:last-child').textContent = label;
}

function disconnect() {
  if (socket) { socket.onclose = null; socket.close(); socket = null; }
  activeSession = null;
  terminal.clear();
  elements.empty.hidden = false;
  elements.current.textContent = 'No session selected';
  elements.closeButton.disabled = true;
  setStatus('offline', 'Disconnected');
  renderSessions();
}

function connect(name) {
  if (name === activeSession && socket?.readyState === WebSocket.OPEN) { focusTerminal(); return; }
  if (socket) { socket.onclose = null; socket.close(); }
  activeSession = name;
  terminal.reset();
  elements.empty.hidden = true;
  elements.current.textContent = name;
  elements.closeButton.disabled = false;
  setStatus('connecting', 'Connecting');
  renderSessions();
  closeSidebar();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws?session=${encodeURIComponent(name)}`);
  socket.addEventListener('open', () => { setStatus('online', 'Live'); fit(); focusTerminal(); });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === 'output') terminal.write(message.data);
  });
  socket.addEventListener('close', () => {
    if (activeSession === name) { setStatus('offline', 'Session ended'); refreshSessions(); }
  });
  socket.addEventListener('error', () => showToast('Could not connect to the terminal.', 'error'));
}

function fit() {
  if (!activeSession || elements.terminal.clientWidth < 20) return;
  fitAddon.fit();
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
}

function focusTerminal() {
  terminal.focus();
  if (matchMedia('(pointer: coarse)').matches) elements.mobileInput.focus({ preventScroll: true });
}

function openSidebar() { elements.sidebar.classList.add('open'); elements.overlay.hidden = false; }
function closeSidebar() { elements.sidebar.classList.remove('open'); elements.overlay.hidden = true; }

terminal.onData((data) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
});
new ResizeObserver(() => requestAnimationFrame(fit)).observe(elements.terminal);

elements.newButton.addEventListener('click', async () => {
  elements.newButton.disabled = true;
  try {
    const { name } = await api('/api/sessions', { method: 'POST', body: '{}' });
    await refreshSessions();
    connect(name);
    showToast('Claude session started.');
  } catch (error) { showToast(error.message, 'error'); }
  finally { elements.newButton.disabled = false; }
});
elements.closeButton.addEventListener('click', async () => {
  if (!activeSession || !confirm(`End “${activeSession}”? This will stop the running process.`)) return;
  try { await api(`/api/sessions/${encodeURIComponent(activeSession)}`, { method: 'DELETE' }); disconnect(); await refreshSessions(true); }
  catch (error) { showToast(error.message, 'error'); }
});
elements.menuButton.addEventListener('click', openSidebar);
elements.overlay.addEventListener('click', closeSidebar);
elements.keyboardButton.addEventListener('click', () => {
  terminal.focus();
  elements.mobileInput.focus({ preventScroll: true });
});
elements.mobileInput.addEventListener('input', (event) => {
  const data = event.target.value;
  if (data && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
  event.target.value = '';
});
elements.mobileInput.addEventListener('keydown', (event) => {
  const keys = { Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowLeft: '\x1b[D', ArrowRight: '\x1b[C' };
  if (keys[event.key] && socket?.readyState === WebSocket.OPEN) { event.preventDefault(); socket.send(JSON.stringify({ type: 'input', data: keys[event.key] })); }
});
document.querySelectorAll('[data-key]').forEach((button) => button.addEventListener('click', () => {
  const keyData = { escape: '\x1b', tab: '\t', 'ctrl-c': '\x03', up: '\x1b[A', down: '\x1b[B' };
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data: keyData[button.dataset.key] }));
  focusTerminal();
}));
window.addEventListener('orientationchange', () => setTimeout(fit, 180));
refreshSessions(true);
setInterval(() => refreshSessions(), 10000);
