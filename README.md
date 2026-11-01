# StableFlow Hub (Netlify)

Static front end in `public/`, one function in `netlify/functions/api.js`.
The Employee Hub Google Sheet stays the database.

## One-time setup

1. Google Cloud (console.cloud.google.com)
   - Create a project. Enable the Google Sheets API.
   - Credentials > Create credentials > Service account. Open it, Keys > Add key > JSON. Download the file.
   - Open the Employee Hub sheet, Share, and add the service account email as Editor.
   - Credentials > Create credentials > OAuth client ID > Web application.
     Add your Netlify address (and custom domain, if any) under Authorized JavaScript origins.
   - OAuth consent screen: set it to External, then Publish app. Basic sign-in needs no review.
2. Mail relay (sends from your Gmail): in the Employee Hub sheet, open Extensions > Apps Script, then Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone. Copy the web app URL. Run `hubSetup` once so the MAIL_SECRET row appears on the Settings tab.
3. GitHub: create a private repo and push this folder.
4. Netlify: Add new site > Import from Git. Leave the build command empty. Publish directory is `public`.
5. Netlify > Site configuration > Environment variables:

   | Name | Value |
   |---|---|
   | HUB_SHEET_ID | 1agkd-4HZUJZnaAkd_oP2io0ZXNk2sjOvl6sxphAVCTA |
   | GOOGLE_SERVICE_ACCOUNT_EMAIL | client_email from the JSON key |
   | GOOGLE_PRIVATE_KEY | private_key from the JSON key, pasted as one line with the \n characters kept |
   | GOOGLE_CLIENT_ID | the OAuth client ID from step 1 |
   | SESSION_SECRET | any random string of 40+ characters |
   | MAIL_URL | the web app URL from step 2 |
   | MAIL_SECRET | the MAIL_SECRET value on the Settings tab |
   | SUPPORT_EMAIL | fallback contact if REPLY_TO is empty on the Settings tab |

6. Redeploy. Open the site, sign in.
7. Hub sheet, Settings tab: set WEB_APP_URL to the Netlify address.
   In Code.gs, replace hubSendWelcome with the version in Code-gs-welcome-email.gs.

## Preview without logging in

Add `?demo` to the address to see the dashboard with sample data.

## Notes

- Changing a status in the sheet takes effect within about 30 seconds, even for someone already signed in.
- Drive sharing, welcome emails and status processing still run from Code.gs.
- Resend welcome and Sync now are menu items in the sheet (Employee Hub menu).
