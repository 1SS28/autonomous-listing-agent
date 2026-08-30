# OpenClaw Etsy Listing Skill

A small local MCP server that lets your OpenClaw agent create, review, and
publish listings in **one Etsy shop**, plus a one-time script to connect
your Etsy account.

Unlike the Magic Hour connection, this MCP server runs **locally on your
own PC** (as a subprocess OpenClaw starts), so it can read image files
directly off your disk - no upload-URL workaround needed for photos.

## What's in here

- `etsy-authorize.js` - run this **once** to connect your Etsy account
  (opens a browser approval flow, saves tokens locally).
- `etsy-mcp-server.js` - the actual MCP server OpenClaw talks to. You never
  run this by hand; OpenClaw starts it automatically.
- `config.example.json` - template for your keys; copy it to
  `etsy-config.json` and fill it in.
- `package.json` - dependencies (the official MCP SDK + zod).

## Setup

### 1. Install dependencies

Open a terminal in this folder and run:

```
npm install
```

### 2. Fill in your Etsy app credentials

Copy `config.example.json` to a new file named `etsy-config.json` in the
same folder, and fill in:

- `keystring` - from `etsy.com/developers/your-apps`
- `sharedSecret` - same page
- `shopId` - the numeric ID of your shop (visible in your shop's admin
  URL, or ask the agent to fetch it once you're connected)

Leave `redirectUri` and `scopes` as-is unless you have a reason to change
them.

**Treat `etsy-config.json` like a password file** - never paste its
contents into a chat message (including to me), and don't commit it to
any public git repo.

### 3. Register the redirect URI with Etsy

In your app's settings at `etsy.com/developers/your-apps`, add this exact
callback URL to the app's allowed redirect URIs:

```
http://localhost:3003/oauth/redirect
```

It must match exactly (case-sensitive) or the authorization step will fail.

### 4. Run the one-time authorization

```
node etsy-authorize.js
```

This prints a URL - open it in your browser, log into the Etsy account
that owns your shop, and click approve. The script saves your tokens to
a new `etsy-tokens.json` file and exits. **This file is also
credential-like - never share it.**

You'll need to redo this step roughly every 90 days, since that's how
long Etsy's refresh token lasts.

### 5. Wire the MCP server into OpenClaw

In your terminal, run (use the **full absolute path** to this folder -
find it by running `pwd` while inside the folder):

```
openclaw mcp add etsy --command node --arg "FULL\PATH\TO\etsy-mcp-server.js" --cwd "FULL\PATH\TO\this-folder"
```

Then verify it's wired up correctly:

```
openclaw mcp doctor etsy --probe
```

Restart the gateway so it picks up the new MCP server.

### 6. Test it, in this order

1. Ask the agent to run `etsy_search_taxonomy` for a category related to
   something you might sell (e.g. "jewelry"), `etsy_list_shipping_profiles`,
   and `etsy_list_readiness_states` - confirm these return real data from
   your shop. This proves the OAuth connection actually works before
   anything gets created. If `etsy_list_readiness_states` comes back empty,
   run `etsy_create_readiness_state` once first (Etsy requires at least one
   "processing profile" - e.g. ready_to_ship, 1-3 days - before you can
   create a physical listing).
2. Ask it to create ONE draft listing with obviously fake/test details.
   Confirm with `etsy_get_listing` (or by checking your Etsy Shop Manager →
   Listings → Drafts tab) that it shows up as a **draft**, not live.
3. Only after you've visually confirmed the draft looks right, tell the
   agent to publish it - this is the step that can incur Etsy's per-listing
   fee and make something publicly visible, so it should never happen
   without you explicitly saying so.
4. Delete or deactivate that test listing from Etsy's dashboard once
   you've confirmed the flow works end to end.

## The tools this exposes to your agent

- `etsy_search_taxonomy` - look up the category ID needed for a listing
- `etsy_list_shipping_profiles` - look up your shop's shipping profile IDs
- `etsy_list_readiness_states` - look up your shop's processing-profile IDs
- `etsy_create_readiness_state` - create one if none exist yet (one-time, usually)
- `etsy_create_draft_listing` - creates a draft (never auto-published)
- `etsy_upload_listing_image` - attaches a local photo to a listing
- `etsy_get_listing` - fetch a listing's current details for review
- `etsy_publish_listing` - makes a draft live (should require your explicit go-ahead)

## Changelog

- Added `etsy_list_readiness_states` / `etsy_create_readiness_state`, and
  `etsy_create_draft_listing` now sends `readiness_state_id` and uses
  `?legacy=false` - Etsy started requiring a "processing profile" for all
  physical listings partway through 2025/2026, and the first version of
  this skill predated that change.

## Notes / known limitations

- This only manages **one shop** (whichever `shopId` you configure).
- Etsy's listing fields (like `when_made` buckets or whether
  `readiness_state_id` is required) can shift over time - if
  `etsy_create_draft_listing` errors with a validation message, check
  Etsy's current Listings tutorial at
  `developers.etsy.com/documentation/tutorials/listings` for what changed.
- If `etsy_publish_listing` or any tool fails with an auth error even
  though `etsy-tokens.json` exists, your refresh token has likely expired
  (90-day lifetime) - re-run `node etsy-authorize.js`.
