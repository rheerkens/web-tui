# Waypoint Terminal

A responsive browser UI for persistent Claude Code sessions. Sessions are backed by tmux, so they continue running after the browser disconnects.

## Run

```bash
npm install
npm run build
npm start
```

Open `http://HOST:4173`. Set `PORT`, `HOST`, or `SESSION_COMMAND` to customize the server.

> This app intentionally provides shell access. Put it behind HTTPS and authentication (VPN, Tailscale, or an authenticated reverse proxy) before exposing it outside a trusted network.
