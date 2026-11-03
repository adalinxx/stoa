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
import * as read from "../../client/read.mjs";
import * as places from "../../client/places.mjs";
import * as write from "../../client/write.mjs";
import { FOLLOWS, MONIKER, start } from "./stack.mjs";

const running = await start();
writeFileSync(new URL("./.stack.json", import.meta.url), JSON.stringify(running.info));
const {
  approveInSelfhold, balance, chainPath, claimAs, declineInSelfhold, fund, homePath, newAccount, newSelfholdAccount,
  openApp, sdk, selfholdRequests, sends, shot, signIn, stack, stateOf, walletOrigin, writeAs,
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
// Another client's poster and voter, who sign with keys they hold.
const poster = newAccount();
const voter = newAccount();
const sponsorBalance = () => balance(stack.sponsorAddress, chainPath);
// A 1x1 PNG.
const picture = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4500000000049454e44ae426082", "hex");

test("a visitor reads the communities, and is told what taking part takes: a passkey, no install, no coins", async ({ page }) => {
  await openApp(page);
  await expect(page.locator("#communities")).toContainText(community);
  await expect(page.locator("#who")).toHaveText("Sign in");
  await expect(page.locator("#aside")).toContainText("nothing to install, no coins");
  await shot(page, "visitor-feed");
  await page.locator("#who").getByRole("button", { name: "Sign in" }).click();
  const dialog = page.locator("#signin");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("a passkey makes your account");
  await expect(dialog).toContainText("you need no coins");
  await shot(page, "signin-dialog");
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
  await shot(page, "new-post-signed-out");
  // Post signs in first; the draft stays, and the next press sends it.
  const address = await newSelfholdAccount(page, page.locator("#np-post"));
  await expect(page.locator("#np-status")).toHaveText("You're signed in. Press Post to send it.");
  await expect(page.locator("#np-cost")).toContainText("Free: this device does a moment's work for the fee");
  await expect(page.locator("#np-t")).toHaveValue("The whitepaper");
  await shot(page, "new-post-signed-in");
  await approveInSelfhold(page, page.locator("#np-post"));
  await expect(page).toHaveURL(new RegExp(`#/s/${community}/${address}/`));
  // Read back from the chain, not the page's own pending copy: a post time shows.
  await expect(page.locator(".op .meta time")).toBeVisible();
  await expect(page.locator(".op h1")).toHaveText("The whitepaper");
  await expect(page.locator(".op .link")).toHaveAttribute("href", "https://bitcoin.org/bitcoin.pdf");
  await shot(page, "post-landed");
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
  await shot(page, "comments-pending");
  await landed(page);

  // A vote counts at once, waits for its block, settles, and can be taken back.
  await page.goto(stack.app + feed);
  const row = page.locator(".post", { hasText: "The whitepaper" });
  await expect(row.locator(".meta")).toContainText("2 comments");
  await approveInSelfhold(page, row.locator(".vote.up"));
  await expect(row.locator(".votes .score")).toHaveText("1");
  await shot(page, "voted");
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
  await shot(page, "profile-dialog-new");

  // Someone else's name is said to be so as it's typed, and can't be
  // pressed: Selfhold's window never opens for it, and nothing is sent.
  const sent = sends(page.context());
  const asked = await selfholdRequests(page);
  await page.locator("#pf-handle").fill("taken_one");
  await expect(page.locator("#pf-handle-status")).toHaveText("@taken_one is someone else's.");
  await expect(page.locator("#pf-handle-btn")).toBeDisabled();
  await shot(page, "handle-taken");
  await page.locator("#pf-handle").press("Enter");
  await expect(page.locator("#pf-handle-status")).toHaveText("@taken_one is someone else's.");
  expect(await selfholdRequests(page)).toBe(asked);
  expect(sent).toHaveLength(0);
  // A free one says so, and is claimed, pointed here and shown, in one approval.
  await page.locator("#pf-handle").fill("@Ada_Stoa");
  await expect(page.locator("#pf-handle-status")).toHaveText("@ada_stoa is free. It's yours once you claim it.");
  await shot(page, "handle-free");
  await approveInSelfhold(page, page.getByRole("button", { name: "Claim @ada_stoa" }));
  await expect(page.locator("#pf-handle-status")).toHaveText("@ada_stoa is your handle now.", { timeout: 180_000 });
  await shot(page, "handle-claimed");
  expect(await names.handleOf(await stateOf(MONIKER), address)).toBe("ada_stoa");
  expect(await balance(address, MONIKER)).toBe(0n);

  await page.locator("#pf-name").fill("Ada");
  await page.locator("#pf-bio").fill("Reads whitepapers.");
  await approveInSelfhold(page, page.locator("#pf-save"));
  await expect(dialog).toBeHidden();
  await expect(page.locator("#who .account-name")).toHaveText("Ada @ada_stoa");
  await page.locator("#account-btn").click();
  await shot(page, "account-menu");
  await page.keyboard.press("Escape");
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
  await shot(visitor, "profile-page-visitor");
  await expect(visitor.locator("[data-edit-profile]")).toHaveCount(0);
  await reader.close();
});

test("an image is kept for good by the sponsor, paid with this device's work, and shown in the post", async ({ page }) => {
  await openApp(page, feed);
  await signIn(page);
  await page.getByRole("button", { name: "New post" }).click();
  await page.locator("#np-c").selectOption(community);
  await page.locator("#np-t").fill("A kept picture");
  await expect(page.locator("#np-file-wrap")).toBeVisible();
  await page.locator("#np-file").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: picture });
  await shot(page, "media-keeping");
  // While it is being kept, Post waits.
  await expect(page.locator("#np-media .media-status")).toContainText("Kept for good", { timeout: 300_000 });
  await expect(page.locator("#np-post")).toBeEnabled();
  await shot(page, "media-kept");
  const cid = mediaVolume(sdk, "image/png", new Uint8Array(picture)).cid;
  const kept = await (await fetch(`${stack.sponsor}/store/${cid}`)).json();
  expect(kept.stored).toBe(true);
  await approveInSelfhold(page, page.locator("#np-post"));
  await expect(page.locator(".op .meta time")).toBeVisible();
  await expect(page.locator(".op img.media")).toBeVisible();
  await shot(page, "post-with-image");
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
  await shot(page, "declined");
  await expect(page.locator("#np-t")).toHaveValue("Declined in the wallet");
  expect(sent).toHaveLength(0);
});

