# Buddy

A small always-on-top notes app for Windows. A light-brown floating icon stays on your desktop; click it to open notes with tasks and subtasks inside each note. Everything is free and stored on your PC — no accounts, no cloud fees.

---

## What you need

- **Windows 10 or 11**
- **Node.js 20 or newer** ([download here](https://nodejs.org/))
  - During install, leave **“Add to PATH”** checked
  - Close and reopen any terminal after installing

Check that Node works:

```powershell
node -v
npm -v
```

Both should print version numbers.

---

## Setup (first time)

1. **Get the project folder**  
   Copy or clone this `buddy` folder onto your PC (for example on the Desktop).

2. **Install Node.js 20+** from [nodejs.org](https://nodejs.org/) if you do not have it yet  
   (leave **Add to PATH** checked, then open a new terminal).

3. **Start Buddy** — easiest option: double-click **`Start Buddy.bat`** in the folder.  
   On the first run it runs `npm install`, then opens the app.

### Or use the terminal

Open PowerShell in the `buddy` folder and run:

```powershell
npm install
npm run preview
```

A light-brown square icon should appear on your desktop (usually near the bottom-right).

---

## Everyday use

| Action | How |
|--------|-----|
| Move the icon | Drag it |
| Open notes | Click the icon |
| New note | **New note** in the panel |
| Add a task | Type under **Tasks** and press the + button |
| Add a subtask | Hover a task → click + |
| Minimize | Click **−** (returns to the floating icon) |
| Resize the panel | Drag corners or edges |

There is no close button on purpose — Buddy is meant to stay available. Minimize to hide the panel.

After you run it once, Buddy registers itself to **start when Windows signs in**.

---

## Start Buddy again later

Double-click **`Start Buddy.bat`**, or in the `buddy` folder run:

```powershell
npm run preview
```

You can pin `Start Buddy.bat` to the taskbar or create a Desktop shortcut to it (right-click → Send to → Desktop).

---

## Where your data is saved

All data stays on **your computer only**:

| File | Contents |
|------|----------|
| `%APPDATA%\buddy\buddy-data.json` | Notes and tasks |
| `%APPDATA%\buddy\buddy-config.json` | Icon/panel position and size |

Full example path:

`C:\Users\<YourName>\AppData\Roaming\buddy\`

- Open it quickly: press `Win + R`, type `%APPDATA%\buddy`, press Enter  
- Notes/tasks are written whenever you change them, so they survive restarting Buddy or rebooting the PC  
- To back up: copy that folder  
- To reset everything: quit Buddy (Task Manager → end **Electron**), then delete that folder  

---

## Useful commands

Run these from the `buddy` folder:

| Command | What it does |
|---------|----------------|
| `npm install` | Install/update dependencies |
| `npm run preview` | Build UI and start the app (**normal way to launch**) |
| `npm run dev` | Development mode with live reload |
| `npm run build` | Build the UI only (no window) |
| `node scripts/e2e-persist.mjs` | Quick test that save/load works |

---

## Troubleshooting

**`node` / `npm` not recognized**  
Reinstall Node.js from [nodejs.org](https://nodejs.org/) with PATH enabled, then open a **new** terminal.

**`npm install` fails**  
Make sure you are inside the `buddy` folder (you should see `package.json`). Try:

```powershell
npm install
```

again. If you are offline, connect to the internet for the first install.

**No icon appears**  
- Check the terminal for errors  
- Look behind other windows; Buddy stays on top but can sit at a previous position  
- Run `npm run preview` again from the project folder  

**Want to fully stop Buddy**  
Task Manager → find **Electron** (or Buddy) → End task.

**Turn off start-at-login**  
Windows Settings → **Apps** → **Startup** → disable the Electron/Buddy entry  
(or run Buddy once after changing code that clears login items — by default it enables login start).

**OneDrive / long paths**  
If the project lives under OneDrive and installs act weird, copy the folder to something short like `C:\buddy` and run from there.

---

## Privacy

- No accounts  
- No paid APIs required  
- Notes never leave your machine unless you copy the files yourself  
