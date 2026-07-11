# Waypoint Terminal

Waypoint Terminal is a responsive browser UI for persistent AI coding-agent sessions. Each session runs in `tmux`, so it keeps working when the browser disconnects and can be resumed from a phone or another computer.

> **Security warning:** Waypoint provides remote shell access as the user who runs it. Its built-in login protects access but does not provide TLS. Bind it to localhost or put it behind a VPN such as Tailscale and HTTPS. Never expose unencrypted port 4173 directly to the public internet.

## Requirements

- Linux with systemd, or macOS with launchd (background mode also works without either)
- Node.js 20 or newer and npm
- `tmux`
- The command you want sessions to run; `claude` is the default

## Install on a machine

Install the CLI and a per-user service with:

```bash
curl -fsSL https://raw.githubusercontent.com/rheerkens/web-tui/main/scripts/install.sh | sh
```

The installer puts the package under `~/.local`, installs a localhost-only user service, starts it, and prints its URL. It never needs `sudo`. If `~/.local/bin` is not already on `PATH`, follow the line printed by the installer. Set `WAYPOINT_HOST=0.0.0.0` only when a trusted private network or authenticated proxy protects the machine.

To install the CLI without installing a system service:

```bash
curl -fsSL https://raw.githubusercontent.com/rheerkens/web-tui/main/scripts/install.sh | sh -s -- --no-service
waypoint start
```

To install from a checkout while developing:

```bash
npm install
npm run build
npm install --global .
waypoint install-service
```

## Everyday CLI use

```bash
waypoint status                 # state, URL, config, and log location
waypoint open                   # open the UI in the default browser
waypoint logs --follow          # stream logs
waypoint restart
waypoint stop
waypoint start
waypoint auth                   # new five-minute login URL and code
waypoint help                   # complete CLI reference
```

`waypoint start` runs a detached background process when no service is installed. When a systemd/launchd service exists, it controls that service instead. `waypoint serve` stays in the foreground and is useful for containers and process supervisors.

The service is installed for the current user, starts automatically when that user's service manager starts, and restarts on failure.

### Browser authentication

Waypoint prints a single-use sign-in URL and 12-character code when it starts. Open the URL or navigate to Waypoint and enter the code within five minutes. Using either consumes the credential, so the other cannot be reused. Generate another credential without restarting:

```bash
waypoint auth
waypoint auth --url https://waypoint.example
```

The browser receives an HttpOnly access cookie valid for 15 minutes and a rotating refresh cookie valid for 7 days. Active browsers refresh automatically. Authentication state is stored with owner-only permissions under `$XDG_STATE_HOME/waypoint-terminal/auth.json` (normally `~/.local/state/waypoint-terminal/auth.json`). When launching `server.js` directly, `PUBLIC_URL`, `AUTH_STATE_FILE`, and `AUTH_SECURE_COOKIES` customize the public login URL, state location, and Secure-cookie behavior.

Use HTTPS outside localhost so login credentials and terminal traffic are encrypted.

On a headless Linux host, the user service normally stops when the user fully logs out. If your distribution does not already keep the user manager alive, enable it once with `loginctl enable-linger "$USER"` (administrator policy may require approval).

### Configure

Configuration is stored in `~/.config/waypoint-terminal/config.json` (or under `$XDG_CONFIG_HOME`):

```bash
waypoint config set host 127.0.0.1
waypoint config set port 4173
waypoint config set command claude
waypoint config set tmux /usr/bin/tmux
waypoint restart
```

You can set the initial values while installing the service:

```bash
waypoint install-service \
  --host 127.0.0.1 \
  --port 4173 \
  --command "claude --dangerously-skip-permissions"
```

Command-line settings on `serve` or a non-service `start` override saved settings for that run. The equivalent environment variables are `HOST`, `PORT`, `SESSION_COMMAND`, and `TMUX_BIN` when launching `server.js` directly.

### Uninstall

```bash
waypoint uninstall-service
npm uninstall --global --prefix "$HOME/.local" waypoint-terminal
rm -rf "$HOME/.config/waypoint-terminal" "$HOME/.local/state/waypoint-terminal"
```

The last line removes saved configuration and logs and is optional. Existing `tmux` sessions are not deleted by uninstalling the web service.

## AI-agent and automation contract

An agent should discover capabilities with `waypoint help` and use JSON output instead of parsing human-readable text:

```bash
waypoint doctor --json
waypoint status --json
waypoint sessions --json
waypoint session create my-task
waypoint session delete my-task
```

Commands exit with status 0 on success and non-zero on failure. `status` exits non-zero when the server is stopped or unreachable. `doctor` exits non-zero when a required runtime dependency is missing. Errors are written to stderr with a `waypoint:` prefix.

The status object has stable top-level fields:

```json
{
  "running": true,
  "reachable": true,
  "manager": "systemd",
  "pid": null,
  "url": "http://127.0.0.1:4173",
  "configFile": "/home/user/.config/waypoint-terminal/config.json",
  "logFile": null
}
```

For direct HTTP integration:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Read health, host name, and session command |
| `GET` | `/api/sessions` | List sessions (authentication required) |
| `POST` | `/api/sessions` | Create a session; optional JSON body: `{"name":"task-name"}` |
| `DELETE` | `/api/sessions/:name` | End a session |
| WebSocket | `/ws?session=:name` | Attach terminal input/output |

Session names must begin with an alphanumeric character, contain only letters, numbers, `.`, `_`, or `-`, and be at most 64 characters. WebSocket messages are JSON:

```json
{"type":"input","data":"ls\r"}
{"type":"resize","cols":120,"rows":40}
{"type":"output","data":"...terminal bytes..."}
```

Only the server sends `output`. Clients send `input` and `resize`.

## Develop and verify

```bash
npm install
npm run dev
npm test
npm pack --dry-run
```

`npm run dev` rebuilds the browser bundle and restarts the server when backend files change. The UI is available at `http://127.0.0.1:4173` by default.

The package includes its compiled browser bundle, so installed machines do not need build tools. Maintainers should run `npm run build` before committing source changes; `npm pack` also rebuilds it through the `prepack` hook.

For the browser end-to-end test, pass a fresh URL as `LOGIN_URL`, for example `LOGIN_URL='http://127.0.0.1:4173/auth/login?token=…' npm run test:e2e`.

## Publishing

The package metadata is also ready for optional npm publication as `waypoint-terminal`:

```bash
npm login
npm publish --access public
```

Publishing is optional—the installer uses the GitHub source archive. Pin an installation to a tag or commit with `WAYPOINT_VERSION`, for example:

```bash
curl -fsSL https://raw.githubusercontent.com/rheerkens/web-tui/v1.0.0/scripts/install.sh \
  | WAYPOINT_VERSION=v1.0.0 sh
```

## License

[MIT](LICENSE)
