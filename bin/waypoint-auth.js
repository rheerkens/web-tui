#!/usr/bin/env node
import { createAuth } from '../src/auth.js';

function usage() {
  console.log(`Usage: waypoint-auth [--url URL]

Print a single-use Waypoint browser login URL valid for five minutes.

Options:
  --url URL   Public Waypoint URL (defaults to PUBLIC_URL or http://localhost:$PORT)
  -h, --help  Show this help`);
}

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  usage();
  process.exit(0);
}

const urlIndex = args.indexOf('--url');
const validArgs = args.length === 0 || (args.length === 2 && urlIndex === 0 && Boolean(args[1]));
if (!validArgs) {
  usage();
  process.exitCode = 1;
} else {
  try {
    const baseUrl = urlIndex >= 0
      ? args[urlIndex + 1]
      : process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4173}`;
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('The public URL must use http:// or https://.');
    const auth = createAuth({ issuerOnly: true });
    const login = auth.createLoginCredentials(parsed.toString());
    console.log(`URL:  ${login.url}`);
    console.log(`Code: ${login.code}`);
  } catch (error) {
    console.error(`Could not create login link: ${error.message}`);
    process.exitCode = 1;
  }
}
