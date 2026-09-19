// End-to-end walk of the AlphaBasket UI.
//
// Drives the real dev server and the real backend API with a headless browser.
// A Wallet Standard wallet is injected into the page that signs with a
// deterministic Ed25519 key, so every step a user takes is taken for real:
// filters, opening an index, quoting, signing the intent, submitting it, and
// every error and empty state. Screenshots land in scripts/ui-e2e/shots.
//
//   npm run test:ui
//
// Requires: the backend API on APP_API (default http://127.0.0.1:3001) with
// its Postgres reachable through PSQL (default: the alphabasket-postgres docker
// container), and the Vite dev server on APP_URL (default http://localhost:8080).
// The demo rows in seed-demo.sql are applied on every run; they are idempotent.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Keypair } from "@solana/web3.js";
import { chromium } from "playwright";
import nacl from "tweetnacl";

const here = fileURLToPath(new URL(".", import.meta.url));
const APP = process.env.APP_URL ?? "http://localhost:8080";
const PSQL = process.env.PSQL ?? "docker exec -i alphabasket-postgres psql -U alphabasket -d alphabasket -At";
const SPOT = "Ba5kEtSpot1111111111111111111111111111111111";
const PERP = "Ba5kEtPerp1111111111111111111111111111111111";
const PREDICTION = "Ba5kEtPred1111111111111111111111111111111111";

// Deterministic test wallet. Its Position PDAs are what seed-demo.sql seeds.
const seed = createHash("sha256").update("alphabasket-e2e-test-wallet").digest().subarray(0, 32);
const keypair = Keypair.fromSeed(seed);
const address = keypair.publicKey.toBase58();
const sign = (message) => nacl.sign.detached(message, keypair.secretKey);

mkdirSync(`${here}shots`, { recursive: true });

const failures = [];
const check = (condition, label) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) failures.push(label);
};

const sql = (statement) => execSync(`${PSQL} -c "${statement.replace(/"/g, '\\"')}"`, { stdio: ["ignore", "ignore", "inherit"] });

const seedDemo = () => {
  execSync(`${PSQL} -f -`, { input: readFileSync(`${here}seed-demo.sql`), stdio: ["pipe", "ignore", "inherit"] });
};

// NAV snapshots are append-only and quotes reject anything older than the
// backend's API_MAXIMUM_NAV_AGE_MS (30s by default), so quote steps start here.
const freshNav = () => {
  for (const [id, nav, price] of [
    [SPOT, "7857000000", "970000"],
    [PERP, "2712500000", "1085000"],
    [PREDICTION, "4200000000", "1050000"],
  ]) {
    sql(
      `INSERT INTO nav_snapshots (basket_id, sequence, snapshot_hash, observed_at_ms, snapshot) SELECT '${id}', coalesce(max(sequence),0)+1, md5(random()::text) || md5(random()::text), (extract(epoch from now())*1000)::bigint, '{"grossNavPusdUnits":"${nav}","sharePriceUnits":"${price}"}'::jsonb FROM nav_snapshots WHERE basket_id='${id}'`,
    );
  }
};

// Runs inside the page before any app code: registers a Wallet Standard
// wallet whose signMessage calls back into Node.
const walletInit = ({ address, publicKeyBytes, autoConnect }) => {
  if (autoConnect) window.localStorage.setItem("walletName", JSON.stringify("Test Wallet"));
  const publicKey = new Uint8Array(publicKeyBytes);
  const chains = ["solana:mainnet", "solana:devnet"];
  const account = { address, publicKey, chains, features: ["solana:signMessage", "solana:signTransaction"], label: "Test account" };
  const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
  window.__signCalls = [];
  const wallet = {
    version: "1.0.0",
    name: "Test Wallet",
    icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#36d394"/></svg>'),
    chains,
    accounts: [account],
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => {} },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "solana:signMessage": {
        version: "1.0.0",
        signMessage: async (...inputs) => {
          const out = [];
          for (const input of inputs) {
            const message = new Uint8Array(input.message);
            window.__signCalls.push({ bytes: message.length });
            out.push({ signedMessage: message, signature: fromBase64(await window.__testSign(toBase64(message))) });
          }
          return out;
        },
      },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: async (...inputs) => inputs.map((input) => ({ signedTransaction: input.transaction })),
      },
    },
  };
  const register = (api) => api.register(wallet);
  window.addEventListener("wallet-standard:app-ready", (event) => register(event.detail));
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register }));
};

