# JADM Review

Comments pinned on the **real, live jadm.ai**, shared with the whole review team.

- **The real site.** Reviewers use jadm.ai itself, signed in the way they always are (Google too). Nothing on jadm.ai is changed.
- **One button.** Each reviewer gets a personal **JADM Comment** bookmark button. Clicking it on jadm.ai adds the comment tool on top of the page.
- **Pin anywhere.** Press **Comment**, click the spot, write what is wrong. Everyone sees the numbered pin on that screen within seconds.
- **One place to read it all.** The feedback board lists every comment with its screenshot, the page, the exact element, the reviewer's screen size, and any errors the page hit. You can reply, mark fixed or won't fix, filter, and download a CSV.

## For reviewers (one time, about 2 minutes)

1. Open the review link you were sent. Type your name and the team password.
2. The next page shows your **JADM Comment** button. Press `Ctrl + Shift + B` to show the bookmarks bar, and drag the button onto it.
3. Open jadm.ai and sign in as usual.
4. Click **JADM Comment** in the bookmarks bar. The **Comment** button appears at the bottom right.

Then, whenever something is wrong: press **Comment**, click the spot, and write what you expected. Red pins are open comments, green pins are fixed. After you reload a page, click **JADM Comment** once more.

The button is personal: it signs comments with your name. Do not send it to anyone. Use a computer; phones do not run bookmark buttons easily.

## Put it online on Vercel (free, about 10 minutes)

1. Create a new **private** repository on GitHub (for example `jadm-review`) and upload these files and folders to it: `api`, `public`, `server.js`, `store.js`, `package.json`, `package-lock.json`, `vercel.json`, `render.yaml`, `README.md`. Not `node_modules` or `data`.
2. Sign in at [vercel.com](https://vercel.com) with GitHub. **Add New → Project**, pick `jadm-review`, and press **Import**.
3. Before pressing Deploy, open **Environment Variables** and add `TEAM_PASSWORD`: a long password to give the team, at least 12 characters, not a word anyone could guess. Then press **Deploy**.
4. In the new project, open **Storage → Create Database → Neon (Postgres)**, accept the free plan, and connect it to this project. This is where the comments are kept.
5. Open **Deployments**, click the **⋯** next to the newest one, and choose **Redeploy**, so the site picks up the database.
6. Open the address Vercel shows (`https://jadm-review-xxxx.vercel.app`). That is the link for the team. The feedback board is at `/__review/`.

If something is missing, the site says exactly what to set instead of showing an error.

When the review is done, download the CSV from the board, then delete the project (Settings → Delete Project) and the database (Storage). Every button stops working at once. Changing `TEAM_PASSWORD` also stops all buttons; reviewers then get new ones from the review link.

## Or on Render

The same repository also deploys on [render.com](https://render.com): **New → Blueprint**, pick the repository, press **Apply**, and give it a `TEAM_PASSWORD`. It creates its own free database. On Render's free plan the site sleeps after 15 minutes unused and takes about a minute to wake; if **JADM Comment** says the review site did not answer, open the review link once and click the button again.

## Run it on your own computer

```
npm install
node server.js
```

Open http://localhost:8080. Without `DATABASE_URL`, comments are kept in `./data`. Chrome may ask whether jadm.ai may reach this computer when you try the button against a local copy; allow it.

## Settings

| Variable | What it does |
|---|---|
| `TEAM_PASSWORD` | Asked once with the name. Required on Vercel and Render. |
| `SESSION_SECRET` | Optional. Signs reviewers' names into their cookie and their button; without it the key comes from the team password. |
| `DATABASE_URL` or `POSTGRES_URL` | PostgreSQL for the comments (Vercel's Neon database sets `POSTGRES_URL`). Without it, comments go to `./data` on your own computer. |
| `TARGET_URL` | The site the button works on. Default `https://jadm.ai`. |
| `PORT` | Default `8080`. |
| `MIRROR` | `1` also serves a live copy of jadm.ai at this site's address, with the comment tool built in. Signing in there needs an email-and-password jadm.ai login, because Google always returns to jadm.ai's own address. |
| `JADM_LOGIN_EMAIL`, `JADM_LOGIN_PASSWORD` | One such login; turns the copy on and signs reviewers in to it automatically. |
