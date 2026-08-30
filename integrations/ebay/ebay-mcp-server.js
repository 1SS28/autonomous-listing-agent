#!/usr/bin/env node
// Local MCP server exposing eBay Sell API listing tools to OpenClaw.
// Requires ebay-config.json and ebay-tokens.json (from ebay-authorize.js).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, loadTokens, saveTokens, hosts, basicAuthHeader } from "./ebay-common.js";

const config = loadConfig();
const { apiHost, isSandbox } = hosts(config);

const MARKETPLACE = config.marketplaceId || "EBAY_CA";
const CONTENT_LANGUAGE = config.contentLanguage || "en-CA";
const CURRENCY = config.currency || "CAD";

async function ensureFreshToken() {
  let tokens = loadTokens();

  if (tokens.environment && tokens.environment !== config.environment) {
    throw new Error(
      `Token/config environment mismatch: tokens were created for "${tokens.environment}" but config says "${config.environment}". Re-run ebay-authorize.js after changing environments - sandbox and production credentials never cross over.`
    );
  }

  // Refresh 5 minutes early to avoid racing the 2-hour expiry.
  if (Date.now() < tokens.expires_at - 5 * 60 * 1000) {
    return tokens.access_token;
  }

  const res = await fetch(`${apiHost}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(config),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `Failed to refresh eBay token: ${JSON.stringify(data)}. The refresh token may have expired or been revoked - re-run ebay-authorize.js.`
    );
  }

  tokens = {
    ...tokens,
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  saveTokens(tokens);
  return tokens.access_token;
}

async function ebayFetch(pathSuffix, options = {}) {
  const accessToken = await ensureFreshToken();
  const res = await fetch(`${apiHost}${pathSuffix}`, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      // eBay requires BOTH of these on several Inventory API endpoints, and
      // validates them strictly against RFC 5646 - "en-CA" is accepted,
      // "en_CA" is rejected with "Invalid value for header Accept-Language".
      "Content-Language": CONTENT_LANGUAGE,
      "Accept-Language": CONTENT_LANGUAGE,
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`eBay API error (${res.status}) on ${pathSuffix}: ${JSON.stringify(data)}`);
  }
  return data;
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

const server = new McpServer({ name: "ebay-listing-server", version: "1.0.0" });

server.registerTool(
  "ebay_check_setup",
  {
    title: "Check eBay Account Setup",
    description:
      "Checks everything eBay requires before a listing can be published: the three business policies (payment, return, fulfillment) and at least one merchant location. Run this FIRST before trying to create any listing - publishing fails if any of these are missing.",
    inputSchema: z.object({}).strict(),
  },
  async () => {
    const report = { environment: config.environment, marketplace: MARKETPLACE };
    const q = `?marketplace_id=${MARKETPLACE}`;

    for (const [key, endpoint] of [
      ["payment_policies", `/sell/account/v1/payment_policy${q}`],
      ["return_policies", `/sell/account/v1/return_policy${q}`],
      ["fulfillment_policies", `/sell/account/v1/fulfillment_policy${q}`],
    ]) {
      try {
        const data = await ebayFetch(endpoint);
        report[key] = (data[key.replace(/ies$/, "ies")] || data[Object.keys(data)[0]] || [])
          .map?.((p) => ({
            id: p.paymentPolicyId || p.returnPolicyId || p.fulfillmentPolicyId,
            name: p.name,
          })) || data;
      } catch (err) {
        report[key] = `ERROR: ${err.message}`;
      }
    }

    try {
      const locs = await ebayFetch(`/sell/inventory/v1/location`);
      report.locations = (locs.locations || []).map((l) => ({
        merchantLocationKey: l.merchantLocationKey,
        name: l.name,
      }));
    } catch (err) {
      report.locations = `ERROR: ${err.message}`;
    }

    const missing = [];
    for (const k of ["payment_policies", "return_policies", "fulfillment_policies", "locations"]) {
      const v = report[k];
      if (typeof v === "string" || !Array.isArray(v) || v.length === 0) missing.push(k);
    }

    return textResult(
      JSON.stringify(report, null, 2) +
        (missing.length
          ? `\n\nMISSING / NOT USABLE: ${missing.join(", ")}. Publishing will fail until these exist. Business policies are created in eBay's Seller Hub (Account Settings > Business Policies, after opting in). A location can be created with ebay_create_location.`
          : "\n\nAll prerequisites look present.")
    );
  }
);

