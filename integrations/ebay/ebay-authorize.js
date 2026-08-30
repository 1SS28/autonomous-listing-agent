#!/usr/bin/env node
// One-time OAuth setup for eBay's Sell APIs (authorization code grant).
//
// Run this once per environment (sandbox, then later production):
//   node ebay-authorize.js
//
// eBay is different from most OAuth providers in two ways this script handles:
//  1. The "redirect_uri" parameter is your RuName string, NOT a URL.
//  2. eBay redirects to whatever accept-URL you configured on that RuName,
//     which usually is not a local server you control. So instead of trying
//     to catch the redirect, this script asks you to paste the URL you land
//     on back into the terminal. That page may look broken or blank - that
//     is fine and expected. All we need is the address bar contents.

import readline from "node:readline";
import { loadConfig, saveTokens, hosts, basicAuthHeader, TOKENS_PATH } from "./ebay-common.js";

const config = loadConfig();
const { authHost, apiHost, isSandbox } = hosts(config);

const authorizeUrl = new URL(`${authHost}/oauth2/authorize`);
authorizeUrl.searchParams.set("client_id", config.appId);
authorizeUrl.searchParams.set("redirect_uri", config.ruName);
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set(
  "scope",
  config.scopes ||
    "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account"
);

console.log(`\nEnvironment: ${isSandbox ? "SANDBOX (fake marketplace, no real fees)" : "PRODUCTION (real listings, real money)"}\n`);
console.log("1. Open this URL in your browser:\n");
console.log(authorizeUrl.toString());
console.log(
  `\n2. Sign in with your ${isSandbox ? "SANDBOX test user" : "real eBay"} account and click Agree.\n` +
    "3. You'll be redirected somewhere that may look blank or broken. That's fine.\n" +
    "4. Copy the ENTIRE URL from your browser's address bar and paste it below.\n"
);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question("Paste the full redirected URL here: ", async (answer) => {
  rl.close();

  let code;
  try {
    // URLSearchParams handles the URL-decoding of the code for us, which
    // matters - eBay's authorization codes arrive percent-encoded.
    code = new URL(answer.trim()).searchParams.get("code");
  } catch {
    console.error("\nThat didn't parse as a URL. Re-run the script and paste the whole address, starting with https://");
    process.exit(1);
  }

  if (!code) {
    console.error(
      "\nNo 'code' parameter found in that URL. If the URL contains 'error=' instead, the consent was declined or the RuName is misconfigured."
    );
    process.exit(1);
  }

  try {
    const res = await fetch(`${apiHost}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basicAuthHeader(config),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.ruName,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Token exchange failed (${res.status}): ${JSON.stringify(data)}`);
    }

    saveTokens({
      environment: config.environment,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
      refresh_token_expires_at: data.refresh_token_expires_in
        ? Date.now() + data.refresh_token_expires_in * 1000
        : null,
    });

    console.log(`\nSaved tokens to ${TOKENS_PATH}`);
    console.log("Setup complete. You can now wire the MCP server into OpenClaw.");
  } catch (err) {
    console.error("\n" + err.message);
    process.exit(1);
  }
});
