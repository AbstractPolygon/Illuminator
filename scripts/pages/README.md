# Hosted pages

The app test page and the plan are Artifact pages kept current by hand with every change. These scripts do the error-prone parts.

- `sync-test-page.mjs MIRROR_DIR`: copies what changed in `app/` into the test page's folder, rebuilds its `page.html`, and prints the changed paths as JSON. Publish `page.html`
  with `root` set to the folder and those paths as `files` and `overwrite_unread`.
- `site-sync.mjs BEFORE.html AFTER.html [site/index.html]`: carries the edits between two versions of the website artifact into the repo's site
  (the page embeds images and shows the version number; the site keeps `gallery/` files and `{{version}}`). Changed blocks it cannot place
  are printed and nothing is written.
- `plan-sync.mjs PLAN.html`: after editing the plan's visible text, rebuilds the JSON copy of it (`edit-src`) the page edits itself from. Then publish the file.

Both are safe to run again: they change nothing when nothing differs.
