# LivePilot Chrome Extension

Auto-pins the QR-scanned bag on your TikTok LIVE product dashboard, plus the LivePilot host tools. This is a **public mirror of the extension only** — it contains no server code or secrets.

## Download the newest version (always up to date)

**One-click, no login:**
👉 https://github.com/JackOldman1007/livepilot-extension/archive/refs/heads/main.zip

This link always gives the latest version. Download it whenever the system is updated.

## Install / update

1. Download the zip above and **unzip** it → you get a folder like `livepilot-extension-main`.
2. Open Chrome → `chrome://extensions`
3. Turn **Developer mode** ON (top-right).
4. **First time:** click **Load unpacked** → select the unzipped folder.
   **Updating:** replace the old folder's contents with the new ones, then click the **↻ reload** icon on the LivePilot card.
5. If Chrome asks, approve the permission for `patina-luxe.com`.
6. **Enter the Live Chat Ingest token** — see below. Without it the Request List
   stays empty during a live.

## One-time setup on each computer: the Live Chat Ingest token

The extension sends live comments and viewer activity to the La Patina system,
which is what fills the **Request List** and the on-stream overlay. The server
now requires a token so that only your team can post into it.

The token is **not** in this repo on purpose — this is a public download, so a
token here would be public too. Ask your team lead for it (send it privately,
not in a group chat).

1. Click the **LivePilot** icon to open the side panel.
2. Go to the **Settings** tab.
3. Under **Live Chat Ingest**, paste the token into the box.
4. Click **Save Ingest Token**. You should see *"Token saved"* in green.

It is saved on that computer and survives Chrome restarts, so you only do this
once per machine (and again if the token is ever changed).

**To check it is working:** on `chrome://extensions`, click **service worker**
under LivePilot to open its console. During a live you should see:

```
[LivePilot SW] v1 session opened: id=… at https://patina-luxe.com/api/livepilot/v1
```

If instead you see a 401 or 503, the console message tells you which problem it
is — no token set on this machine, or a token the server rejected.

## Confirm you have the newest build

Open your TikTok **LIVE product dashboard** tab → open DevTools (F12) → **Console**. You should see:

```
[LivePilot AutoPin] …armed… Press Alt+Shift+L to download the attempt log.
```

If it does **not** mention `Alt+Shift+L`, you're on an old build — reload the extension.

You can also confirm the **August 2026 build** specifically: open the side panel
→ **Settings**. If there is no **Live Chat Ingest** section, you are on an older
build and live comments will not reach the Request List — re-download using the
link above.

## Using auto-pin

1. Keep the TikTok LIVE product dashboard tab open: `shop.tiktok.com/streamer/live/product/dashboard`
2. In the Inventory system (**Inventory → In Stock**), scan the bag's QR sticker.
3. Within ~2 seconds a banner appears bottom-right of the dashboard tab; a green **📌 pinned to the live** confirms it's pinned for viewers.

**Review a session:** press **Alt + Shift + L** on the dashboard tab to download `autopin-log-YYYY-MM-DD.jsonl` — one line per scan (pinned / already pinned / not in showcase / error + step).

Full operator manual: *(shared separately by your team lead.)*
