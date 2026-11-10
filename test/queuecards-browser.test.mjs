/* global document, window, MutationObserver -- used inside page.evaluate, which runs in the browser */
// The Render Queue's job cards in a browser: progress updates leave the Cancel button the same element (so a click that began before an update still lands), a button is
// replaced only when the job's status changes, and the list is touched only when the order changes. Skipped where Playwright or its browser is not installed.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/playwright.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');

// One small server for both tests: an empty page with a list, and the app's scripts.
let server;
before(() => {
  server = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/t.html') {
      r.writeHead(200, { 'content-type': 'text/html' });
      return r.end('<!doctype html><meta charset=utf8><ul id=list></ul>');
    }
    fs.readFile(path.join(root, u), (e, d) => {
      r.writeHead(e ? 404 : 200, { 'content-type': 'text/javascript' });
      r.end(e ? undefined : d);
    });
  }).listen(0);
});
after(() => server.close());

test('a Cancel click survives progress updates, for pictures and videos', async (t) => {
  const browser = await launchBrowser(t);
  if (!browser) return;
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    const res = await page.evaluate(async () => {
      const { syncCards } = await import('/js/ui/queuecards.js');
      const { RenderQueue } = await import('/js/core/renderqueue.js');
      const list = document.getElementById('list');
      const cards = new Map();
      const cancelled = [];
      let queue;
      const build = (job) => {
        const el = document.createElement('li');
        const actions = document.createElement('div');
        const label = document.createElement('span');
        el.append(label, actions);
        let shown = null;
        return {
          el,
          update(j) {
            label.textContent = `${j.title} ${j.status} ${Math.round(j.progress * 100)}%`;
            if (shown === j.status) return;
            shown = j.status;
            const b = document.createElement('button');
            b.textContent = j.status === 'waiting' || j.status === 'running' ? 'Cancel' : 'Remove';
            b.onclick = () => {
              if (b.textContent === 'Cancel') {
                cancelled.push(`${j.kind}:${j.title}`);
                queue.cancel(j.id);
              }
            };
            actions.replaceChildren(b);
          },
        };
      };
      window.queue = queue = new RenderQueue({ onChange: () => syncCards(list, queue.jobs, cards, build) });
      const photo = queue.add({ n: 1 }, { kind: 'photo', title: 'Picture' });
      const video = queue.add({ n: 2 }, { kind: 'video', title: 'Video' });
      const out = {};
      queue.start(photo);
      const button = list.querySelector('li button');
      const items = [...list.children];
      // Progress arrives many times a second: nothing in the list may be replaced.
      for (let i = 1; i <= 10; i++) queue.setProgress(photo, i / 20, 'Rendering');
      out.sameButton = list.querySelector('li button') === button;
      out.sameItems = [...list.children].every((el, i) => el === items[i]);
      out.label = list.children[0].textContent;
      return { out, video: video.id };
    });
    assert.ok(res.out.sameButton, 'the Cancel button is the same element after progress updates');
    assert.ok(res.out.sameItems);
    assert.equal(res.out.label, 'Picture running 50%Cancel');

    // A real press on the running picture's Cancel, progress arriving before the release (what lost the click before), then the release.
    const first = page.locator('#list li').nth(0).locator('button');
    const box = await first.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.evaluate(() => {
      const job = window.queue.running;
      for (let i = 11; i <= 15; i++) window.queue.setProgress(job, i / 20, 'Rendering');
    });
    assert.match(await page.locator('#list li').nth(0).textContent(), /75%/, 'progress came in while the button was held');
    await page.mouse.up();
    // The waiting video's Cancel is clicked normally.
    await page.locator('#list li').nth(1).locator('button').click();
    const state = await page.evaluate(() => [...document.querySelectorAll('#list li')].map((li) => li.textContent));
    assert.match(state[0], /cancelled/);
    assert.match(state[1], /cancelled/);
    assert.match(await page.locator('#list li').nth(0).locator('button').textContent(), /Remove/, 'a cancelled job offers Remove');
  } finally {
    await browser.close();
  }
});

test('the list is touched only when the order changes', async (t) => {
  const browser = await launchBrowser(t);
  if (!browser) return;
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    const res = await page.evaluate(async () => {
      const { syncCards, pruneCards } = await import('/js/ui/queuecards.js');
      const list = document.getElementById('list');
      const cards = new Map();
      const build = (job) => {
        const el = document.createElement('li');
        return { el, update: (j) => { el.textContent = j.title; } };
      };
      const jobs = [{ id: 1, title: 'a' }, { id: 2, title: 'b' }, { id: 3, title: 'c' }];
      syncCards(list, jobs, cards, build);
      let mutations = 0;
      const watch = new MutationObserver((m) => { mutations += m.filter((x) => x.type === 'childList').length; });
      watch.observe(list, { childList: true });
      jobs[1].title = 'b2';
      syncCards(list, jobs, cards, build);
      await Promise.resolve();
      const quiet = watch.takeRecords().length + mutations;
      syncCards(list, [jobs[2], jobs[0]], cards, build);
      const after = [...list.children].map((li) => li.textContent);
      // With the view closed only the cards are pruned: a cleared job's card goes, and the list is not drawn.
      pruneCards(cards, [jobs[2]]);
      return { quiet, after, size: cards.size, pruned: [...cards.keys()], shown: list.children.length };
    });
    assert.equal(res.quiet, 0, 'a text change alone leaves the list untouched');
    assert.deepEqual(res.after, ['c', 'a']);
    assert.deepEqual(res.pruned, [3], 'pruning keeps only the cards of jobs still listed');
    assert.equal(res.shown, 1, 'a pruned card leaves the list too');
  } finally {
    await browser.close();
  }
});