test("a visitor who votes is asked to sign in, and told why", async ({ page }) => {
  await openApp(page, feed);
  await page.locator(".post .vote.up").first().click();
  await expect(page.locator("#signin")).toBeVisible();
  await expect(page.locator("#join-why")).toContainText("Votes are signed by your account");
  await shot(page, "vote-signed-out");
  expect(await selfholdRequests(page)).toBe(0);
  // Continue makes the account; the vote waits for the next press.
  await newSelfholdAccount(page, page.locator("#signin").getByRole("button", { name: "Continue with Selfhold" }));
  await expect(page.locator("#signin")).toBeHidden();
  await expect(page.locator("#who #account-btn")).toBeVisible();
});

test("s/all shows every community's posts, each named, and is no place to post", async ({ page }) => {
  await fund(poster.address);
  await writeAs(poster, chainPath, write.post(poster.address, write.newId(), { title: "From another client" }));
  await openApp(page, "#/s/all");
  await expect(page.locator(".post", { hasText: "From another client" }).locator(".meta")).toContainText(`s/${community}`);
  await expect(page.locator("#join")).toHaveCount(0);
  await page.getByRole("button", { name: "New post" }).first().click();
  await expect(page.locator("#np-c option[value=all]")).toHaveCount(0);
});

test("what members downvoted more than upvoted is collapsed for every reader, with Show", async ({ page }) => {
  await fund(voter.address);
  const id = write.newId();
  await writeAs(poster, chainPath, write.post(poster.address, id, { title: "Downvoted post" }));
  // The poster wrote among the community's first posts: a member, whose
  // downvote outweighs the no member upvotes.
  await writeAs(poster, chainPath, async (state) => write.vote(poster.address, await read.edgesOf(state, poster.address), poster.address, id, -1));
  // A fresh account's upvote is kept, and does not count.
  await writeAs(voter, chainPath, async (state) => write.vote(voter.address, await read.edgesOf(state, voter.address), poster.address, id, 1));
  await openApp(page, feed);
  const hidden = page.locator(".hidden-row", { hasText: "more members downvoted it" });
  await expect(hidden).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".post", { hasText: "Downvoted post" })).toHaveCount(0);
  await hidden.getByRole("button", { name: "Show" }).click();
  await expect(page.locator(".post", { hasText: "Downvoted post" })).toBeVisible();
});

