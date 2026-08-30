#!/usr/bin/env node
// One-time OAuth 2.0 + PKCE setup for the Etsy Open API v3.
// Run this ONCE (and again roughly every 90 days when the refresh token expires):
//   node etsy-authorize.js
// It opens/prints a URL for you to approve in your browser, then saves
// access + refresh tokens to etsy-tokens.json for the MCP server to use.

import crypto from "node:crypto";
import http from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "etsy-config.json");
const TOKENS_PATH = path.join(__dirname, "etsy-tokens.json");

if (!existsSync(CONFIG_PATH)) {
  console.error(
    `Missing ${CONFIG_PATH}.\nCopy config.example.json to etsy-config.json and fill in your keystring, sharedSecret, and shopId first.`
  );
  process.exit(1);
}

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const {
  keystring,
  redirectUri = "http://localhost:3003/oauth/redirect",
  scopes = "listings_w listings_r shops_r",
} = config;

if (!keystring) {
  console.error("etsy-config.json is missing 'keystring'.");
  process.exit(1);
}

function base64url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const codeVerifier = base64url(crypto.randomBytes(64)).slice(0, 128);
const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
const state = base64url(crypto.randomBytes(16));

const redirect = new URL(redirectUri);
const port = Number(redirect.port || 80);
const callbackPath = redirect.pathname;

const authorizeUrl = new URL("https://www.etsy.com/oauth/connect");
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("client_id", keystring);
authorizeUrl.searchParams.set("redirect_uri", redirectUri);
authorizeUrl.searchParams.set("scope", scopes);
authorizeUrl.searchParams.set("state", state);
authorizeUrl.searchParams.set("code_challenge", codeChallenge);
authorizeUrl.searchParams.set("code_challenge_method", "S256");

const server = http.createServer(async (req, res) => {
  let reqUrl;
  try {
    reqUrl = new URL(req.url, redirectUri);
  } catch {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  if (reqUrl.pathname !== callbackPath) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const returnedState = reqUrl.searchParams.get("state");
  const code = reqUrl.searchParams.get("code");
  const error = reqUrl.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end(`Etsy returned an error: ${error}`);
    console.error("Etsy authorization error:", error);
    server.close(() => process.exit(1));
    return;
  }

  if (!code || returnedState !== state) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("State mismatch or missing code - possible CSRF, aborting. Run the script again.");
    console.error("State mismatch. Expected:", state, "Got:", returnedState);
    server.close(() => process.exit(1));
    return;
  }

  try {
    const tokenRes = await fetch("https://api.etsy.com/v3/public/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: keystring,
        redirect_uri: redirectUri,
        code,
        code_verifier: codeVerifier,
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${JSON.stringify(tokenData)}`);
    }

    const expiresAt = Date.now() + tokenData.expires_in * 1000;
    writeFileSync(
      TOKENS_PATH,
      JSON.stringify(
        {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: expiresAt,
        },
        null,
        2
      )
    );

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Authorized! You can close this tab and go back to the terminal.");
    console.log(`\nSaved tokens to ${TOKENS_PATH}`);
    console.log("Setup complete. You can now wire the MCP server into OpenClaw.");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Something went wrong exchanging the code for a token. Check the terminal.");
    console.error(err);
  } finally {
    server.close();
  }
});

server.listen(port, () => {
  console.log("Open this URL in your browser and log into the Etsy account that owns your shop:\n");
  console.log(authorizeUrl.toString());
  console.log(`\nWaiting for you to approve access (listening on ${redirectUri}) ...`);
});
