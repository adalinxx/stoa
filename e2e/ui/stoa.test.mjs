// Stoa through the real page in headless Chromium, against a private Lattice
// stack (stack.mjs), with Selfhold's window as the wallet: a passkey (Chromium's
// virtual authenticator) makes each person's account, and a sponsor takes this
// device's work for fees and for keeping files, so nobody here needs coins.
// Run with node --test; see README.
//
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js \
//   LATTICE_WALLET_WEB=<selfhold-wallet>/dist-web node --test e2e/ui/
import { writeFileSync } from "node:fs";
import { after, before, test as nodeTest } from "node:test";
import { chromium, expect as baseExpect } from "@playwright/test";
import { mediaVolume } from "../../client/media.mjs";
import * as write from "../../client/write.mjs";
import { MONIKER, start } from "./stack.mjs";

const running = await start();
writeFileSync(new URL("./.stack.json", import.meta.url), JSON.stringify(running.info));
const {
  approveInSelfhold, balance, chainPath, claimAs, declineInSelfhold, fund, homePath, newAccount, newSelfholdAccount,
  openApp, sdk, selfholdRequests, sends, signIn, stack, stateOf, walletOrigin, writeAs,
} = await import("./helpers.mjs");
const names = await import("../../app/vendor/moniker-sdk/src/records/names.mjs");

// Selfhold's window and Stoa grind shares on the graphics chip. A machine
// without one (CI's) gets Chromium's own, SwiftShader, in software.
const gpuArgs = process.platform === "linux"
  ? ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader", "--use-angle=swiftshader"]
  : [];
let browser;
// Pop-ups blocked as for anyone: Selfhold's window opens only from a click, and a test catches one that doesn't.
before(async () => (browser = await chromium.launch({ args: gpuArgs, ignoreDefaultArgs: ["--disable-popup-blocking"] })));
after(async () => {
  await browser?.close();
  await running.stop();
});

/** Every write of the reader's that the page shows as pending has landed. */
const landed = (page) => expect(page.locator(".pending-note")).toHaveCount(0);

/** A test with a fresh browser context (one person, with their own passkey) and page. */
const test = (name, body) =>
  nodeTest(name, { timeout: 420_000 }, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
    // What Selfhold's window logged and showed, for a failure.
    const walletLog = [];
    let walletPage = null;
    context.on("page", (opened) => {
      walletPage = opened;
      opened.on("console", (message) => walletLog.push(`${message.type()}: ${message.text()}`));
      opened.on("pageerror", (error) => walletLog.push(`pageerror: ${error.message}`));
    });
    try {
      await body({ page });
    } catch (error) {
      // What the page showed when it failed.
      const shown = await page.locator("main").innerText().catch(() => "(no page)");
      const notices = await page.locator("#notices").innerText().catch(() => "");
      const wallet = walletPage ? await walletPage.locator("body").innerText({ timeout: 2000 }).catch(() => "(closed)") : "(never opened)";
      error.message += `\n--- page at ${page.url()}:\n${shown.slice(0, 800)}\n--- notices: ${notices}\n--- page errors: ${errors.join(" | ") || "none"}`
        + `\n--- Selfhold's window at ${walletPage?.url()}:\n${wallet.slice(0, 1200)}\n--- its log:\n${walletLog.slice(-30).join("\n").slice(0, 3000)}`;
      throw error;
    } finally {
      await context.close();
    }
  });
// Writes wait for a block, and fees for work: generous waits.
const expect = baseExpect.configure({ timeout: 120_000 });

const community = stack.community;
const feed = `#/s/${community}`;
// Another client's poster and labeller, who sign with keys they hold.
const poster = newAccount();
const labeller = newAccount();
const sponsorBalance = () => balance(stack.sponsorAddress, chainPath);
// A 1x1 PNG.
const picture = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4500000000049454e44ae426082", "hex");

test("a visitor reads the communities, and is told what taking part takes: a passkey, no install, no coins", async ({ page }) => {
  await openApp(page);
  await expect(page.locator("#communities")).toContainText(community);
  await expect(page.locator("#who")).toHaveText("Sign in");
  await expect(page.locator("#aside")).toContainText("nothing to install, no coins");
  await page.locator("#who").getByRole("button", { name: "Sign in" }).click();
  const dialog = page.locator("#signin");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("a passkey makes your account");
  await expect(dialog).toContainText("you need no coins");
  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect(dialog).toBeHidden();
  // Nothing was asked of Selfhold.
  expect(await selfholdRequests(page)).toBe(0);
});

