# SAFU Scanner — Robinhood Chain

A private dashboard that watches Robinhood Chain (the new Robinhood L2, chain ID 4663)
for newly created Uniswap pools, and flags basic risk signals on each new token before
you consider trading it.

## What it checks per token

- **Verified source code** on the block explorer (unverified = red flag on its own)
- **Risky functions** in the contract (mint, blacklist, pause, etc.) — the deployer's
  ability to rug you even without touching liquidity
- **Deployer wallet holdings** — what % of supply the creator still controls
- **LP lock status** — is the liquidity position burned, sent to a known locker, or
  still sitting in a wallet that can pull it whenever they want

None of this is a guarantee — it's a first filter, not a green light. Locked liquidity
can still be milked through creator fees (see the $VLAD case from July 2026), and no
tool catches every scam. Always size positions like you could lose them.

## Deploying (free)

**Straight answer on cost:** Railway (which you've used before) is not free forever for an
always-on app — after a 30-day trial it drops to $1/month in free credit, which barely
covers one tiny service and leaves no room for spikes. **Render's free tier is the better
fit for how you'll actually use this** — you check it manually before trading rather than
needing 24/7 push alerts, so its "sleeps after 15 minutes, wakes on the next visit"
behavior costs you nothing. The site now runs a fresh scan every time you open it, so
nothing is lost between sleeps.

### Option A: Render (recommended — genuinely $0/month)

1. **Push this folder to a new GitHub repo:**
   ```
   cd safu-scanner
   git init
   git add .
   git commit -m "initial commit"
   git remote add origin https://github.com/<your-username>/safu-scanner.git
   git push -u origin main
   ```
2. Go to [render.com](https://render.com) → New → Web Service → connect your `safu-scanner`
   repo.
3. Settings:
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
4. Add environment variables (Render's "Environment" tab) — copy from `.env.example`, but
   set your own:
   - `DASHBOARD_PASSWORD` → your login password
   - `SESSION_SECRET` → any random string
5. Deploy. You'll get a `.onrender.com` URL.
6. First open after any period of inactivity takes 30–60 seconds to wake up — that's
   normal, not a bug. Once it's loaded, it auto-scans immediately.

**One tradeoff to know:** free-tier disk isn't persistent, so if the service sleeps and
wakes back up, previously-seen tokens aren't remembered — but since every visit triggers
a fresh scan of the recent blocks anyway, you won't notice this in normal use.

### Option B: Railway (only if you're fine with ~$5/month eventually)

Same steps as above but on Railway instead — New Project → Deploy from GitHub repo → add
the same environment variables. Works identically, but expect Railway to ask you to
upgrade to the Hobby plan ($5/month minimum) once the trial credit runs out.


## Tuning it

All in `.env` / Railway variables:

- `MIN_LIQUIDITY_ETH` — pools with less base-asset liquidity than this are skipped
  entirely (default 0.5 ETH). Raise this if you're getting flooded with dust pools.
- `SCAN_INTERVAL_MINUTES` — how often the background scan runs.

`config.js` also has a `knownLockerContracts` set — currently empty because no
third-party locker (like UNCX) has a confirmed address on Robinhood Chain yet. If you
find one, add its address there and the scanner will recognize tokens locked through it
as "Locked" instead of "Unlocked."

## Known limitations (read before trusting it blindly)

- It only tracks pools paired directly against WETH or USDG. A token launched paired
  against something exotic won't show up.
- LP lock detection is a best-effort heuristic based on where the LP position NFT ends
  up shortly after pool creation — it can miss lock setups that happen later or through
  unusual paths. If it says "Unknown," that means the check couldn't confirm either way
  — treat it as a caution flag, not a pass.
- This checks contract code, not intent. A verified contract with no mint function and
  burned liquidity can still be a bad trade for a hundred other reasons (no real
  community, no volume, pure hype). This tool filters out obvious rugs — it doesn't
  pick winners.