test("media nobody serves says so", async ({ page }) => {
  const unserved = mediaVolume(sdk, "image/png", new TextEncoder().encode("nobody keeps this")).cid;
  await writeAs(poster, chainPath, write.post(poster.address, write.newId(), { title: "A lost picture" }, [unserved]));
  await openApp(page, feed);
  await expect(page.locator(".post", { hasText: "A lost picture" })).toContainText("No one is serving this file right now.");
});

test("Top orders by members' score and New by post time; a stranger's vote counts for nothing", async ({ page }) => {
  const stranger = newAccount();
  await fund(stranger.address, 20n, [chainPath]);
  const first = write.newId(), second = write.newId();
  await writeAs(poster, chainPath, write.post(poster.address, first, { title: "Older, liked" }));
  await writeAs(poster, chainPath, write.post(poster.address, second, { title: "Newer, unliked" }));
  // The poster wrote among the community's first posts: a member.
  await writeAs(poster, chainPath, async (state) => write.vote(poster.address, await read.edgesOf(state, poster.address), poster.address, first, 1));
  // A fresh account nobody has engaged with: its vote is kept, and not counted.
  await writeAs(stranger, chainPath, async (state) => write.vote(stranger.address, await read.edgesOf(state, stranger.address), poster.address, second, 1));
  await openApp(page, feed);
  const titles = () => page.locator(".post h2").allInnerTexts();
  await page.getByRole("button", { name: "Top", exact: true }).click();
  await expect.poll(async () => (await titles()).indexOf("Older, liked") < (await titles()).indexOf("Newer, unliked")).toBe(true);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect.poll(async () => (await titles())[0]).toBe("Newer, unliked");
  const unliked = page.locator(".post", { hasText: "Newer, unliked" });
  await expect(unliked.locator(".votes .score")).toHaveText("0");
});

test("Follow on a profile goes to Follows; the Following feed shows their posts; a member's follow makes your votes count", async ({ page }) => {
  const title = "A post from someone followed";
  await writeAs(poster, chainPath, write.post(poster.address, write.newId(), { title }));
  await openApp(page, feed);
  const address = await signIn(page);
  // Nobody has vouched for a new account: its votes are kept, and not counted yet.
  await expect(page.locator("#aside-you")).toHaveText(/are kept, and count once members upvote what you post here or follow you/);
  const following = page.locator("nav.rail").getByRole("link", { name: "Following" });
  await following.click();
  await expect(page.locator("#feed")).toContainText("You don't follow anyone yet");

  await page.goto(stack.app + `#/u/${poster.address}`);
  await approveInSelfhold(page, page.getByRole("button", { name: "Follow", exact: true }));
  await expect(page.getByRole("button", { name: "Following", exact: true })).toBeVisible();
  await expect.poll(async () => (await stateOf(FOLLOWS)).get(`follows/${address}/${poster.address}`)).toBe("1");
  expect(await (await stateOf(FOLLOWS)).get(`followers/${poster.address}/${address}`)).toBe("1");
  expect(await balance(address, FOLLOWS)).toBe(0n);
  await page.reload();
  await expect(page.getByRole("button", { name: "Following", exact: true })).toBeVisible();
  await following.click();
  await expect(page.locator(".post", { hasText: title })).toBeVisible();

  // A member follows them back: their votes count.
  await fund(poster.address, 20n, [FOLLOWS]);
  await writeAs(poster, FOLLOWS, write.follow(poster.address, address));
  await page.goto(stack.app + feed);
  await page.reload();
  await expect(page.locator("#aside-you")).toHaveText("count: you're one of its members.");
});