test("with no coins, a visitor writes a post, signs in with a passkey from the dialog, and posts; the sponsor pays the fee for this device's work", async ({ page }) => {
  const sponsorBefore = await sponsorBalance();
  await openApp(page, feed);
  await page.getByRole("button", { name: "New post" }).click();
  await expect(page.locator("#np-cost")).toContainText("You'll sign in with Selfhold first");
  await page.locator("#np-c").selectOption(community);
  await page.locator("#np-t").fill("The whitepaper");
  await page.locator("#np-l").fill("https://bitcoin.org/bitcoin.pdf");
  await page.locator("#np-b").fill("Worth a reread.");
  // Post signs in first; the draft stays, and the next press sends it.
  const address = await newSelfholdAccount(page, page.locator("#np-post"));
  await expect(page.locator("#np-status")).toHaveText("You're signed in. Press Post to send it.");
  await expect(page.locator("#np-cost")).toContainText("Free: this device does a moment's work for the fee");
  await expect(page.locator("#np-t")).toHaveValue("The whitepaper");
  await approveInSelfhold(page, page.locator("#np-post"));
  await expect(page).toHaveURL(new RegExp(`#/s/${community}/${address}/`));
  // Read back from the chain, not the page's own pending copy: a post time shows.
  await expect(page.locator(".op .meta time")).toBeVisible();
  await expect(page.locator(".op h1")).toHaveText("The whitepaper");
  await expect(page.locator(".op .link")).toHaveAttribute("href", "https://bitcoin.org/bitcoin.pdf");
  // The account still holds nothing: the sponsor paid the fee, from its own.
  expect(await balance(address, chainPath)).toBe(0n);
  expect(await sponsorBalance()).toBeLessThan(sponsorBefore);
  // The page keeps settings and the address it was given: never a key.
  const kept = await page.evaluate(() => Object.keys(localStorage));
  expect(kept.filter((k) => !k.startsWith("stoa:"))).toEqual([`selfhold.web.address ${walletOrigin}`]);

  // Comments nest, each approved in the window.
  await page.locator(".op [data-reply]").first().click();
  await page.locator("#rp-b").fill("Section 11 holds.");
  await approveInSelfhold(page, page.locator("#rp-send"));
  const first = page.locator(".c", { hasText: "Section 11 holds." }).first();
  await expect(first).toBeVisible();
  await landed(page);
  await first.locator("[data-reply]").first().click();
  await page.locator("#rp-b").fill("And section 6.");
  await approveInSelfhold(page, page.locator("#rp-send"));
  await expect(first.locator(".c", { hasText: "And section 6." })).toBeVisible();
  await landed(page);

  // A vote counts at once, waits for its block, settles, and can be taken back.
  await page.goto(stack.app + feed);
  const row = page.locator(".post", { hasText: "The whitepaper" });
  await expect(row.locator(".meta")).toContainText("2 comments");
  await approveInSelfhold(page, row.locator(".vote.up"));
  await expect(row.locator(".votes .score")).toHaveText("1");
  await expect(row.locator(".votes")).not.toHaveClass(/pending/);
  await expect(row.locator(".inline-error")).toHaveCount(0);
  await page.reload();
  await expect(row.locator(".vote.up")).toHaveAttribute("aria-pressed", "true");
  await approveInSelfhold(page, row.locator(".vote.up"));
  await expect(row.locator(".votes .score")).toHaveText("0");
  await expect(row.locator(".votes")).not.toHaveClass(/pending/);
  await page.reload();
  await expect(row.locator(".votes .score")).toHaveText("0");
  expect(await balance(address, chainPath)).toBe(0n);
});

