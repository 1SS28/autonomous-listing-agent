# Local Upload MCP Server

A tiny, general-purpose MCP server with exactly one job: take a local file
and PUT it to a presigned upload URL, using Node's own `fetch` - no `exec`,
no `curl`, no shell involved at all.

## Why this exists

The original plan (documented in `AGENTS.md`) was to have the agent run
`curl` via OpenClaw's `exec` tool to upload photos to Magic Hour's presigned
URLs. On at least one machine, that broke: `exec`'s environment turned out
to be unreliable for this (even `curl.exe --version` failed inside it), and
presigned URLs contain `%`/`&` characters that are painful to pass safely
through a shell anyway. This sidesteps all of that - the upload happens
inside a normal Node process that OpenClaw itself starts and talks to over
MCP, the same way the Etsy skill works, so there's no shell in the loop to
mangle anything.

## Setup

```
npm install
```

Then wire it into OpenClaw (from inside this folder, in Git Bash use
`pwd -W` to get a real Windows-style path - see the note below if you're in
a different shell):

```
openclaw mcp add local-upload --command "PATH_TO_YOUR_NODE_EXE" --arg "$(pwd -W)/upload-mcp-server.js" --cwd "$(pwd -W)"
openclaw mcp doctor local-upload --probe
```

Use the exact same Node path you used for the Etsy server (run `where node`
if you don't remember it), and use forward slashes, not backslashes, in
that path.

Restart the gateway once `mcp doctor` shows it passing.

## Tools this server exposes

- `upload_file_to_url(file_path, upload_url, content_type?)` uploads a
local file to any presigned/signed URL via HTTP PUT. Works for Magic Hour's
upload URLs, and for anything else that hands back a presigned PUT URL.

- `download_url_to_file(url, save_path)` to save generated media locally
- `host_image_for_listing(file_path)` to upload an image to a configured
  Cloudflare Worker and return a short public URL when a marketplace cannot
  use the original signed URL

To enable image hosting, copy `image-host.example.json` to `image-host.json`
and add your Worker URL and upload token. `image-host.json` is ignored by Git.

## Update AGENTS.md

Replace the old "Uploading local photos to Magic Hour" section (the one
describing the `curl` workaround) with:

```
## Uploading local photos to Magic Hour
Magic Hour's MCP server runs remotely and cannot access local file paths directly.
When a user sends a photo to upload/edit via Magic Hour:
1. Save the incoming photo locally first.
2. Call Magic Hour's upload-urls endpoint to get a pre-signed upload URL for the asset.
3. Call the local-upload MCP server's upload_file_to_url tool with the local
   file path and that presigned URL - do NOT try to run curl or write your
   own upload code via exec. This tool exists specifically so you never have
   to do that.
4. Once uploaded, use the returned asset ID/URL in the actual generation call
   (image edit, image-to-video, etc.).
This is the correct procedure, not a workaround - do this every time rather
than re-deriving the approach from scratch.
```