server.registerTool(
  "ebay_create_location",
  {
    title: "Create eBay Merchant Location",
    description:
      "Creates a merchant/inventory location, required before publishing. Only needed once. Use ebay_check_setup first to see whether one already exists.",
    inputSchema: z
      .object({
        merchantLocationKey: z
          .string()
          .describe("Short unique key you choose, e.g. 'home' - referenced later when creating offers"),
        name: z.string(),
        addressLine1: z.string().optional(),
        city: z.string(),
        stateOrProvince: z.string(),
        postalCode: z.string(),
        country: z.string().describe("Two-letter country code, e.g. CA or US"),
      })
      .strict(),
  },
  async (params) => {
    await ebayFetch(`/sell/inventory/v1/location/${encodeURIComponent(params.merchantLocationKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: params.name,
        location: {
          address: {
            addressLine1: params.addressLine1,
            city: params.city,
            stateOrProvince: params.stateOrProvince,
            postalCode: params.postalCode,
            country: params.country,
          },
        },
        merchantLocationStatus: "ENABLED",
        locationTypes: ["STORE"],
      }),
    });
    return textResult(`Location "${params.merchantLocationKey}" created.`);
  }
);

server.registerTool(
  "ebay_suggest_category",
  {
    title: "Suggest eBay Category",
    description:
      "Given a plain-English item description, asks eBay which categories fit and returns their categoryId values. eBay categories are far more permissive than Etsy's - ordinary used goods are fine here.",
    inputSchema: z.object({ query: z.string() }).strict(),
  },
  async (params) => {
    const treeRes = await ebayFetch(
      `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE}`
    );
    const treeId = treeRes.categoryTreeId;

    const sug = await ebayFetch(
      `/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions?q=${encodeURIComponent(params.query)}`
    );

    const results = (sug.categorySuggestions || []).slice(0, 8).map((s) => ({
      categoryId: s.category?.categoryId,
      categoryName: s.category?.categoryName,
      path: (s.categoryTreeNodeAncestors || [])
        .map((a) => a.categoryName)
        .reverse()
        .join(" > "),
    }));

    return textResult(JSON.stringify(results, null, 2));
  }
);

server.registerTool(
  "ebay_create_inventory_item",
  {
    title: "Create eBay Inventory Item",
    description:
      "Step 1 of 3. Creates/replaces an inventory item record. Nothing is listed or public at this stage. IMPORTANT: imageUrls must be publicly reachable HTTPS URLs - eBay fetches them itself. Magic Hour output URLs can be passed directly here; do NOT download them first.",
    inputSchema: z
      .object({
        sku: z.string().describe("Your own unique identifier for this item, e.g. 'calc-fx350ms-001'"),
        title: z.string().describe("Item title, max 80 characters on eBay"),
        description: z.string(),
        imageUrls: z.array(z.string()).min(1).describe("Publicly reachable HTTPS image URLs"),
        quantity: z.number().int().positive(),
        condition: z
          .enum([
            "NEW",
            "LIKE_NEW",
            "NEW_OTHER",
            "USED_EXCELLENT",
            "USED_VERY_GOOD",
            "USED_GOOD",
            "USED_ACCEPTABLE",
            "FOR_PARTS_OR_NOT_WORKING",
          ])
          .describe("Be honest here - condition misrepresentation causes returns and account issues"),
        aspects: z
          .record(z.array(z.string()))
          .optional()
          .describe(
            'Item specifics as {"Brand":["Casio"],"Model":["fx-350MS"]}. Some categories require certain aspects; publish will tell you which if missing.'
          ),
      })
      .strict(),
  },
  async (params) => {
    await ebayFetch(`/sell/inventory/v1/inventory_item/${encodeURIComponent(params.sku)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        availability: { shipToLocationAvailability: { quantity: params.quantity } },
        condition: params.condition,
        product: {
          title: params.title,
          description: params.description,
          imageUrls: params.imageUrls,
          ...(params.aspects ? { aspects: params.aspects } : {}),
        },
      }),
    });

    return textResult(
      `Inventory item "${params.sku}" saved. Nothing is public yet. Next: ebay_create_offer.`
    );
  }
);