test("a profile: a name and bio on Stoa, and an @handle claimed on Moniker, on every byline and a profile page", async ({ page }) => {
  const other = newAccount();
  await claimAs(other, "taken_one");
  await openApp(page, feed);
  const address = await signIn(page);
  // A new account is asked to choose how it appears.
  await page.locator("#notices").getByRole("button", { name: "Set up your profile" }).click();
  const dialog = page.locator("#profile-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("You have no @handle yet");

  // Someone else's name is said to be so as it's typed, and can't be
  // pressed: Selfhold's window never opens for it, and nothing is sent.
  const sent = sends(page.context());
  const asked = await selfholdRequests(page);
  await page.locator("#pf-handle").fill("taken_one");
  await expect(page.locator("#pf-handle-status")).toHaveText("@taken_one is someone else's.");
  await expect(page.locator("#pf-handle-btn")).toBeDisabled();
  await page.locator("#pf-handle").press("Enter");
  await expect(page.locator("#pf-handle-status")).toHaveText("@taken_one is someone else's.");
  expect(await selfholdRequests(page)).toBe(asked);
  expect(sent).toHaveLength(0);
  // A free one says so, and is claimed, pointed here and shown, in one approval.
  await page.locator("#pf-handle").fill("@Ada_Stoa");
  await expect(page.locator("#pf-handle-status")).toHaveText("@ada_stoa is free. It's yours once you claim it.");
  await approveInSelfhold(page, page.getByRole("button", { name: "Claim @ada_stoa" }));
  await expect(page.locator("#pf-handle-status")).toHaveText("@ada_stoa is your handle now.", { timeout: 180_000 });
  expect(await names.handleOf(await stateOf(MONIKER), address)).toBe("ada_stoa");
  expect(await balance(address, MONIKER)).toBe(0n);

  await page.locator("#pf-name").fill("Ada");
  await page.locator("#pf-bio").fill("Reads whitepapers.");
  await approveInSelfhold(page, page.locator("#pf-save"));
  await expect(dialog).toBeHidden();
  await expect(page.locator("#who .account-name")).toHaveText("Ada @ada_stoa");
  await expect.poll(async () => (await stateOf(homePath)).get(`user/${address}/profile`)).toBe(JSON.stringify({ name: "Ada", bio: "Reads whitepapers." }));

  await page.getByRole("button", { name: "New post" }).click();
  await page.locator("#np-c").selectOption(community);
  await page.locator("#np-t").fill("Hello from Ada");
  await approveInSelfhold(page, page.locator("#np-post"));
  await expect(page.locator(".op .meta time")).toBeVisible();

  // Another reader sees the byline, and the profile page it links to.
  const reader = await browser.newContext();
  const visitor = await reader.newPage();
  await openApp(visitor, feed);
  const byline = visitor.locator(".post", { hasText: "Hello from Ada" }).locator("a.author");
  await expect(byline).toHaveText("Ada @ada_stoa");
  await byline.click();
  await expect(visitor).toHaveURL(new RegExp(`#/u/${address}$`));
  await expect(visitor.locator(".profile-head h1")).toHaveText("Ada");
  await expect(visitor.locator(".profile-head .handle-line")).toContainText("@ada_stoa");
  await expect(visitor.locator(".bio")).toHaveText("Reads whitepapers.");
  await expect(visitor.locator(".stats")).toContainText("Posts1");
  await expect(visitor.locator(".post", { hasText: "Hello from Ada" })).toBeVisible();
  await expect(visitor.locator("[data-edit-profile]")).toHaveCount(0);
  await reader.close();
});

test("an image is kept for good by the storage sponsor, paid with this device's work, and shown in the post", async ({ page }) => {
  await openApp(page, feed);
  await signIn(page);
  await page.getByRole("button", { name: "New post" }).click();
  await page.locator("#np-c").selectOption(community);
  await page.locator("#np-t").fill("A kept picture");
  await expect(page.locator("#np-file-wrap")).toBeVisible();
  await page.locator("#np-file").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: picture });
  // While it is being kept, Post waits.
  await expect(page.locator("#np-media .media-status")).toContainText("Kept for good", { timeout: 300_000 });
  await expect(page.locator("#np-post")).toBeEnabled();
  const cid = mediaVolume(sdk, "image/png", new Uint8Array(picture)).cid;
  const kept = await (await fetch(`${stack.sponsor}/store/${cid}`)).json();
  expect(kept.stored).toBe(true);
  await approveInSelfhold(page, page.locator("#np-post"));
  await expect(page.locator(".op .meta time")).toBeVisible();
  await expect(page.locator(".op img.media")).toBeVisible();
  // Another reader reads it from the node, checked by CID.
  const reader = await browser.newContext();
  const visitor = await reader.newPage();
  await openApp(visitor, feed);
  await expect(visitor.locator(".post", { hasText: "A kept picture" }).locator("img.media")).toBeVisible();
  await reader.close();
});

test("a write declined in Selfhold's window is not sent, and the draft stays", async ({ page }) => {
  await openApp(page, feed);
  await signIn(page);
  const sent = sends(page.context());
  await page.getByRole("button", { name: "New post" }).click();
  await page.locator("#np-c").selectOption(community);
  await page.locator("#np-t").fill("Declined in the wallet");
  await declineInSelfhold(page, page.locator("#np-post"));
  await expect(page.locator("#np-status")).toContainText("declined");
  await expect(page.locator("#np-t")).toHaveValue("Declined in the wallet");
  expect(sent).toHaveLength(0);
});

test("a visitor who votes is asked to sign in, and told why", async ({ page }) => {
  await openApp(page, feed);
  await page.locator(".post .vote.up").first().click();
  await expect(page.locator("#signin")).toBeVisible();
  await expect(page.locator("#join-why")).toContainText("Votes are signed by your account");
  expect(await selfholdRequests(page)).toBe(0);
  // Continue makes the account; the vote waits for the next press.
  await newSelfholdAccount(page, page.locator("#signin").getByRole("button", { name: "Continue with Selfhold" }));
  await expect(page.locator("#signin")).toBeHidden();
  await expect(page.locator("#who #account-btn")).toBeVisible();
});

