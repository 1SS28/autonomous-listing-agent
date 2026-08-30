#!/usr/bin/env node
// Local MCP server with ONE job: PUT a local file to a presigned upload URL
// (like the ones Magic Hour's MCP hands back) using Node's built-in fetch,
// entirely in-process. No exec, no curl, no shell so it can't be broken
// by shell quoting/escaping, PATH issues, or a broken exec environment.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
    }[ext] || "application/octet-stream"
  );
}

const server = new McpServer({ name: "local-upload-server", version: "1.0.0" });

server.registerTool(
  "upload_file_to_url",
  {
    title: "Upload Local File To Presigned URL",
    description:
      "Uploads a local file on this machine to a presigned/signed upload URL (e.g. one returned by Magic Hour's or another service's 'get upload URL' tool) via an HTTP PUT, using Node's fetch directly - no shell, no curl, no exec. Use this instead of trying to run curl yourself whenever you need to get a local file to a presigned URL.",
    inputSchema: z
      .object({
        file_path: z.string().describe("Absolute local path to the file to upload"),
        upload_url: z.string().describe("The full presigned upload URL to PUT the file to"),
        content_type: z
          .string()
          .optional()
          .describe(
            "Content-Type header to send. If omitted, guessed from the file extension. If the upload fails with a signature/403 error, try calling again with content_type omitted or set to 'application/octet-stream' - some presigned URLs are signed against a specific content type and reject any other."
          ),
      })
      .strict(),
  },
  async (params) => {
    if (!existsSync(params.file_path)) {
      throw new Error(`File not found: ${params.file_path}`);
    }

    const stat = statSync(params.file_path);
    const fileBuffer = readFileSync(params.file_path);
    const contentType = params.content_type || guessContentType(params.file_path);

    const res = await fetch(params.upload_url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: fileBuffer,
    });

    const bodyText = await res.text().catch(() => "");

    if (!res.ok) {
      throw new Error(
        `Upload failed: HTTP ${res.status} ${res.statusText}. File size was ${stat.size} bytes, content-type sent was "${contentType}". Response body: ${bodyText.slice(0, 500)}`
      );
    }

    return {
      content: [
        {
          type: "text",
          text: `Uploaded ${stat.size} bytes from ${params.file_path} to the presigned URL successfully (HTTP ${res.status}).`,
        },
      ],
    };
  }
);

server.registerTool(
  "download_url_to_file",
  {
    title: "Download URL To Local File",
    description:
      "Downloads any URL (including presigned/signed download URLs, e.g. Magic Hour output images) to a local file path on this machine, using Node's fetch directly - no shell, no curl, no exec. Use this instead of guessing at a service's own download tool when you just need a URL saved to disk (for example, before handing a generated image to etsy_upload_listing_image).",
    inputSchema: z
      .object({
        url: z.string().describe("The full URL to download"),
        save_path: z.string().describe("Absolute local file path to save the downloaded content to"),
      })
      .strict(),
  },
  async (params) => {
    const res = await fetch(params.url);
    const bodyBuffer = Buffer.from(await res.arrayBuffer());

    if (!res.ok) {
      throw new Error(
        `Download failed: HTTP ${res.status} ${res.statusText} from ${params.url}`
      );
    }

    mkdirSync(path.dirname(params.save_path), { recursive: true });
    writeFileSync(params.save_path, bodyBuffer);

    return {
      content: [
        {
          type: "text",
          text: `Downloaded ${bodyBuffer.length} bytes from the URL and saved to ${params.save_path}.`,
        },
      ],
    };
  }
);

// Optional: image-host.json alongside this file, containing
//   { "workerUrl": "https://....workers.dev", "uploadToken": "..." }
// Enables the host_image_for_listing tool below which is what I did.
function loadImageHostConfig() {
  const p = path.join(path.dirname(fileURLToPath(import.meta.url)), "image-host.json");
  if (!existsSync(p)) {
    throw new Error(
      `Missing ${p}. Create it with {"workerUrl": "...", "uploadToken": "..."} - see the README.`
    );
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

server.registerTool(
  "host_image_for_listing",
  {
    title: "Host Image At A Short Public URL",
    description:
      "Uploads a local image to your own Cloudflare Worker and returns a SHORT, permanent, publicly accessible URL. Use this for every marketplace listing image. eBay caps image URLs at 500 characters and fetches them itself, while Magic Hour's signed URLs are 800+ characters and return 403 without their auth parameters - so Magic Hour URLs can NOT be given to eBay directly. Download the generated image first with download_url_to_file, then pass it through this tool, then use the returned URL in the listing.",
    inputSchema: z
      .object({
        file_path: z.string().describe("Absolute local path to the image file"),
      })
      .strict(),
  },
  async (params) => {
    if (!existsSync(params.file_path)) {
      throw new Error(`File not found: ${params.file_path}`);
    }

    const config = loadImageHostConfig();
    const fileBuffer = readFileSync(params.file_path);
    const contentType = guessContentType(params.file_path);

    const res = await fetch(`${config.workerUrl.replace(/\/$/, "")}/img`, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "X-Upload-Token": config.uploadToken,
      },
      body: fileBuffer,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Image hosting failed: HTTP ${res.status}. ${text.slice(0, 300)}`);
    }

    const data = JSON.parse(text);
    return {
      content: [
        {
          type: "text",
          text: `Hosted at ${data.url} (${data.bytes} bytes, ${data.url.length} chars - eBay's limit is 500). Use this URL directly in the listing.`,
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Local upload MCP server started on stdio");
}

main().catch((err) => {
  console.error("Local upload MCP server failed to start:", err);
  process.exit(1);
});