server.registerTool(
  "ebay_create_offer",
  {
    title: "Create eBay Offer",
    description:
      "Step 2 of 3. Attaches price, category, and policies to an inventory item. Still NOT public - this creates an unpublished offer. Get the policy IDs and location key from ebay_check_setup first.",
    inputSchema: z
      .object({
        sku: z.string(),
        price: z.number().positive(),
        quantity: z.number().int().positive(),
        categoryId: z.string().describe("From ebay_suggest_category"),
        merchantLocationKey: z.string(),
        paymentPolicyId: z.string(),
        returnPolicyId: z.string(),
        fulfillmentPolicyId: z.string(),
        listingDescription: z.string().optional(),
      })
      .strict(),
  },
  async (params) => {
    const offer = await ebayFetch(`/sell/inventory/v1/offer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sku: params.sku,
        marketplaceId: MARKETPLACE,
        format: "FIXED_PRICE",
        availableQuantity: params.quantity,
        categoryId: params.categoryId,
        merchantLocationKey: params.merchantLocationKey,
        ...(params.listingDescription ? { listingDescription: params.listingDescription } : {}),
        pricingSummary: { price: { value: String(params.price), currency: CURRENCY } },
        listingPolicies: {
          paymentPolicyId: params.paymentPolicyId,
          returnPolicyId: params.returnPolicyId,
          fulfillmentPolicyId: params.fulfillmentPolicyId,
        },
      }),
    });

    return textResult(
      `Offer created. offerId=${offer.offerId}. STILL NOT PUBLIC. Show the user the full listing details and photos and get an explicit yes before calling ebay_publish_offer.`
    );
  }
);

server.registerTool(
  "ebay_get_offer",
  {
    title: "Get eBay Offer",
    description: "Fetches an offer's current details and status, for review before publishing.",
    inputSchema: z.object({ offerId: z.string() }).strict(),
  },
  async (params) => {
    const offer = await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(params.offerId)}`);
    return textResult(JSON.stringify(offer, null, 2));
  }
);

server.registerTool(
  "ebay_publish_offer",
  {
    title: "Publish eBay Offer",
    description:
      "Step 3 of 3. Makes the listing LIVE and publicly visible on eBay, and in production may incur listing/selling fees. Only call this after the human has explicitly approved the offer and its photos - never automatically after creating an offer.",
    inputSchema: z.object({ offerId: z.string() }).strict(),
  },
  async (params) => {
    const result = await ebayFetch(
      `/sell/inventory/v1/offer/${encodeURIComponent(params.offerId)}/publish`,
      { method: "POST", headers: { "Content-Type": "application/json" } }
    );

    return textResult(
      `Published. listingId=${result.listingId}. Environment: ${config.environment}` +
        (isSandbox
          ? " (SANDBOX - this is not a real listing and no real money is involved)."
          : " (PRODUCTION - this is a real, live listing).")
    );
  }
);

server.registerTool(
  "ebay_withdraw_offer",
  {
    title: "Withdraw eBay Offer",
    description:
      "Ends a published listing and reverts the offer to unpublished. Use this to clean up test listings.",
    inputSchema: z.object({ offerId: z.string() }).strict(),
  },
  async (params) => {
    await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(params.offerId)}/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    return textResult(`Offer ${params.offerId} withdrawn - the listing is no longer live.`);
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`eBay MCP server started on stdio (environment: ${config.environment})`);
}

main().catch((err) => {
  console.error("eBay MCP server failed to start:", err);
  process.exit(1);
});
