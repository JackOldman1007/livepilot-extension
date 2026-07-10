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

## Confirm you have the newest build

Open your TikTok **LIVE product dashboard** tab → open DevTools (F12) → **Console**. You should see:

```
[LivePilot AutoPin] …armed… Press Alt+Shift+L to download the attempt log.
```

If it does **not** mention `Alt+Shift+L`, you're on an old build — reload the extension.

## Using auto-pin

1. Keep the TikTok LIVE product dashboard tab open: `shop.tiktok.com/streamer/live/product/dashboard`
2. In the Inventory system (**Inventory → In Stock**), scan the bag's QR sticker.
3. Within ~2 seconds a banner appears bottom-right of the dashboard tab; a green **📌 pinned to the live** confirms it's pinned for viewers.

**Review a session:** press **Alt + Shift + L** on the dashboard tab to download `autopin-log-YYYY-MM-DD.jsonl` — one line per scan (pinned / already pinned / not in showcase / error + step).

Full operator manual: *(shared separately by your team lead.)*