test("s/all is the Stoa chain's own community, and its page shows every community's posts too", async ({ page }) => {
  await fund(poster.address);
  await writeAs(poster, chainPath, write.post(poster.address, write.newId(), { title: "From another client" }));
  await writeAs(poster, homePath, write.post(poster.address, write.newId(), { title: "Hello from the top" }));
  await openApp(page, "#/s/all");
  await expect(page.locator(".post", { hasText: "From another client" }).locator(".meta")).toContainText(`s/${community}`);
  await expect(page.locator(".post", { hasText: "Hello from the top" }).locator(".meta")).toContainText("s/all");
  await page.goto(stack.app + feed);
  await expect(page.locator(".post", { hasText: "From another client" })).toBeVisible();
  await expect(page.locator(".post", { hasText: "Hello from the top" })).toHaveCount(0);
});

test("labels hide a post only for a reader who follows the labeller, at once, and Show reveals it", async ({ page }) => {
  await fund(labeller.address);
  const id = write.newId();
  await writeAs(poster, chainPath, write.post(poster.address, id, { title: "Labelled post" }));
  await writeAs(labeller, chainPath, write.label(labeller.address, write.newId(), { author: poster.address, id }, ["spam"], { body: "Testing labels." }));
  await openApp(page, feed);
  await expect(page.locator(".post", { hasText: "Labelled post" })).toBeVisible();
  await page.getByRole("button", { name: "Moderation" }).first().click();
  await page.locator("#mods-add").fill(labeller.address);
  await page.locator("#mods-add-btn").click();
  await page.locator("#mods button[value=ok]").click();
  const hidden = page.locator(".hidden-row", { hasText: "labelled spam" });
  await expect(hidden).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".post", { hasText: "Labelled post" })).toHaveCount(0);
  await hidden.getByRole("button", { name: "Show" }).click();
  await expect(page.locator(".post", { hasText: "Labelled post" })).toBeVisible();

  // A reader who follows no one sees it.
  const reader = await browser.newContext();
  const other = await reader.newPage();
  await openApp(other, feed);
  await expect(other.locator(".post", { hasText: "Labelled post" })).toBeVisible();
  await reader.close();

  // Unfollowing brings it back, also at once.
  await page.goto(stack.app + feed);
  await page.getByRole("button", { name: "Moderation" }).first().click();
  await page.locator(`[data-unfollow="${labeller.address}"]`).click();
  await page.locator("#mods button[value=ok]").click();
  await expect(page.locator(".post", { hasText: "Labelled post" })).toBeVisible({ timeout: 30_000 });
});

test("media nobody serves says so", async ({ page }) => {
  const unserved = mediaVolume(sdk, "image/png", new TextEncoder().encode("nobody keeps this")).cid;
  await writeAs(poster, chainPath, write.post(poster.address, write.newId(), { title: "A lost picture" }, [unserved]));
  await openApp(page, feed);
  await expect(page.locator(".post", { hasText: "A lost picture" })).toContainText("No one is serving this file right now.");
});

test("Top orders by score and New by post time", async ({ page }) => {
  const voter = newAccount();
  await fund(voter.address, 20n, [chainPath]);
  const first = write.newId(), second = write.newId();
  await writeAs(poster, chainPath, write.post(poster.address, first, { title: "Older, liked" }));
  await writeAs(poster, chainPath, write.post(poster.address, second, { title: "Newer, unliked" }));
  await writeAs(voter, chainPath, write.vote(voter.address, poster.address, first, 1));
  await openApp(page, feed);
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
  await openApp(page, feed);
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
  await expect(page.locator(".post", { hasText: "Labelled post" })).toHaveCount(0);
});

test("a community no node serves says so, with a way out, instead of looking empty", async ({ page }) => {
  await openApp(page, "#/s/nowhere");
  const panel = page.locator(".panel.bad");
  // The node has no such chain, and none is declared anywhere: offline.
  await expect(panel).toContainText("No node serves s/nowhere right now");
  await expect(page.getByText("No posts")).toHaveCount(0);
  await panel.getByRole("button", { name: "Choose another node" }).click();
  await expect(page.locator("#st-node")).toBeVisible();
  await expect(page.locator("#st-node")).toBeFocused();
  // An address the SDK will not dial is refused, not saved.
  await page.locator("#st-node").fill("http://192.168.1.5:8080");
  await page.locator('#settings-form button[value="save"]').click();
  await expect(page.locator("#st-status")).toContainText("must be an https address");
  expect(String(await page.evaluate(() => localStorage.getItem("stoa:node")))).not.toContain("192.168.1.5");
});
