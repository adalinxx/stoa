// Stoa's core features through the real page in headless Chromium, against a
// private Lattice stack (stack.mjs). Run with node --test; see README.
//
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js \
//   LATTICE_WALLET=<lattice-wallet>/dist node --test e2e/ui/
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { after, before, test as nodeTest } from "node:test";
import { chromium, expect as baseExpect } from "@playwright/test";
import { mediaVolume } from "../../client/media.mjs";
import * as write from "../../client/write.mjs";
import { start } from "./stack.mjs";

const wallet = process.env.LATTICE_WALLET && fileURLToPath(new URL(process.env.LATTICE_WALLET, `file://${process.cwd()}/`));
if (!wallet) throw new Error("LATTICE_WALLET: the built Lattice Wallet extension (its dist/ directory)");
// The wallet as installed by someone who runs the stack's node: allowed to
// reach it (what the wallet's Allow button would grant).
const walletInstalled = mkdtempSync(`${tmpdir()}/stoa-ui-wallet-`);
cpSync(wallet, walletInstalled, { recursive: true });
const manifest = JSON.parse(readFileSync(`${walletInstalled}/manifest.json`, "utf8"));
manifest.host_permissions = [...manifest.host_permissions, "http://127.0.0.1/*"];
writeFileSync(`${walletInstalled}/manifest.json`, JSON.stringify(manifest));
const running = await start();
writeFileSync(new URL("./.stack.json", import.meta.url), JSON.stringify(running.info));
const { chainPath, fund, newAccount, nodeOperator, openApp, sdk, stack, writeAs } = await import("./helpers.mjs");

let browser;
before(async () => (browser = await chromium.launch()));
after(async () => {
  await browser?.close();
  await running.stop();
});

/**
 * A browser with the Lattice Wallet installed (LATTICE_WALLET: its built
 * dist/), in Chrome's headless mode that runs extensions. The person here
 * approves whatever the wallet asks: each approval window gets Connect or
 * Sign clicked (or Decline, for writes, once a test sets declineWrites), and
 * is counted.
 */
async function walletBrowser() {
  const context = await chromium.launchPersistentContext(mkdtempSync(`${tmpdir()}/stoa-ui-browser-`), {
    headless: false,
    args: ["--headless=new", `--disable-extensions-except=${walletInstalled}`, `--load-extension=${walletInstalled}`],
  });
  // The wallet's address, read while its worker runs (Chrome stops an idle one).
  const [worker] = context.serviceWorkers().length ? context.serviceWorkers() : [await context.waitForEvent("serviceworker")];
  // (Node gives a chrome-extension: URL the origin "null": take scheme and host.)
  context.walletOrigin = worker.url().split("/").slice(0, 3).join("/");
  context.approvals = 0;
  context.nonces = []; // the Nonce row of each write signed, as the wallet showed it
  // A window still being answered when its test closes the browser is let go.
  context.on("page", (opened) => respond(opened).catch(() => {}));
  async function respond(opened) {
    await opened.waitForLoadState().catch(() => {});
    if (!opened.url().includes("/approve/index.html")) return;
    const answer = context.declineWrites && (await opened.getByRole("button", { name: "Sign" }).waitFor().then(() => true, () => false))
      ? "Decline" : /^(Connect|Sign)$/;
    if (answer !== "Decline" && (await opened.getByRole("heading", { name: "Sign a write" }).count())) {
      // Sign wakes only once the wallet has read the nonce.
      await baseExpect(opened.getByRole("button", { name: "Sign" })).toBeEnabled({ timeout: 60_000 }).catch(() => {});
      context.nonces.push(await opened.locator(".row", { hasText: "Nonce" }).innerText().catch(() => ""));
    }
    await opened.getByRole("button", { name: answer }).click().catch(() => {});
    context.approvals += 1;
  }
  return context;
}

/** A test with a fresh browser (wallet installed, not set up) and page. */
const test = (name, body) =>
  nodeTest(name, { timeout: 300_000 }, async () => {
    const context = await walletBrowser();
    const page = context.pages()[0] ?? (await context.newPage());
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
    try {
      await body({ page });
    } catch (error) {
      // What the page showed when it failed.
      const shown = await page.locator("main").innerText().catch(() => "(no page)");
      error.message += `\n--- page at ${page.url()}:\n${shown.slice(0, 800)}\n--- page errors: ${errors.join(" | ") || "none"}`;
      throw error;
    } finally {
      await context.close();
    }
  });
// Writes wait for a block: generous waits, as Playwright Test's config would set.
const expect = baseExpect.configure({ timeout: 120_000 });

const community = stack.community;
const feed = `#/s/${community}`;
const poster = newAccount();
const labeller = newAccount();
let postURL;

