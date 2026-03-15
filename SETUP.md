# VaultMind — Replit Deployment Guide

## What you have
- `server/` — Express backend (keeps your API key secure)
- `client/` — React frontend

---

## Step-by-step Replit setup (20 min)

### 1. Get your Anthropic API key
1. Go to https://console.anthropic.com
2. Sign up / log in
3. Click "API Keys" → "Create Key"
4. Copy the key (starts with `sk-ant-...`)
5. Add £10–£20 credit (lasts a long time at <1p/question)

### 2. Create a Replit account
- Go to https://replit.com and sign up free

### 3. Create a new Repl
1. Click **"Create Repl"**
2. Choose **"Import from GitHub"** OR **"Node.js"** template
3. Name it `vaultmind`

### 4. Upload the files
Upload all files maintaining this structure:
```
vaultmind/
├── package.json
├── server/
│   ├── index.js
│   └── package.json
└── client/
    ├── package.json
    ├── public/
    │   └── index.html
    └── src/
        ├── index.js
        └── App.js
```

### 5. Add your API key as a Secret
1. In Replit, click the **padlock icon** (Secrets) in the left sidebar
2. Click **"New Secret"**
3. Key: `ANTHROPIC_API_KEY`
4. Value: paste your `sk-ant-...` key
5. Click **"Add Secret"**

⚠️ This keeps your API key hidden from all users — they never see it.

### 6. Set the run command
In Replit's Shell tab, run:
```bash
npm run install-all
npm run build
npm run start
```

Or set the `.replit` run command to: `npm run setup`

### 7. Share with your team
- Replit gives you a URL like `https://vaultmind.yourname.repl.co`
- Share this link with your colleagues
- They open it in any browser — no install needed

---

## Sharing with colleagues
- Anyone with the URL can use it
- To restrict access: use Replit's built-in auth or add a simple password (ask Claude to add one)
- All users share the same Anthropic API credit pool

---

## Cost management
- Each question costs roughly < 1p
- Monitor usage at https://console.anthropic.com/usage
- Set spend limits in the Anthropic console to cap monthly costs

---

## Iterating / updating
1. Make changes in Claude.ai (demo mode shows UI instantly)
2. When happy, copy updated `App.js` to Replit
3. Run `npm run build && npm run start` in Replit shell
4. Refresh the URL — done

---

## Troubleshooting
- **"API key not set"** → Check Secrets tab, key must be `ANTHROPIC_API_KEY`
- **Blank page** → Run `npm run build` first
- **Port error** → Replit uses `process.env.PORT` automatically (already handled)
