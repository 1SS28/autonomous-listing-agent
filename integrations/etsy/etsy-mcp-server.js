#!/usr/bin/env node
// Local MCP server exposing Etsy listing tools to OpenClaw.
// Requires etsy-config.json (your app keys + shop ID) and etsy-tokens.json
// (created by running `node etsy-authorize.js` once) to already exist.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "etsy-config.json");
const TOKENS_PATH = path.join(__dirname, "etsy-tokens.json");

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Missing ${CONFIG_PATH}. Copy config.example.json to etsy-config.json and fill it in.`
    );
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

function loadTokens() {
  if (!existsSync(TOKENS_PATH)) {
    throw new Error(
      `Missing ${TOKENS_PATH}. Run "node etsy-authorize.js" once first to connect your Etsy account.`
    );
  }
  return JSON.parse(readFileSync(TOKENS_PATH, "utf8"));
}

function saveTokens(tokens) {
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

const config = loadConfig();

async function ensureFreshToken() {
  let tokens = loadTokens();
  // Refresh 5 minutes early to avoid racing the 1-hour expiry.
  if (Date.now() < tokens.expires_at - 5 * 60 * 1000) {
    return tokens.access_token;
  }

  const res = await fetch("https://api.etsy.com/v3/public/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.keystring,
      refresh_token: tokens.refresh_token,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `Failed to refresh Etsy token: ${JSON.stringify(data)}. The refresh token may have expired (they last ~90 days) - re-run etsy-authorize.js.`
    );
  }

  tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  saveTokens(tokens);
  return tokens.access_token;
}

async function etsyFetch(pathSuffix, options = {}) {
  const accessToken = await ensureFreshToken();
  const res = await fetch(`https://api.etsy.com/v3/application${pathSuffix}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${accessToken}`,
      "x-api-key": `${config.keystring}:${config.sharedSecret}`,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Etsy API error (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

const server = new McpServer({ name: "etsy-listing-server", version: "1.0.0" });

server.registerTool(
  "etsy_search_taxonomy",
  {
    title: "Search Etsy Category Taxonomy",
    description:
      "Searches Etsy's category tree by keyword to find the correct taxonomy_id needed to create a listing (e.g. search 'jewelry' or 'mug').",
    inputSchema: z.object({ query: z.string() }).strict(),
  },
  async (params) => {
    const data = await etsyFetch(`/seller-taxonomy/nodes`);
    const q = params.query.toLowerCase();
    const matches = (data.results || [])
      .filter((n) => n.name?.toLowerCase().includes(q))
      .slice(0, 15)
      .map((n) => ({ id: n.id, name: n.name }));
    return {
      content: [
        {
          type: "text",
          text: matches.length ? JSON.stringify(matches, null, 2) : "No matches found for that query.",
        },
      ],
    };
  }
);

server.registerTool(
  "etsy_list_shipping_profiles",
  {
    title: "List Shop Shipping Profiles",
    description:
      "Lists this shop's existing shipping profiles and their IDs - one is required as shipping_profile_id when creating a listing.",
    inputSchema: z.object({}).strict(),
  },
  async () => {
    const data = await etsyFetch(`/shops/${config.shopId}/shipping-profiles`);
    const results = (data.results || []).map((p) => ({
      shipping_profile_id: p.shipping_profile_id,
      title: p.title,
    }));
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
);

server.registerTool(
  "etsy_list_readiness_states",
  {
    title: "List Shop Readiness States (Processing Profiles)",
    description:
      "Lists this shop's existing readiness-state/processing profiles and their IDs - one is required as readiness_state_id when creating a listing. If this returns empty, call etsy_create_readiness_state first.",
    inputSchema: z.object({}).strict(),
  },
  async () => {
    const data = await etsyFetch(`/shops/${config.shopId}/readiness-state-definitions`);
    return { content: [{ type: "text", text: JSON.stringify(data.results || data, null, 2) }] };
  }
);

server.registerTool(
  "etsy_create_readiness_state",
  {
    title: "Create Shop Readiness State (Processing Profile)",
    description:
      "Creates a new readiness-state/processing profile for the shop (Etsy's newer replacement for plain processing times). Only needed once if etsy_list_readiness_states comes back empty.",
    inputSchema: z
      .object({
        readiness_state: z.enum(["ready_to_ship", "made_to_order"]),
        min_processing_time: z.number().int().positive(),
        max_processing_time: z.number().int().positive(),
        processing_time_unit: z.enum(["days", "weeks"]).default("days"),
      })
      .strict(),
  },
  async (params) => {
    const data = await etsyFetch(`/shops/${config.shopId}/readiness-state-definitions`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        readiness_state: params.readiness_state,
        min_processing_time: String(params.min_processing_time),
        max_processing_time: String(params.max_processing_time),
        processing_time_unit: params.processing_time_unit,
      }),
    });
    return {
      content: [
        {
          type: "text",
          text: `Created readiness state. readiness_state_id=${data.readiness_state_id ?? JSON.stringify(data)}`,
        },
      ],
    };
  }
);

