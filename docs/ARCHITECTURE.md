# Architecture

## Components

### OpenClaw

OpenClaw handles the conversation, tool selection, and Telegram channel. Its live workspace is intentionally not included because it also contains identity, memory, credentials, logs, and user media.

### Magic Hour

Magic Hour generates the product images. Its remote tools cannot read a local Windows file path, so the local upload integration transfers the input image to a presigned URL first.

### Local upload MCP server

This server keeps file transfer inside a Node.js process instead of passing presigned URLs through shell commands. It exposes tools to:

- upload a local file to a presigned URL
- download a remote result to a local file
- upload an image to a protected Cloudflare Worker and receive a short public URL

eBay accepts public HTTPS image URLs. The last operation is a fallback for generated signed URLs that exceed eBay's URL limit or depend on authorization parameters.

### eBay MCP server

The eBay integration separates listing work into inventory, offer, and publishing operations. It also checks account policies and merchant-location setup, finds categories, refreshes OAuth tokens, and supports sandbox and production environments.

### Etsy MCP server

The Etsy integration handles OAuth with PKCE, taxonomy lookup, shipping and processing profiles, draft creation, local image upload, listing review, and publishing.

## Data flow

```text
Telegram photo
    |
    v
OpenClaw agent
    |
    +--> local upload MCP --> Magic Hour --> generated image URLs
    |                              |
    |                              v
    |                       download locally
    |                              |
    |                  +-----------+-----------+
    |                  |                       |
    |                  v                       v
    |          Etsy image upload       short public hosting
    |                  |                       |
    |                  v                       v
    +----------> Etsy draft             eBay inventory + offer
                       |                       |
                       +---- human review -----+
                                   |
                                   v
                           separate publish call
```

## Safety boundaries

- Draft or offer creation is separate from publishing.
- The agent should show the title, description, price, condition, and photos before a publish call under certain conditions.
- Product identifiers should come from the item or its packaging, not be invented.
- Marketplace tokens and app secrets stay in ignored local files.
- The public repository contains example configuration only.

## Repository boundary

The custom integrations are the project-owned code in this repository. The OpenClaw runtime, Telegram, Magic Hour, Cloudflare deployment, eBay, and Etsy are external dependencies. This distinction is intentional so the repository demonstrates the integration work without publishing private runtime state.