async function newPage(browser, { connected, viewport = { width: 1440, height: 900 } }) {
  const context = await browser.newContext({ viewport, permissions: ["clipboard-read", "clipboard-write"] });
  const errors = [];
  await context.exposeFunction("__testSign", (b64) => Buffer.from(sign(Buffer.from(b64, "base64"))).toString("base64"));
  if (connected) {
    await context.addInitScript(walletInit, { address, publicKeyBytes: Array.from(keypair.publicKey.toBytes()), autoConnect: true });
  }
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return { page, context, errors };
}

const shot = (page, name) => page.screenshot({ path: `${here}shots/${name}.png` });
// Network-level noise is expected against a local backend: the public mainnet
// RPC answers 403 to the balance probe, and the backend's 500 path sends no
// CORS headers so the browser logs a CORS block. Anything else is a bug.
const noise = (e) => /Failed to load resource|CORS policy|net::ERR_FAILED|Failed to fetch/.test(e);
const GRID = 'section[aria-labelledby="indexes-heading"] a[href^="/index/"]';
const gridCount = (page, n) => page.waitForFunction(({ sel, n }) => document.querySelectorAll(sel).length === n, { sel: GRID, n });

console.log(`wallet ${address}`);
seedDemo();
const browser = await chromium.launch();
try {
  // ------------------------------------------------------------- connected
  freshNav();
  const { page, errors } = await newPage(browser, { connected: true });
  await page.goto(APP);
  await page.waitForSelector(GRID);
  check((await page.locator(GRID).count()) === 4, "home lists 4 index cards");
  await page.getByRole("button", { name: new RegExp(`Wallet ${address.slice(0, 8)}`) }).waitFor();
  check(true, "wallet auto-connected and shown in header");
  await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length === 3);
  check(true, "portfolio shows 3 positions");
  check(await page.getByText("$5,262.00").isVisible(), "portfolio total value is $5,262.00");
  check(await page.getByText("+$62.00").isVisible(), "portfolio net P&L is +$62.00");
  check(
    (await page.locator(`a[href="/index/${PREDICTION}"]`).first().locator("..").textContent() ?? "").length > 0,
    "prediction index card is on the grid",
  );
  await shot(page, "01-home-connected");

  await page.getByRole("tab", { name: "Spot" }).click();
  await gridCount(page, 1);
  check(true, "filter Spot narrows the grid to 1 card");
  await page.getByRole("tab", { name: "Perps" }).click();
  await gridCount(page, 2);
  check(true, "filter Perps narrows the grid to 2 cards");
  await page.getByRole("tab", { name: "All" }).click();
  await gridCount(page, 4);
  await page.getByLabel("Search indexes").fill("demo0spot");
  await gridCount(page, 1);
  check(true, "search by id narrows the grid to 1 card");
  await page.getByLabel("Search indexes").fill("zzz");
  await page.getByText("Nothing matches").waitFor();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await gridCount(page, 4);
  check(true, "clear filters restores all cards");

  // Open the spot index in place.
  await page.locator(`a[href="/index/${SPOT}"]`).first().click();
  await page.waitForURL(`**/index/${SPOT}`);
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  check(await dialog.getByText("demo0s…0002").isVisible(), "index panel opens with the index id");
  await dialog.getByText("Composition").waitFor();
  for (const market of ["SOL", "JUP", "BONK", "USDC"]) {
    check(await dialog.getByText(market, { exact: true }).first().isVisible(), `composition lists ${market}`);
  }
  check(await dialog.getByText("Your position").isVisible(), "panel shows your position in this index");
  await shot(page, "02-index-panel");

  // Deposit: quote → breakdown → sign → submit.
  await dialog.getByLabel("Amount").fill("100");
  await dialog.getByText("You receive").waitFor({ timeout: 15000 });
  check(await dialog.getByText("−$0.50").isVisible(), "deposit quote shows the 0.5% fee");
  check(await dialog.getByText("$99.50").isVisible(), "deposit quote shows net invested");
  const depositButton = dialog.getByRole("button", { name: "Deposit $100.00" });
  await depositButton.waitFor();
  check(await depositButton.isEnabled(), "deposit button enabled with a valid quote");
  await shot(page, "03-deposit-quote");
  await depositButton.click();
  await dialog.getByText("Deposit in progress").waitFor();
  await page.waitForFunction(() => window.__signCalls.length === 1, null, { timeout: 15000 });
  const signed = await page.evaluate(() => window.__signCalls[0].bytes);
  check(signed === 193, `wallet signed one 193-byte deposit intent (got ${signed})`);
  // A local backend without execution wallets refuses the intent after the
  // signature check. The UI must surface that and recover.
  await dialog.getByRole("button", { name: "Start over" }).waitFor({ timeout: 30000 });
  check(true, "refused intent is shown with a Start over action");
  await shot(page, "04-deposit-refused");
  await dialog.getByRole("button", { name: "Start over" }).click();
  await dialog.getByRole("tab", { name: "Withdraw" }).waitFor();
  check(true, "start over returns to the form");

  // Withdraw: guard → quote → sign → submit.
  freshNav();
  await dialog.getByRole("tab", { name: "Withdraw" }).click();
  await dialog.getByLabel("Shares").fill("5000");
  await dialog.getByText("You hold 3,000.00 shares.").waitFor();
  check(await dialog.getByRole("button", { name: /Withdraw 5,000/ }).isDisabled(), "withdrawing more than held is blocked inline");
  await dialog.getByLabel("Shares").fill("1000");
  await dialog.getByText("You receive at least").waitFor({ timeout: 15000 });
  check(await dialog.getByText("$970.00").isVisible(), "withdrawal quote shows gross value");
  check(await dialog.getByText("$941.09").isVisible(), "withdrawal quote shows minimum out");
  await shot(page, "05-withdraw-quote");
  await dialog.getByRole("button", { name: "Withdraw 1,000.00 shares" }).click();
  await page.waitForFunction(() => window.__signCalls.length === 2, null, { timeout: 15000 });
  const signedWd = await page.evaluate(() => window.__signCalls[1].bytes);
  check(signedWd === 228, `wallet signed one 228-byte withdrawal intent (got ${signedWd})`);
  await dialog.getByRole("button", { name: "Start over" }).waitFor({ timeout: 30000 });
  check(true, "refused withdrawal is shown with a Start over action");
  await dialog.getByRole("button", { name: "Start over" }).click();

  // Escape closes and focus returns to the element that opened the panel.
  await page.mouse.move(8, 8);
  await page.keyboard.press("Escape");
  await page.waitForURL(`${APP}/`);
  check((await page.getByRole("dialog").count()) === 0, "Escape closes the panel and returns to /");
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("href"));
  check(focused === `/index/${SPOT}`, "focus returns to the link that opened the panel");

  // Perp index: browsable, not investable.
  await page.locator(`a[href="/index/${PERP}"]`).first().click();
  await page.getByRole("dialog").getByText("Not open yet").waitFor();
  check(true, "perp index says deposits are not open");
  check(await page.getByRole("dialog").getByText("Long 3x").first().isVisible(), "perp legs show direction and leverage");
  check(await page.getByRole("dialog").getByText("unfilled").isVisible(), "unfilled perp leg says so");
  await shot(page, "06-perp-panel");
  await page.mouse.move(8, 8);
  await page.keyboard.press("Escape");
  await page.waitForURL(`${APP}/`);

  await page.locator(`a[href="/index/${SPOT}?side=withdraw"]`).click();
  await page.getByRole("dialog").getByLabel("Shares").waitFor();
  check(true, "portfolio row opens the panel on the Withdraw tab");
  await page.mouse.move(8, 8);
  await page.keyboard.press("Escape");
  await page.waitForURL(`${APP}/`);

  // Prediction index (Jupiter Predict venue): browsable, quotable, refusal recovers.
  freshNav();
  await page.locator(`a[href="/index/${PREDICTION}"]`).first().click();
  await page.waitForURL(`**/index/${PREDICTION}`);
  const prediction = page.getByRole("dialog");
  await prediction.getByText("Composition").waitFor();
  check(await prediction.getByText("Prediction", { exact: true }).first().isVisible(), "panel shows the Prediction badge");
  for (const market of ["fed-cut-march", "btc-150k-2026", "eth-flips-btc", "sol-ath-q4"]) {
    check(await prediction.getByText(market, { exact: true }).isVisible(), `composition lists ${market}`);
  }
  check((await prediction.getByText("Yes", { exact: true }).count()) === 3, "three legs read Yes");
  check((await prediction.getByText("No", { exact: true }).count()) === 1, "one leg reads No");
  check(await prediction.getByText("Your position").isVisible(), "panel shows the prediction position");
  await prediction.getByLabel("Amount").fill("50");
  await prediction.getByText("You receive").waitFor({ timeout: 15000 });
  check(await prediction.getByText("−$0.25").isVisible(), "prediction deposit quote shows the 0.5% fee");
  check(await prediction.getByText("$49.75").isVisible(), "prediction deposit quote shows net invested");
  await shot(page, "12-prediction-panel");
  await prediction.getByRole("button", { name: "Deposit $50.00" }).click();
  await page.waitForFunction(() => window.__signCalls.length === 3, null, { timeout: 15000 });
  const predictionSigned = await page.evaluate(() => window.__signCalls[2].bytes);
  check(predictionSigned === 193, `prediction deposit intent is 193 bytes (got ${predictionSigned})`);
  await prediction.getByRole("button", { name: "Start over" }).waitFor({ timeout: 30000 });
  check(true, "refused prediction intent recovers with Start over");
  await prediction.getByRole("button", { name: "Start over" }).click();
  await prediction.getByRole("tab", { name: "Withdraw" }).click();
  await prediction.getByLabel("Shares").fill("2000");
  await prediction.getByText("You hold 1,000.00 shares.").waitFor();
  check(true, "prediction over-withdrawal is blocked inline");
  await page.mouse.move(8, 8);
  await page.keyboard.press("Escape");
  await page.waitForURL(`${APP}/`);

  // Builder.
  await page.getByRole("link", { name: /Create index/ }).click();
  await page.waitForURL(`${APP}/create`);
  const create = page.getByRole("dialog");
  await create.getByRole("button", { name: "Add first leg" }).click();
  for (let i = 0; i < 3; i += 1) await create.getByRole("button", { name: "Add leg" }).click();
  await create.getByText("Weights total 100% of 100%").waitFor();
  check(await create.getByText("Ready for the Composer").isVisible(), "four even spot legs are publishable");
  await create.locator('input[id$="-weight"]').first().fill("40");
  await create.getByText("Fix before publishing").waitFor();
  check(await create.getByText(/must weigh between 0% and 30%/).isVisible(), "a 40% leg is flagged");
  await create.getByRole("button", { name: "Split evenly" }).click();
  await create.getByText("Ready for the Composer").waitFor();
  await create.getByRole("radio", { name: /Phoenix perps/ }).click();
  check(await create.getByText("No legs yet").isVisible(), "switching asset class clears the draft");
  await create.getByRole("button", { name: "Add first leg" }).click();
  for (let i = 0; i < 3; i += 1) await create.getByRole("button", { name: "Add leg" }).click();
  await create.getByText("Ready for the Composer").waitFor();
  check((await create.getByText(/sub #/).count()) === 4, "each perp leg gets its own subaccount");
  await create.getByRole("button", { name: "Copy composition" }).click();
  await create.getByRole("button", { name: "Copied" }).waitFor();
  const clipboard = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  check(clipboard.assetClass === "perp" && clipboard.legs.length === 4 && clipboard.creator === address, "copied composition has 4 perp legs and the creator");
  await shot(page, "07-create-panel");
  await page.mouse.move(8, 8);
  await page.keyboard.press("Escape");
  await page.waitForURL(`${APP}/`);

  await page.getByRole("button", { name: new RegExp(`Wallet ${address.slice(0, 8)}`) }).click();
  await page.getByRole("menuitem", { name: "Copy address" }).click();
  check((await page.evaluate(() => navigator.clipboard.readText())) === address, "wallet menu copies the address");
  await page.keyboard.press("Escape");

  const real = errors.filter((e) => !noise(e));
  check(real.length === 0, `no page or React errors while connected${real.length ? `: ${real.join(" | ")}` : ""}`);
  await page.context().close();

  // ---------------------------------------------------------- disconnected
  const anon = await newPage(browser, { connected: false });
  await anon.page.goto(APP);
  await anon.page.getByText("Connect a wallet to see your positions").waitFor();
  check(true, "disconnected home invites a wallet connection");
  await anon.page.locator(`a[href="/index/${SPOT}"]`).first().click();
  const connect = anon.page.getByRole("dialog").getByRole("button", { name: "Connect wallet" }).last();
  await connect.waitFor();
  check(true, "disconnected invest panel offers Connect wallet");
  await connect.click();
  await anon.page.locator(".wallet-adapter-modal").waitFor();
  check(true, "connect opens the wallet picker");
  await shot(anon.page, "08-wallet-picker");
  await anon.page.keyboard.press("Escape");

  await anon.page.goto(`${APP}/index/11111111111111111111111111111111`);
  await anon.page.getByText("No index at this address").waitFor();
  check(true, "unknown index address shows a not-found state in the panel");
  await anon.page.goto(`${APP}/nowhere`);
  await anon.page.getByText("There is nothing at this address").waitFor();
  check(true, "unknown route shows the 404 page inside the layout");

  await anon.context.route("**/v1/indexes", (route) => route.abort());
  await anon.page.goto(APP);
  await anon.page.getByText("Could not load indexes").waitFor();
  check(await anon.page.getByRole("button", { name: "Try again" }).isVisible(), "API failure shows an error with a retry");
  await shot(anon.page, "09-api-down");
  const anonReal = anon.errors.filter((e) => !noise(e));
  check(anonReal.length === 0, `no page or React errors while disconnected${anonReal.length ? `: ${anonReal.join(" | ")}` : ""}`);
  await anon.context.close();

  // ---------------------------------------------------------------- mobile
  freshNav();
  const mobile = await newPage(browser, { connected: true, viewport: { width: 390, height: 844 } });
  await mobile.page.goto(APP);
  await mobile.page.waitForSelector(GRID);
  await mobile.page.waitForFunction(() => document.querySelectorAll("table tbody tr").length === 3);
  const overflow = await mobile.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  check(!overflow, "mobile home has no horizontal overflow");
  await shot(mobile.page, "10-mobile-home");
  await mobile.page.locator(`a[href="/index/${SPOT}"]`).first().click();
  await mobile.page.getByRole("dialog").getByLabel("Amount").waitFor();
  await mobile.page.getByRole("dialog").getByLabel("Amount").fill("25");
  await mobile.page.getByRole("dialog").getByText("You receive").waitFor({ timeout: 15000 });
  await shot(mobile.page, "11-mobile-panel");
  const mobileOverflow = await mobile.page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return dialog ? dialog.scrollWidth > dialog.clientWidth : true;
  });
  check(!mobileOverflow, "mobile panel has no horizontal overflow");
  await mobile.context.close();
} finally {
  await browser.close();
}

console.log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} FAILED`}  (screenshots in scripts/ui-e2e/shots)`);
process.exit(failures.length === 0 ? 0 : 1);