test("an earlier render that finishes last does not write over a newer one", async ({ page }) => {
  // Force the race: hold the community reads the first render makes after it
  // has read the chain's tip, go to another page and let its render finish,
  // then release the first. Without the guard the first render writes the
  // community's feed over the page the reader went to.
  let communityReads = 0;
  let moved = false;
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route("**/volumes/**", async (route) => {
    const fromCommunity = new URL(route.request().url()).searchParams.get("chainPath") === chainPath.join("/");
    if (fromCommunity && !moved && ++communityReads > 2) await held;
    await route.continue();
  });
  await openApp(page, feed);
  await expect.poll(() => communityReads, { timeout: 60_000 }).toBeGreaterThan(2);
  moved = true;
  await page.evaluate(() => (location.hash = "#/s/nowhere"));
  const panel = page.locator(".panel.bad", { hasText: "No node serves s/nowhere" });
  await expect(panel).toBeVisible({ timeout: 60_000 });
  release();
  await page.waitForTimeout(5000);
  await expect(panel).toBeVisible({ timeout: 1000 });
  await expect(page.locator(".post")).toHaveCount(0);
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

test("a new community lives on Stoa's chain: made from the rail, posted to, and kept apart from the others", async ({ page }) => {
  await openApp(page, feed);
  const address = await signIn(page);
  const name = `town-${Date.now().toString(36)}`;
  await page.getByRole("button", { name: "New community" }).click();
  await page.locator("#nc-name").fill(name);
  await approveInSelfhold(page, page.locator("#nc-create"));
  await expect(page).toHaveURL(new RegExp(`#/s/${name}$`));
  await expect(page.locator("#communities")).toContainText(`s/${name}`);
  await expect.poll(async () => (await stateOf(homePath)).get(`index/community/${name}/${address}`)).toBe(JSON.stringify({ at: "home" }));
  await shot(page, "community-made");

  await page.locator("#open-new").click();
  await page.locator("#np-c").selectOption(name);
  await page.locator("#np-t").fill("First on the shared chain");
  await approveInSelfhold(page, page.locator("#np-post"));
  await expect(page.locator(".op .meta time")).toBeVisible();
  // On the home chain, listed under the community, the post saying where it is.
  const home = await stateOf(homePath);
  const listed = [];
  for await (const [key] of home.list(`index/c/${name}/post/`)) listed.push(key);
  expect(listed).toHaveLength(1);
  const [, , , , id] = listed[0].split("/");
  expect(JSON.parse(await home.get(`user/${address}/post/${id}`)).c).toBe(name);

  // A vote on it is kept with the community's records on the home chain.
  await openApp(page, `#/s/${name}`);
  await approveInSelfhold(page, page.locator(".post", { hasText: "First on the shared chain" }).locator(".vote.up"));
  await expect.poll(async () => (await stateOf(homePath)).get(`user/${address}/c/${name}/edges/0`), { timeout: 120_000 }).toContain(`${address}/${id}`);

  // Another community doesn't show it.
  await openApp(page, feed);
  await expect(page.locator(".post").first()).toBeVisible();
  await expect(page.locator(".post", { hasText: "First on the shared chain" })).toHaveCount(0);
});

test("a community with a chain of its own moves to Stoa's chain when its members choose: new posts go there, earlier ones stay", async ({ page }) => {
  // The poster wrote among the community's first posts: a member, whose choice counts.
  await writeAs(poster, homePath, places.declare(poster.address, community, "home"));
  try {
    await openApp(page, feed);
    await expect(page.locator("#aside")).toContainText("Stoa's chain, as its members chose");
    const address = await signIn(page);
    await page.locator("#open-new").click();
    await page.locator("#np-c").selectOption(community);
    await page.locator("#np-t").fill("After the move");
    await approveInSelfhold(page, page.locator("#np-post"));
    await expect(page.locator(".op .meta time")).toBeVisible();
    const listed = [];
    for await (const [key] of (await stateOf(homePath)).list(`index/c/${community}/post/`)) listed.push(key);
    expect(listed.some((key) => key.endsWith(`/${address}`))).toBe(true);
    // Its earlier posts, on its own chain, are read with the new ones.
    await openApp(page, feed);
    await expect(page.locator(".post", { hasText: "After the move" })).toBeVisible();
    await expect(page.locator(".post", { hasText: "Older, liked" })).toBeVisible();
  } finally {
    // Back to its own chain, for whatever runs next.
    await writeAs(poster, homePath, places.declare(poster.address, community, "own"));
  }
});