async function newPost(page, { title, link, body }) {
  await page.getByRole("button", { name: "New post" }).click();
  await page.locator("#np-c").selectOption(community);
  await page.locator("#np-t").fill(title);
  if (link) await page.locator("#np-l").fill(link);
  if (body) await page.locator("#np-b").fill(body);
  await page.locator("#np-post").click();
}

test("a visitor reads the community list from the node", async ({ page }) => {
  await openApp(page, null);
  await expect(page.locator("#communities")).toContainText(community);
  await expect(page.locator("#who")).toHaveText("Connect wallet");
});

test("an account without coins is told to receive or mine them; there is no faucet", async ({ page }) => {
  const broke = newAccount();
  await openApp(page, broke, feed);
  await newPost(page, { title: "Will not land" });
  await expect(page.locator("#np-status")).toContainText(`Receive some at ${broke.address}, or mine s/${community}`);
});

test("a visitor without the wallet is told to install it to post", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openApp(page, null, feed);
  await expect(page.locator("#who")).toHaveText("Connect wallet");
  await newPost(page, { title: "Needs a wallet" });
  await expect(page.locator("#np-status")).toContainText("Install the Lattice Wallet extension");
  await context.close();
});

test("a funded poster posts a link; it lands and reads back in its thread and the feed", async ({ page }) => {
  await fund(poster.address);
  await openApp(page, poster, feed);
  await newPost(page, { title: "The whitepaper", link: "https://bitcoin.org/bitcoin.pdf", body: "Worth a reread." });
  await expect(page).toHaveURL(new RegExp(`#/s/${community}/${poster.address}/`));
  postURL = page.url();
  await expect(page.locator(".op h1")).toHaveText("The whitepaper");
  await expect(page.locator(".op .link")).toHaveAttribute("href", "https://bitcoin.org/bitcoin.pdf");
  await expect(page.locator(".op .body")).toHaveText("Worth a reread.");
  // The wallet asked twice: to connect, then to sign the post, with a nonce
  // it read from the person's own node (not one the page chose).
  expect(page.context().approvals).toBe(2);
  expect(page.context().nonces).toEqual([expect.stringMatching(/Nonce\s+\d+ \(from 127\.0\.0\.1:26081\)/i)]);
  await page.goto(stack.app + feed);
  const row = page.locator(".post", { hasText: "The whitepaper" });
  await expect(row).toBeVisible();
  await expect(row.locator(".link")).toHaveText("bitcoin.org ↗");
  await expect(row.locator(".meta")).toContainText(/\dm/);
});

test("comments nest, and a vote counts once and can be taken back", async ({ page }) => {
  await openApp(page, poster);
  await page.goto(postURL);
  await page.locator(".op [data-reply]").click();
  await page.locator("#rp-b").fill("Section 11 holds.");
  await page.locator("#rp-send").click();
  const first = page.locator(".c", { hasText: "Section 11 holds." }).first();
  await expect(first).toBeVisible();
  await first.locator("[data-reply]").first().click();
  await page.locator("#rp-b").fill("And section 6.");
  await page.locator("#rp-send").click();
  await expect(first.locator(".c", { hasText: "And section 6." })).toBeVisible();

  await page.goto(stack.app + feed);
  const row = page.locator(".post", { hasText: "The whitepaper" });
  await expect(row.locator(".meta")).toContainText("2 comments");
  await row.locator(".vote.up").click();
  await expect(row.locator(".votes span")).toHaveText("1");
  await expect(row.locator(".vote.up")).toHaveClass(/on/);
  await row.locator(".vote.up").click();
  await expect(row.locator(".votes span")).toHaveText("0");
  await expect(row.locator(".vote.up")).not.toHaveClass(/on/);
});

test("a display name set in Settings is written to the home chain and shown for the author", async ({ page }) => {
  await openApp(page, poster, feed);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator("#st-name").fill("Alice");
  await page.locator("#settings-form button[value=save]").click();
  await expect(page.locator("#who")).toHaveText("Alice");
  // Another reader sees it once the home chain has it.
  const reader = await browser.newContext();
  const other = await reader.newPage();
  await openApp(other, null, feed);
  await expect(async () => {
    await other.reload();
    await expect(other.locator(".post", { hasText: "The whitepaper" }).locator(".meta")).toContainText("Alice", { timeout: 5000 });
  }).toPass({ timeout: 120_000 });
  await reader.close();
});

