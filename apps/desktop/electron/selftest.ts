// Automated end-to-end check of the real app (development tool, enabled only by environment variables).
// It drives the real window: closes the welcome note, picks the folder, asks one question, waits for the answer,
// takes screenshots along the way and prints what happened.
import type { BrowserWindow } from "electron";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A Windows GUI app has no console, so results are also appended to a log file.
const log = (...a: unknown[]) => {
  const line = a.map(String).join(" ");
  console.log(line);
  if (process.env.LF_SELFTEST_LOG) appendFileSync(process.env.LF_SELFTEST_LOG, `${line}\n`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSelfTest(win: BrowserWindow, opts: { question: string; shotsDir: string; timeoutMs: number; confirm: "approve" | "cancel" | "none" }): Promise<boolean> {
  const js = <T>(code: string) => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const shot = async (name: string) => {
    const img = await win.webContents.capturePage();
    mkdirSync(opts.shotsDir, { recursive: true });
    writeFileSync(join(opts.shotsDir, `${name}.png`), img.toPNG());
    log(`SELFTEST screenshot ${name}`);
  };
  const click = (text: string) =>
    js<boolean>(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent && x.textContent.trim().startsWith(${JSON.stringify(text)}) && !x.disabled); if (b) { b.click(); return true; } return false; })()`);

  await sleep(2500);
  await shot("01-start");
  await click("Get started");
  await sleep(400);
  log("SELFTEST pick folder:", await click("Select folder"));

  // wait for the files to be registered (the Ask box becomes enabled)
  const t0 = Date.now();
  for (;;) {
    const ready = await js<boolean>(`(() => { const t = document.querySelector('textarea'); return !!t && !t.disabled; })()`);
    if (ready) break;
    if (Date.now() - t0 > 120000) {
      await shot("02-folder-timeout");
      log("SELFTEST FAIL: folder never became ready");
      return false;
    }
    await sleep(500);
  }
  await sleep(600);
  log("SELFTEST folder:", await js<string>(`(document.querySelector(".folder__bar") || { textContent: "" }).textContent.replace(/\s+/g, " ")`));
  log("SELFTEST file statuses:", await js<string>(`[...document.querySelectorAll(".file")].map((e) => e.textContent.replace(/\s+/g, " ").trim()).join(" || ")`));
  await shot("02-folder-ready");

  await js(`(() => { const t = document.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ${JSON.stringify(opts.question)}); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  log("SELFTEST ask:", await click("Ask"));

  const start = Date.now();
  let shots = 0;
  let confirmed = false;
  while (Date.now() - start < opts.timeoutMs) {
    await sleep(1200);
    const state = await js<{ done: boolean; err: string; confirm: boolean; badge: string; narr: string }>(`(() => ({
      done: !!document.querySelector('.badges .badge, .notice--error'),
      err: (document.querySelector('.notice--error') || {}).textContent || '',
      confirm: !!document.querySelector('[aria-label="Confirm what will be sent"]'),
      badge: (document.querySelector('.badge--local, .badge--remote') || {}).textContent || '',
      narr: (document.querySelector('.narrator') || {}).textContent || ''
    }))()`);
    if (state.confirm && opts.confirm !== "none" && !confirmed) {
      await shot("04-confirm");
      confirmed = true;
      await click(opts.confirm === "approve" ? "Send" : "Cancel");
    }
    if (shots < 3 && (Date.now() - start) / 4000 > shots) {
      shots++;
      await shot(`03-running-${shots}`);
      log("SELFTEST narrator:", state.narr);
    }
    if (state.done) {
      await sleep(1500);
      await shot("05-answer");
      const summary = await js<string>(`document.querySelector('.msg--assistant .answer') ? document.querySelector('.msg--assistant .answer').textContent.slice(0, 400) : ''`);
      log("SELFTEST badge:", state.badge || "(none)", "| error:", state.err || "(none)");
      log("SELFTEST answer:", summary);
      log("SELFTEST narrator:", await js<string>(`document.querySelector('.narrator').textContent`));
      // open the node inspector for the gate to prove it renders, then screenshot
      await js(`(() => { const g = document.querySelector('.node[aria-label^="Privacy gate"]'); if (g) g.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`);
      await sleep(400);
      await shot("06-inspector");
      return !state.err;
    }
  }
  await shot("99-timeout");
  log("SELFTEST FAIL: timed out waiting for the answer");
  return false;
}
