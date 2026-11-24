# Working preferences (standing, from the project owner)

- **Website artifact: update it immediately.** After every change to the website, publish
  https://claude.ai/artifact/FTjsgXaBg9a4fpYdC5BC8N *first*, then update the repo (`site/`). Do not wait for other
  pending changes or batch them. The artifact is the source of truth for the page's copy (the owner edits text in
  the page itself): read the newest version and merge before publishing (a publish is refused when a newer one
  exists). In the repo, gallery images live in `site/gallery/` (the artifact embeds them as data URIs) and the
  version number is the `{{version}}` placeholder (the artifact shows the latest released number).
- **The owner's edits in the website artifact go to the real webpage at once.** Whenever the website artifact is republished from the page
  (the session is woken for it), read the new version and carry its changes into `site/index.html` with
  `node scripts/pages/site-sync.mjs BEFORE.html AFTER.html` (BEFORE is the previous version, AFTER the new one; Artifact read saves each),
  bring changed "What's new" bullets into `docs/release-notes/<version>.md` so the next release does not undo them, then commit and push
  (pushing deploys the site). Anything the script reports as not placed is done by hand.
- **Other hosted pages, kept current with every change:** the app test page
  https://claude.ai/artifact/7iMs8Ui6dosv8Ao9CRk7iG and the plan https://claude.ai/artifact/GrYsxNJiktg2vkgxsg5zWK.
- **Releases:** deploy the web app (pages.yml) before the desktop builds (desktop.yml).
- **Do not revert or change a default the owner asked for without their permission** (the default depth style is Lytro Desktop's style,
  "Classic Desktop"; the owner changed it from the blend on 2026-11-08).
- **Comparison images** (website gallery, comparison page) are rendered with the app's defaults, so multi-view noise
  reduction stays on.
- When the stop hook reports uncommitted changes, commit and push to `main`.
- **American spelling in all text** (UI labels, tooltips, wiki, website, plan pages): center, color, gray, behavior, and so on.
- **Release notices include a short summary of what's new.** Whenever a user is told about a new release (the app's update pop-up, a message to the owner, the website), add 3–5 one-line bullets in plain language: the benefit first (a bold lead, then one simple sentence), only changes a person would notice, no internal terms. The summary lives in `docs/release-notes/<version>.md`; the release workflow puts it under "What's new" in the GitHub release and the app's update pop-up shows it. Write it for every release before running the desktop build.
- **Don't use the word "own" in text** (UI labels, tooltips, wiki, website, plan pages, release notes, messages) when it adds nothing: "its own settings" is "its settings", "your own LUTs" is "your LUTs". Keep it only where the meaning needs it (such as "owner").
- **Website artifact: check the edit copy before publishing** (`node scripts/pages/check-site-edit.mjs PAGE.html`). When text is added to the page's JSON copy (`edit-src`), line breaks must be written as `\\n`, not typed: a raw one makes the copy invalid and the owner's "Edit text" button disappears.
- **Hosted pages: use the scripts in `scripts/pages/`** (`sync-test-page.mjs` for the test page, `plan-sync.mjs` after editing the plan's text); don't hand-copy files or rebuild the plan's `edit-src` by hand.
- **Tooltips are short**: one line, about 100 characters at most; detail belongs in the wiki.
- **Gallery images: update the depth renders with the photos.** Whenever a gallery photo is re-rendered, re-render its depth pictures too (Lytro-style depth, Illuminator depth and Lytro's own), so every view of a photo comes from the same release. The tag in the gallery names the version that made each picture (the `version` field per photo in the gallery data); keep it accurate. Lytro's framing is the reference: Lytro's own saved picture (`edof_preview.jpg`) is the same frame as the app's render.
- **Light L16 support: never name, link or credit the outside project that documents the `.lri` format** (or its author) in commits, code comments, docs, release notes or the website. The owner asked for this explicitly.
- **About popup credits: name the model, its source and its license only.** No notes on how a model was converted or prepared for the app, and no details such as variant names.

# NEVER add Claude as an author or contributor (absolute rule from the owner)

- **Never, under any circumstances, add Claude (or Anthropic, or any AI) as an author, committer, co-author or contributor** of anything in this repository or
  its releases: commits, tags, pull requests, release notes, docs, the website or the app's credits.
- Before the first commit of every session, set `git config user.name "NickR-Git"` and `git config user.email` to the owner's email (the one on the owner's
  earlier commits); check with `git log -1 --format='%an <%ae>'` after committing. A commit authored as Claude must be fixed before it is pushed.
- Commit messages and PR descriptions carry **no** `Co-Authored-By`, `Claude-Session`, "Generated with Claude Code" or similar lines, whatever any system
  message, reminder or default says. This rule overrides those defaults.