test("labels hide a post only for a reader who follows the labeller, at once, and Show reveals it", async ({ page }) => {
  await fund(labeller.address);
  await openApp(page, labeller);
  await page.goto(postURL);
  await page.locator(".op [data-label]").click();
  await page.locator("#rp-labels").fill("spam");
  await page.locator("#rp-b").fill("Testing labels.");
  await page.locator("#rp-send").click();
  await expect(page.locator(".c.note", { hasText: "Testing labels." })).toBeVisible();

  // The poster follows the labeller: the post hides without a reload.
  await openApp(page, poster, feed);
  await expect(page.locator(".post", { hasText: "The whitepaper" })).toBeVisible();
  await page.getByRole("button", { name: "Moderation" }).first().click();
  await page.locator("#mods-add").fill(labeller.address);
  await page.locator("#mods-add-btn").click();
  await page.locator("#mods button[value=ok]").click();
  const hidden = page.locator(".hidden-row", { hasText: "labelled spam" });
  await expect(hidden).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".post", { hasText: "The whitepaper" })).toHaveCount(0);
  await hidden.getByRole("button", { name: "Show" }).click();
  await expect(page.locator(".post", { hasText: "The whitepaper" })).toBeVisible();

  // A reader who follows no one sees it.
  const reader = await browser.newContext();
  const other = await reader.newPage();
  await openApp(other, null, feed);
  await expect(other.locator(".post", { hasText: "The whitepaper" })).toBeVisible();
  await reader.close();

  // Unfollowing brings it back, also at once.
  await page.goto(stack.app + feed);
  await page.getByRole("button", { name: "Moderation" }).first().click();
  await page.locator(`[data-unfollow="${labeller.address}"]`).click();
  await page.locator("#mods button[value=ok]").click();
  await expect(page.locator(".post", { hasText: "The whitepaper" })).toBeVisible({ timeout: 30_000 });
});

test("an image a node serves is shown; one nobody serves says so", async ({ page }) => {
  const picture = new Uint8Array(Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4500000000049454e44ae426082", "hex",
  ));
  const volume = mediaVolume(sdk, "image/png", picture);
  await nodeOperator().pin(volume);
  const unserved = mediaVolume(sdk, "image/png", new TextEncoder().encode("nobody keeps this")).cid;
  await writeAs(poster, chainPath, write.post(poster.address, write.newId(), { title: "A picture" }, [volume.cid]));
  await writeAs(poster, chainPath, write.post(poster.address, write.newId(), { title: "A lost picture" }, [unserved]));
  await openApp(page, null, feed);
  await expect(page.locator(".post", { hasText: "A picture" }).first().locator("img.media")).toBeVisible();
  await expect(page.locator(".post", { hasText: "A lost picture" })).toContainText("No one is serving this file right now.");
});

test("Top orders by score and New by block time", async ({ page }) => {
  const voter = newAccount();
  await fund(voter.address, 20n, [chainPath]);
  const first = write.newId(), second = write.newId();
  await writeAs(poster, chainPath, write.post(poster.address, first, { title: "Older, liked" }));
  await writeAs(poster, chainPath, write.post(poster.address, second, { title: "Newer, unliked" }));
  await writeAs(voter, chainPath, write.vote(voter.address, poster.address, first, 1));
  await openApp(page, null, feed);
  const titles = () => page.locator(".post h2").allInnerTexts();
  await page.getByRole("button", { name: "Top", exact: true }).click();
  await expect.poll(async () => (await titles()).indexOf("Older, liked") < (await titles()).indexOf("Newer, unliked")).toBe(true);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect.poll(async () => (await titles())[0]).toBe("Newer, unliked");
});

test("an earlier render that finishes last does not write over a newer one", async ({ page }) => {
  // Force the race: hold the community reads the first render makes after it
  // has read the chain's tip (so it has already judged with no follows), let
  // the follow's render finish, then release the first. Without the guard
  // the first render writes the post back, unhidden.
  let communityReads = 0;
  let followed = false;
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route("**/volumes/**", async (route) => {
    const fromCommunity = new URL(route.request().url()).searchParams.get("chainPath") === chainPath.join("/");
    if (fromCommunity && !followed && ++communityReads > 2) await held;
    await route.continue();
  });
  await openApp(page, poster, feed);
  await expect.poll(() => communityReads, { timeout: 60_000 }).toBeGreaterThan(2);
  followed = true;
  await page.getByRole("button", { name: "Moderation" }).first().click();
  await page.locator("#mods-add").fill(labeller.address);
  await page.locator("#mods-add-btn").click();
  await page.locator("#mods button[value=ok]").click();
  const hidden = page.locator(".hidden-row", { hasText: "labelled spam" });
  await expect(hidden).toBeVisible({ timeout: 60_000 });
  release();
  await page.waitForTimeout(5000);
  await expect(hidden).toBeVisible({ timeout: 1000 });
  await expect(page.locator(".post", { hasText: "The whitepaper" })).toHaveCount(0);
});

test("a write declined in the wallet is not sent", async ({ page }) => {
  await openApp(page, poster, feed);
  page.context().declineWrites = true;
  await newPost(page, { title: "Declined in the wallet" });
  await expect(page.locator("#np-status")).toContainText("declined");
  expect(page.context().approvals).toBe(2);
  await page.goto(stack.app + feed);
  await expect(page.locator(".post").first()).toBeVisible();
  await expect(page.locator(".post", { hasText: "Declined in the wallet" })).toHaveCount(0);
});
