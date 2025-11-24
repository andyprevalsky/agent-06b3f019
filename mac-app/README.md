# Rose Desktop - Integration Data Uploader

A Mac-only Electron application for securely uploading iMessage and Chrome Cookies data to Rose.

## Features

- 🔐 **Secure Authentication** - Phone-based OTP authentication via Supabase
- 💬 **iMessage Import** - Read and upload your iMessage conversation history
- 🍪 **Chrome Cookies** - Decrypt and upload Chrome browser cookies
- 🔒 **End-to-End Encryption** - All data encrypted before upload (AES-256-CBC)
- 💾 **Session Persistence** - Stay logged in between app restarts

## Prerequisites

- macOS (this app is Mac-only)
- Node.js 18+ and npm
- Full Disk Access permission for iMessage access

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Create `.env` file:**
   ```bash
   cp .env.example .env
   ```

3. **Configure environment variables in `.env`:**
   ```env
   VITE_SUPABASE_URL=your-supabase-url
   VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
   VITE_BACKEND_URL=http://localhost:3001
   ENCRYPTION_KEY=your-secure-encryption-key
   ```

## Development

```bash
npm run dev
```

This will:
- Start Vite dev server on `http://localhost:5173`
- Launch Electron app with hot-reload

## Building

```bash
npm run build
```

Creates production builds:
- `.dmg` installer
- `.zip` distribution

## Granting Full Disk Access (for iMessage)

1. Open **System Preferences** → **Privacy & Security**
2. Click **Full Disk Access**
3. Click the **+** button
4. Navigate to and select the **Rose Desktop** app
5. Restart the app

## Architecture

Following [electron-template](https://github.com/fameoflight/electron-template) best practices:

### Main Process (Node.js)
- `main/index.ts` - Window creation and app lifecycle
- `main/preload.ts` - IPC bridge (security boundary)
- `main/services/` - Business logic (iMessage, Cookies, Upload)
- `main/handlers/` - IPC handlers
- `main/base/` - Shared utilities (Config, Crypto)

### Renderer Process (React)
- `ui/App.tsx` - Main app component
- `ui/components/` - React components
- `ui/hooks/` - Custom React hooks
- `ui/lib/` - Supabase client

### Shared
- `shared/types/ipc.ts` - TypeScript IPC contracts

## Security

- ✅ `nodeIntegration: false` - Renderer has no Node.js access
- ✅ `contextIsolation: true` - Renderer is sandboxed
- ✅ IPC Bridge - All file system access via typed APIs
- ✅ Client-side encryption - Data encrypted before upload
- ✅ Session encryption - Auth tokens stored encrypted

## Tech Stack

- **Electron** - Desktop framework
- **React 18** + **TypeScript** - UI
- **Vite** - Build tool & HMR
- **Supabase** - Authentication
- **electron-store** - Encrypted session storage
- **better-sqlite3** - Reading iMessage/Cookies DBs
- **Tailwind CSS** - Styling

## License

MIT