server.registerTool(
  "etsy_create_draft_listing",
  {
    title: "Create Draft Etsy Listing",
    description:
      "Creates a new DRAFT listing in the connected Etsy shop. It is NOT published or publicly visible until etsy_publish_listing is called. Always show the draft details and photos to the human for approval before publishing.",
    inputSchema: z
      .object({
        title: z.string().describe("Listing title, max 140 characters"),
        description: z.string().describe("Full listing description"),
        price: z.number().positive().describe("Price in dollars, e.g. 24.99"),
        quantity: z.number().int().positive().describe("How many are available"),
        who_made: z.enum(["i_did", "someone_else", "collective"]).default("i_did"),
        when_made: z
          .string()
          .describe("Etsy when_made bucket, e.g. '2020_2026' or 'made_to_order' - ask if unsure"),
        taxonomy_id: z
          .number()
          .int()
          .describe("Etsy category ID - use etsy_search_taxonomy to find it first"),
        shipping_profile_id: z
          .number()
          .int()
          .describe("Shipping profile ID - use etsy_list_shipping_profiles to find it first"),
        readiness_state_id: z
          .number()
          .int()
          .describe(
            "Readiness-state/processing-profile ID - use etsy_list_readiness_states to find it first (or etsy_create_readiness_state if none exist yet). Etsy requires this for physical listings."
          ),
      })
      .strict(),
  },
  async (params) => {
    const body = new URLSearchParams({
      quantity: String(params.quantity),
      title: params.title,
      description: params.description,
      price: String(params.price),
      who_made: params.who_made,
      when_made: params.when_made,
      taxonomy_id: String(params.taxonomy_id),
      shipping_profile_id: String(params.shipping_profile_id),
      readiness_state_id: String(params.readiness_state_id),
    });

    // legacy=false is required during Etsy's processing-profiles transition period.
    const listing = await etsyFetch(`/shops/${config.shopId}/listings?legacy=false`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    return {
      content: [
        {
          type: "text",
          text: `Draft listing created (state: ${listing.state}). listing_id=${listing.listing_id}. It is NOT live yet - upload photos with etsy_upload_listing_image, show the draft to the user for approval, then call etsy_publish_listing only after they say yes.`,
        },
      ],
    };
  }
);

server.registerTool(
  "etsy_upload_listing_image",
  {
    title: "Upload Image to Etsy Listing",
    description: "Uploads a local image file to a draft or active Etsy listing.",
    inputSchema: z
      .object({
        listing_id: z.number().int(),
        image_path: z.string().describe("Absolute local file path to the image on this machine"),
        rank: z.number().int().optional().describe("Display order, 1 = first/main photo"),
      })
      .strict(),
  },
  async (params) => {
    if (!existsSync(params.image_path)) {
      throw new Error(`File not found: ${params.image_path}`);
    }
    const accessToken = await ensureFreshToken();
    const fileBuffer = readFileSync(params.image_path);
    const form = new FormData();
    form.append("image", new Blob([fileBuffer]), path.basename(params.image_path));
    if (params.rank) form.append("rank", String(params.rank));

    const res = await fetch(
      `https://api.etsy.com/v3/application/shops/${config.shopId}/listings/${params.listing_id}/images`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "x-api-key": `${config.keystring}:${config.sharedSecret}`,
        },
        body: form,
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Etsy image upload failed (${res.status}): ${JSON.stringify(data)}`);
    }

    return {
      content: [{ type: "text", text: `Image uploaded. listing_image_id=${data.listing_image_id}` }],
    };
  }
);

server.registerTool(
  "etsy_get_listing",
  {
    title: "Get Etsy Listing",
    description: "Fetches the current details/state of a listing (draft or active) for review before publishing.",
    inputSchema: z.object({ listing_id: z.number().int() }).strict(),
  },
  async (params) => {
    const listing = await etsyFetch(`/shops/${config.shopId}/listings/${params.listing_id}`);
    return { content: [{ type: "text", text: JSON.stringify(listing, null, 2) }] };
  }
);

server.registerTool(
  "etsy_publish_listing",
  {
    title: "Publish Etsy Listing",
    description:
      "Makes a draft listing LIVE and publicly visible on Etsy, and may incur Etsy's per-listing fee. Only call this after the human has explicitly approved the draft and its photos - never call this automatically right after creating a draft.",
    inputSchema: z.object({ listing_id: z.number().int() }).strict(),
  },
  async (params) => {
    const listing = await etsyFetch(`/shops/${config.shopId}/listings/${params.listing_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state: "active" }),
    });

    return {
      content: [
        {
          type: "text",
          text: `Listing ${params.listing_id} is now "${listing.state}". Check your Etsy shop dashboard to confirm it looks right.`,
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Etsy MCP server started on stdio");
}

main().catch((err) => {
  console.error("Etsy MCP server failed to start:", err);
  process.exit(1);
});
