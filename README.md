# FrameCraft Studio

A photo and video editor that runs entirely in the browser. It has no server, no paid APIs, no build step and no dependencies, so you can host it for free on GitHub Pages.

- `index.html` is the landing page with pricing.
- `app.html` is the editor, with **Photo** mode (layers, tools, filters) and **Video** mode (multi-track timeline, titles, transitions, export).

## Run locally

```sh
python3 -m http.server 8080   # then open http://localhost:8080
```

ES modules need a web server, so opening the file directly with `file://` won't work.

## Hosting

GitHub Pages serves the `main` branch at **https://framecraft.syntaxrewrite.com** (set by the `CNAME` file). DNS for `syntaxrewrite.com` is at Namecheap and needs one record:

| Type | Host | Value |
|---|---|---|
| CNAME | `framecraft` | `subtoferalsloth11.github.io.` |

Once the record resolves, GitHub issues the HTTPS certificate. Then turn on Settings → Pages → Enforce HTTPS.

## Getting paid

You sell Pro as a subscription. Each Pro license key is cryptographically signed by a private key that only you hold, and the app checks keys offline.

1. **Create the products.** In Stripe (free account, you pay only fees per sale), go to Payment Links and create:
   - FrameCraft Pro Monthly: A$9, recurring monthly
   - FrameCraft Pro Yearly: A$79, recurring yearly
   - Under *Confirmation page*, add the message "Your license key will be emailed within 24 hours."
2. **Paste the links** into `js/config.js` (`stripeMonthlyLink`, `stripeYearlyLink`) and set `supportEmail`. Commit and push.
3. **When a payment comes in** (Stripe emails you), issue a key and email it to the customer:
   ```sh
   node tools/license.mjs issue customer@email.com 31    # monthly (31 days)
   node tools/license.mjs issue customer@email.com 366   # yearly
   node tools/license.mjs issue friend@email.com 0       # lifetime
   ```
   When a monthly subscription renews, issue a new 31-day key.
4. **Back up `~/.framecraft/private.jwk`.** If you lose it, you can't issue keys that match the public key built into the app. Never commit or share it.

Run `node tools/license.mjs verify <key>` to check a key.

### Free vs Pro

Limits are set in `js/config.js` under `free`.

| | Free | Pro |
|---|---|---|
| Watermark on exports | yes | no |
| Photo export size | 1920 px | full |
| Layers / video tracks | 5 / 3 | unlimited |
| Video export | 720p, 60 s | up to 4K, any length |
| Curves, clone stamp, denoise, motion blur, chroma key, keyframes | no | yes |
| Save projects | no (opening is free) | yes |
