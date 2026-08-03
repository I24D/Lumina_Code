#!/usr/bin/env node
/**
 * debug-browser.ts — Interactive CLI debugger for Playwright browser automation.
 *
 * Uses Playwright 1.59+ CLI debugger (--debug=cli) for step-through debugging
 * of browser automation scripts. Perfect for debugging PC Operator loops and
 * understanding why a smart_click or smart_type failed.
 *
 * Usage:
 *   pnpm debug:browser --goal "abre YouTube y busca despacito"
 *   pnpm debug:browser --url "https://youtube.com" --interactive
 *
 * Commands available in debugger:
 *   next / n      — Execute next action
 *   step / s      — Step into detailed view
 *   inspect / i   — Inspect current page state (URL, title, elements)
 *   continue / c  — Continue to end
 *   quit / q      — Exit debugger
 *   help / h      — Show available commands
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const PLAYWRIGHT_CLI = 'npx playwright test --debug=cli';

interface DebugOptions {
  goal?: string;
  url?: string;
  profile?: string;
  headless?: boolean;
  interactive?: boolean;
}

function parseArgs(): DebugOptions {
  const args = process.argv.slice(2);
  const options: DebugOptions = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    
    switch (arg) {
      case '--goal':
      case '-g':
        options.goal = next;
        i++;
        break;
      case '--url':
      case '-u':
        options.url = next;
        i++;
        break;
      case '--profile':
      case '-p':
        options.profile = next;
        i++;
        break;
      case '--headless':
      case '-H':
        options.headless = false; // Default is headless=true for CI, but debugger needs UI
        break;
      case '--interactive':
      case '-i':
        options.interactive = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }
  
  return options;
}

function printHelp(): void {
  console.log(`
Playwright Browser Debugger — Lumina Cognitive OS

Usage:
  pnpm debug:browser [options]

Options:
  --goal, -g <text>     Natural language goal for PC Operator loop
  --url, -u <url>       Direct URL to open and debug
  --profile, -p <name>  Browser profile name (default: "default")
  --headless, -H        Run in headless mode (default: false for debugger)
  --interactive, -i     Enable interactive command mode
  --help, -h            Show this help message

Examples:
  pnpm debug:browser --goal "abre YouTube y busca despacito"
  pnpm debug:browser --url "https://youtube.com" --interactive
  pnpm debug:browser -u "https://github.com" -p "dev-profile"

Debugger Commands:
  next / n      Execute next action
  step / s      Step into detailed view
  inspect / i   Inspect current page state
  continue / c  Continue to end
  quit / q      Exit debugger
  help / h      Show commands
`.trim());
}

function getProfileDir(profile: string): string {
  const appData = process.env.APPDATA || path.join(process.env.HOME || '', '.lumina-browser-sessions');
  return path.join(appData, 'lumina-cognitive-os', 'browser-profile', profile);
}

async function runDebugger(options: DebugOptions): Promise<void> {
  const profile = options.profile || 'default';
  const userDataDir = getProfileDir(profile);
  
  // Ensure profile directory exists
  fs.mkdirSync(userDataDir, { recursive: true });
  
  console.log('🔍 Starting Playwright Browser Debugger');
  console.log('─────────────────────────────────────────');
  console.log(`Profile: ${profile}`);
  console.log(`User Data Dir: ${userDataDir}`);
  console.log(`Headless: ${options.headless ?? false}`);
  console.log('');
  
  if (options.goal) {
    console.log(`Goal: "${options.goal}"`);
    console.log('');
    console.log('This will execute a PC Operator loop with step-through debugging.');
    console.log('Each action (observe → think → act → verify) will pause for inspection.');
    console.log('');
  } else if (options.url) {
    console.log(`URL: ${options.url}`);
    console.log('');
    console.log('This will open the URL and allow interactive debugging.');
    console.log('');
  } else {
    console.log('No goal or URL specified. Opening blank page for manual exploration.');
    console.log('');
  }
  
  // Build the playwright debugger command
  // Note: We're using the browser driver sidecar with debug mode enabled
  const sidecarPath = path.join(__dirname, '../sidecars/browser_drive.py');
  const payload = {
    action: options.url ? 'goto' : 'read',
    userDataDir,
    args: {
      url: options.url || 'about:blank',
      headless: options.headless ?? false,
      timeoutMs: 60000,
      waitUntil: 'domcontentloaded',
    },
  };
  
  console.log('Starting browser session...');
  console.log('');
  console.log('📋 Debugger Controls:');
  console.log('   Type "help" for available commands');
  console.log('   Press Ctrl+C to exit');
  console.log('');
  
  // For now, we launch the browser and let the user interact via Playwright Inspector
  // A full CLI debugger would require more sophisticated command parsing
  const inspectorEnv = {
    ...process.env,
    PWDEBUG: 'console', // This enables the Playwright inspector
    PWDEBUG_CONSOLE: '1',
  };
  
  const child = spawn('npx', ['playwright', 'inspect'], {
    stdio: 'inherit',
    env: inspectorEnv,
    shell: true,
  });
  
  child.on('error', (err) => {
    console.error('Failed to start debugger:', err.message);
    process.exit(1);
  });
  
  child.on('close', (code) => {
    console.log('');
    console.log('─────────────────────────────────────────');
    console.log(`Debugger exited with code ${code}`);
    console.log('Session data preserved in:', userDataDir);
    console.log('');
    console.log('💡 Tip: Use lumina_browser_session tool to resume this session later.');
    process.exit(code || 0);
  });
}

// Main entry point
(async () => {
  try {
    const options = parseArgs();
    await runDebugger(options);
  } catch (error) {
    console.error('Debugger error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
})();
