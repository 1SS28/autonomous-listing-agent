# OpenClaw eBay Listing Skill

A local MCP server that lets your OpenClaw agent create, review, and publish
eBay listings, plus a one-time script to connect your eBay account.

Built as the sibling of the Etsy skill, after Etsy's category rules turned
out to reject ordinary used goods. eBay has no equivalent restriction.

## Two things that are genuinely different from Etsy

**1. Photos are URLs, not direct uploads.** eBay fetches images from public
HTTPS URLs. A Magic Hour output URL can be passed directly to
`ebay_create_inventory_item` when it is publicly reachable and within eBay's
URL limits. If eBay rejects a signed URL because it is too long or depends on
authorization parameters, download the image and use the local upload server's
`host_image_for_listing` tool to create a short public URL instead.

**2. There are two completely separate eBay universes.** Sandbox and
production have different keys, different RuNames, different user accounts,
and share nothing. Sandbox listings are fake and free - which means you can
debug the entire flow without paying a cent or making anything public. Do
all your testing there first.

## Setup

### 1. Install dependencies

```
npm install
```

### 2. Get your keys from eBay

Go to `developer.ebay.com`, sign in, and find **Application Keysets**.
You want the **Sandbox** keyset to start. You need:

- **App ID (Client ID)** → goes in `appId`
- **Cert ID (Client Secret)** → goes in `certId`

### 3. Get a RuName

Near your keyset there's a link for user tokens / "Get a Token from eBay via
Your Application." In there you create a **RuName** by supplying an accept
URL and a decline URL.

Those URLs can point anywhere - you'll never actually need the page to work,
because the authorize script asks you to paste the redirected URL back in by
hand. If you have nothing better, `https://example.com/accept` and
`https://example.com/decline` are fine.

What you need out of this step is the **RuName string itself** (it looks
something like `Your-Name-YourApp-PRD-abc123-xyz789`), not the URLs.

### 4. Fill in the config

Copy `config.example.json` to `ebay-config.json` and fill in `appId`,
`certId`, and `ruName`. Leave `environment` as `"sandbox"` for now.

Adjust `marketplaceId` / `contentLanguage` / `currency` if you're not in
Canada (e.g. `EBAY_US`, `en-US`, `USD`).

**Treat `ebay-config.json` and `ebay-tokens.json` like password files** -
never paste their contents into a chat, never commit them anywhere public.

### 5. Set up business policies and a location

eBay refuses to publish anything until your account has all three business
policies plus a merchant location. In the **sandbox**, do this with your
sandbox test user; in production, with your real account.

1. Opt in to business policies in eBay's Seller Hub (Account Settings →
   Business Policies).
2. Create one each of: a **payment** policy, a **return** policy, and a
   **fulfillment** (shipping) policy.
3. The location can be created from here - see `ebay_create_location` below.

You don't have to get these perfect; they can be edited later.

### 6. Authorize

```
node ebay-authorize.js
```

It prints a URL. Open it, sign in (with your **sandbox test user** if
you're in sandbox), and click Agree. You'll land on a page that may look
blank or broken - that's expected. Copy the whole URL from the address bar
and paste it back into the terminal.

### 7. Wire it into OpenClaw

From inside this folder in Git Bash:

```
openclaw mcp add ebay --command "C:/nvm4w/nodejs/node.exe" --arg "$(pwd -W)/ebay-mcp-server.js" --cwd "$(pwd -W)"
openclaw mcp doctor ebay --probe
```

Two things that will bite you otherwise, both learned the hard way on the
Etsy build:

- Use `$(pwd -W)`, not `$(pwd)`. Git Bash's plain `pwd` returns
  `/c/Users/...` which OpenClaw (a native Windows program) cannot use.
- Use forward slashes in the Node path. A path like `C:\nvm4w\nodejs\...`
  contains `\n` sequences that get mangled.

Restart the gateway once `mcp doctor` passes.

### 8. Test, in this order

1. `ebay_check_setup` - confirms policies and location exist. Fix anything
   it flags before going further.
2. `ebay_suggest_category` for whatever you're listing.
3. `ebay_create_inventory_item` → `ebay_create_offer`. Nothing is public yet.
4. `ebay_get_offer` to review.
5. `ebay_publish_offer` - in sandbox this is free and fake, so publish at
   least once here to prove the whole chain works.
6. `ebay_withdraw_offer` to clean up.

### 9. Later: switching to production

Once the sandbox flow works end to end:

1. Get your **Production** keyset and a **production RuName**.
2. Update `ebay-config.json`: set `environment` to `"production"` and swap in
   the production `appId`, `certId`, `ruName`.
3. Delete `ebay-tokens.json` and re-run `node ebay-authorize.js`, this time
   signing in with your real eBay account.
4. Set up business policies on the real account too - sandbox ones don't
   carry over.
5. Restart the gateway.

The server refuses to run if your saved tokens were minted for a different
environment than the config says, so you can't accidentally fire sandbox
credentials at production or vice versa.

## The tools this exposes

- `ebay_check_setup` - verifies policies + location before anything else
- `ebay_create_location` - one-time merchant location creation
- `ebay_suggest_category` - plain-English → eBay categoryId
- `ebay_create_inventory_item` - step 1, image URLs go here
- `ebay_create_offer` - step 2, price/category/policies, still not public
- `ebay_get_offer` - review before publishing
- `ebay_publish_offer` - step 3, makes it live
- `ebay_withdraw_offer` - ends a live listing, for cleanup

## Suggested AGENTS.md addition

```
## Publishing eBay listings
eBay listing is a three-step flow: ebay_create_inventory_item, then
ebay_create_offer, then ebay_publish_offer. Only the third step makes
anything public.

Before the first listing in a session, run ebay_check_setup - publishing
fails if business policies or a merchant location are missing.

Photos: eBay fetches images from public URLs itself. Pass a Magic Hour URL
directly when it is publicly reachable and within eBay's URL limits. If eBay
rejects it, download the generated image with `download_url_to_file`, host it
with `host_image_for_listing`, and pass the returned short URL into
`ebay_create_inventory_item`.

Never call ebay_publish_offer without explicit approval. Create the offer,
show the user title/description/price/photos, and wait for a clear yes.
```

## Notes / known limitations

- One eBay account per install (whichever the tokens belong to).
- Fixed-price listings only; no auctions.
- Some eBay categories require specific item aspects (Brand, Model, etc.).
  If `ebay_publish_offer` complains about missing aspects, re-run
  `ebay_create_inventory_item` with those filled into `aspects`.
- If any tool fails with an auth error, your refresh token has expired or
  been revoked - re-run `node ebay-authorize.js`.
