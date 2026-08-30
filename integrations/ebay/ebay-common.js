// Shared config/token/host helpers for the eBay skill.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = path.join(__dirname, "ebay-config.json");
export const TOKENS_PATH = path.join(__dirname, "ebay-tokens.json");

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Missing ${CONFIG_PATH}. Copy config.example.json to ebay-config.json and fill it in.`
    );
  }
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  for (const key of ["appId", "certId", "ruName"]) {
    if (!config[key] || String(config[key]).startsWith("YOUR_")) {
      throw new Error(`ebay-config.json is missing a real value for "${key}".`);
    }
  }
  // eBay validates language tags against RFC 5646 and rejects underscores
  // with an unhelpful "Invalid value for header" error, so normalize here.
  if (config.contentLanguage) {
    config.contentLanguage = config.contentLanguage.replace("_", "-");
  }
  return config;
}

export function loadTokens() {
  if (!existsSync(TOKENS_PATH)) {
    throw new Error(
      `Missing ${TOKENS_PATH}. Run "node ebay-authorize.js" once first to connect your eBay account.`
    );
  }
  return JSON.parse(readFileSync(TOKENS_PATH, "utf8"));
}

export function saveTokens(tokens) {
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

// eBay runs completely separate sandbox and production environments, each with
// its own keys, its own RuName, and its own user accounts. Nothing crosses over.
export function hosts(config) {
  const isSandbox = (config.environment || "sandbox").toLowerCase() === "sandbox";
  return {
    isSandbox,
    authHost: isSandbox ? "https://auth.sandbox.ebay.com" : "https://auth.ebay.com",
    apiHost: isSandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com",
  };
}

export function basicAuthHeader(config) {
  return "Basic " + Buffer.from(`${config.appId}:${config.certId}`).toString("base64");
}
