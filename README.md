# Autonomous Marketplace Listing Agent

This project connects an OpenClaw agent to eBay, Etsy, and a small local file-transfer service. A user can send a product photo through the agent, generate cleaner product images, prepare marketplace listing data, review the result, and publish.

The repository contains three custom MCP integrations built for the project. OpenClaw provides the agent runtime and Telegram interface. Magic Hour provides image generation. Those external systems are not copied into this repository.

## What is included

- `integrations/ebay`: OAuth setup and tools for inventory items, offers, business-policy checks, publishing, and withdrawal
- `integrations/etsy`: OAuth with PKCE and tools for taxonomy lookup, draft creation, image upload, review, and publishing
- `integrations/local-upload`: local file upload, URL download, and short public image hosting for marketplace-compatible images
- `docs/ARCHITECTURE.md`: the end-to-end workflow and the boundaries between services

## What is deliberately excluded

This public copy does not contain live API credentials, OAuth tokens, marketplace account identifiers, OpenClaw identity files, conversation memories, logs, incoming user media, or runtime configuration. The example configuration files contain placeholders only.

## End-to-end flow

1. The user sends a product photo and listing request to the OpenClaw agent.
2. The agent transfers the local image to Magic Hour through the local upload MCP server.
3. Magic Hour generates product images.
4. The agent downloads the generated images.
5. Etsy receives local image files directly. eBay receives public image URLs, either directly from the image service when compatible or through the short-URL hosting tool when needed.
6. The marketplace MCP servers create reviewable listing data.
7. Publishing is a separate tool call so it can be kept behind an explicit human confirmation step.

## Running the integrations

Each integration is an independent Node.js project. Enter its folder and install its dependencies:

```powershell
npm install
```

Then follow that integration's README. You must create local configuration files from the provided examples and complete the marketplace OAuth flow. Local configuration and token files are ignored by Git.

## Project status

The eBay path has completed an end-to-end live listing run. The Etsy path has completed draft creation with uploaded images. This repository is a sanitized project copy, not a hosted service or a turnkey marketplace product.

## Security note

Do not commit real configuration or token files. If a credential has ever been committed, ignoring or deleting the file later is not enough. Revoke or rotate the credential because it remains in Git history.
