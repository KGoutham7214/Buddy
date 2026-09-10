# Buddy

A small **always-on-top** desktop helper for Windows.

A light-brown square sits on your screen. Click it to open notes, tasks, and meeting notes. Everything stays on your PC — no account, no subscription, no cloud.

---

## What Buddy can do

- Keep **notes** with tasks and unlimited nested subtasks
- Set a **reminder** on a task (minutes, hours, or days)
- Get a **good-morning todo nudge** the first time Buddy opens that day
- Record a meeting (mic + computer sound), then get a transcript, summary, and action items
- Start automatically when you sign in to Windows

---

## What you need first

Buddy is a Windows app. Before you start, install these two things.

### 1. Windows

Windows 10 or Windows 11.

### 2. Node.js (required)

Node.js lets your PC run Buddy.

1. Open [https://nodejs.org](https://nodejs.org)
2. Download the **LTS** version (the green button)
3. Run the installer
4. Leave **Add to PATH** checked
5. Finish the install, then **close and reopen** any terminal you had open

Check that it worked. Press `Win + R`, type `powershell`, press Enter, then run:

```powershell
node -v
npm -v
```

You should see version numbers, for example `v20.11.0` and `10.2.4`.  
If you see “not recognized”, install Node.js again and open a **new** PowerShell window.

### 3. Optional tools (only for the Meet tab)

Skip this if you only want notes and tasks.

| Tool | Why | How |
|------|-----|-----|
| **Python 3.10+** | Turns meeting audio into text | [python.org](https://www.python.org/downloads/) — tick **Add python.exe to PATH** |
| **faster-whisper** | The speech-to-text engine | After Python: `pip install faster-whisper` |
| **Ollama + a model** | Writes the meeting summary | [ollama.com](https://ollama.com), then `ollama pull llama3.2` |

---

## Get the code from GitHub

Pick **one** method.

### Option A — Download a ZIP (easiest)

1. Open the GitHub page for this project
2. Click the green **Code** button
3. Click **Download ZIP**
4. Unzip the file, for example to your Desktop
5. You should now have a folder named `buddy` (or `buddy-main`) that contains `package.json` and `Start Buddy.bat`

### Option B — Clone with Git

If you already use Git:

```powershell
git clone https://github.com/<your-username>/buddy.git
cd buddy
```

Replace `<your-username>` with the GitHub account that owns the repo.

**Tip:** Keep the project off OneDrive if you can. A short path like `C:\dev\buddy` avoids login/start problems with spaces in folder names.

---

## First-time setup

1. Open the `buddy` folder in File Explorer
2. Double-click **`Start Buddy.bat`**
3. The first run may take a minute. It installs packages, then opens the app
4. Look for a **light-brown square** on your desktop (often near the bottom-right)

If Windows asks “Do you want to allow this app?”, choose **Yes** / **Run**.

### Or use the terminal

Open the `buddy` folder, click the address bar, type `powershell`, press Enter:

```powershell
npm install
npm run preview
```

A brown icon should appear. Click it to open Buddy.

---

## How to use Buddy

| What you want | What to do |
|---------------|------------|
| Move the icon | Drag it |
| Open the app | Click the icon |
| Close the panel (keep the icon) | Click **−** in the top-right |
| Notes vs meetings | Use the **Notes** and **Meet** tabs |
| New note | **Notes** → **New note** |
| Add a task | Type under **Tasks** and click **+** |
| Add a subtask | Hover a task → click **+** (you can nest as deep as you want) |
| Remind me about a task | Hover the task → clock icon → type a number → pick **min / hr / day** → **Set** |
| When a reminder pops up | **Open** the note, **Snooze 1h**, or **Later** / **×** |
| Resize the window | Drag a corner or edge |
| Record a meeting | **Meet** → **Record meeting** → when done, **Stop & process** |

There is no Quit button on purpose. Buddy is meant to stay nearby. To hide it, click **−**.

After the first successful launch, Buddy can register itself to **open when you sign in to Windows**. See [Start Buddy automatically at login](#start-buddy-automatically-at-login) for setup, checks, and how to turn it off.

---

## Start Buddy automatically at login

Use this if you cloned the repo and want the brown icon waiting for you after you sign in, without opening a terminal each day.

### Windows (automatic)

Buddy registers login startup **about 1–2 minutes after the first successful launch**. You do not need to edit the registry yourself.

What it sets up:

| What | Purpose |
|------|---------|
| **Registry Run entry** (`Buddy`) | Starts Buddy shortly after sign-in |
| **Scheduled Task** (`BuddyAutostart`) | Backup start ~75 seconds after logon (helps when OneDrive or network drives delay files) |
| **`%APPDATA%\buddy\start-buddy.ps1`** | Wrapper that points at your project folder and Electron |
| **`%APPDATA%\buddy\autostart.log`** | Log file if login start fails |

**Check that it worked**

1. Fully quit Buddy (Task Manager → **Electron** → End task).
2. Sign out and sign back in, or restart Windows.
3. Wait up to **2 minutes** (the task is delayed on purpose).
4. Look for the light-brown square on your desktop.

If nothing appears, open the log:

```powershell
notepad $env:APPDATA\buddy\autostart.log
```

Common log messages:

| Log line | Meaning |
|----------|---------|
| `already running electron pid …` | Buddy is already open (normal if you started it twice) |
| `verified electron pid …` | Login start succeeded |
| `WARNING: Buddy did not stay running` | Launch failed; try manual start below |
| `gave up waiting for Buddy files` | Project path or `dist\index.html` was missing at boot |

**Tips for reliable Windows autostart**

- Keep the repo at a **fixed path**, for example `C:\dev\buddy`.
- Avoid OneDrive-synced folders if login start is flaky.
- Run **`npm install`** and start Buddy once from that folder before relying on autostart.
- After moving the project, launch Buddy once manually so it rewrites the autostart scripts with the new path.

**Turn off Windows autostart**

- **Settings** → **Apps** → **Startup** → turn off **Buddy**
- **Task Scheduler** → delete or disable **BuddyAutostart**
- Optional: remove the `Buddy` value under  
  `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run`

**Manual Windows fallback**

If automatic registration fails, you can still start Buddy at login:

1. Press `Win + R`, type `shell:startup`, press Enter.
2. Create a shortcut to **`Start Buddy.bat`** in your project folder.
3. Or pin your own shortcut that runs `npm run preview` from the `buddy` folder.

---

### MacBook (manual setup)

Buddy is built and tested on **Windows**. On a Mac you can still clone and run it from source, but **login startup is not registered automatically** yet. Set it up once as follows.

**1. One-time project setup**

```bash
git clone https://github.com/<your-username>/buddy.git
cd buddy
npm install
npm run build
```

Replace `<your-username>` with the GitHub account that owns the repo.

**2. Create a start script**

Save this as `start-buddy.sh` inside the project folder (adjust the path):

```bash
#!/bin/bash
cd "/Users/you/dev/buddy"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
npm start
```

Make it executable:

```bash
chmod +x start-buddy.sh
```

Use `npm start` (Electron only) after `npm run build`. It is faster at login than `npm run preview`, which rebuilds every time.

**3. Add it to Login Items (easiest)**

1. Open **System Settings** → **General** → **Login Items**
2. Under **Open at Login**, click **+**
3. Select **`start-buddy.sh`** (or create a small Automator app that runs the script)
4. Turn the entry **on**

On older macOS versions: **System Settings** → **Users & Groups** → your user → **Login Items**.

**4. Optional: LaunchAgent (more control)**

Create `~/Library/LaunchAgents/com.buddy.dev.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.buddy.dev</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>cd /Users/you/dev/buddy &amp;&amp; npm start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/buddy-autostart.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/buddy-autostart.err</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.buddy.dev.plist
```

To remove later:

```bash
launchctl unload ~/Library/LaunchAgents/com.buddy.dev.plist
rm ~/Library/LaunchAgents/com.buddy.dev.plist
```

**Mac notes**

- Install **Node.js LTS** from [nodejs.org](https://nodejs.org) first.
- Some **Meet** features (Whisper, voice ID, system audio capture) may be limited or need extra setup on macOS.
- If the icon does not appear, run `./start-buddy.sh` in Terminal and read the error, or check `/tmp/buddy-autostart.err`.

---

## Open Buddy again later

Any of these work:

- Double-click **`Start Buddy.bat`**
- Or in the `buddy` folder run `npm run preview`
- Or wait for it after you sign in to Windows (see [Start Buddy automatically at login](#start-buddy-automatically-at-login))

You can make a Desktop shortcut: right-click `Start Buddy.bat` → **Send to** → **Desktop (create shortcut)**.

---

## Meet tab (optional)

Use this when you want Buddy to listen to a call and write notes for you.

### One-time Meet setup

1. Install **Python 3.10+** from [python.org](https://www.python.org/downloads/)  
   Tick **Add python.exe to PATH**
2. Open a new PowerShell window and run:

```powershell
pip install faster-whisper
python -c "import faster_whisper; print('ok')"
```

The last line should print `ok`.

3. Install **Ollama** from [ollama.com](https://ollama.com) and start it
4. Download a free local model (one time, a few GB):

```powershell
ollama pull llama3.2
```

Leave Ollama running in the background.

### Record a meeting

1. Open Buddy → **Meet**
2. Check the chips: **Whisper ready** and **Ollama ready**
3. Click **Record meeting**  
   Allow the microphone. Windows may also ask to share a screen — that is how Buddy captures Zoom/Teams sound
4. Join your call as usual. You can minimize Buddy; recording continues (the icon turns red)
5. Click **Stop & process**
6. Wait while it transcribes, then summarizes

You should get a title, a written summary, key points, decisions (if any), and action items **only if** the AI found real follow-ups.

If system sound cannot be captured, Buddy records **your mic only** and tells you.

---

## Where your data lives

Nothing is uploaded. Files stay here:

| Location | What is in it |
|----------|----------------|
| `%APPDATA%\buddy\buddy-data.json` | Notes, meetings, tasks, reminders |
| `%APPDATA%\buddy\buddy-config.json` | Window position and size |
| `%APPDATA%\buddy\recordings\` | Meeting audio |
| `%APPDATA%\buddy\autostart.log` | Login-start log (if Buddy did not open at boot) |

Open that folder quickly: press `Win + R`, type `%APPDATA%\buddy`, press Enter.

- **Back up:** copy the `buddy` folder inside AppData  
- **Reset everything:** fully quit Buddy (see below), then delete that folder  

---

## Commands (from the `buddy` folder)

| Command | When to use it |
|---------|----------------|
| `npm install` | First time, or after you pull new code |
| `npm run preview` | Normal way to start the app |
| `npm run build` | Rebuild the UI only |
| `npm run dev` | Developers: live reload |

---

## Troubleshooting

**`node` or `npm` is not recognized**  
Install Node.js LTS from [nodejs.org](https://nodejs.org), keep **Add to PATH** checked, then open a **new** PowerShell window.

**Double-clicking `Start Buddy.bat` flashes and closes**  
Open PowerShell in the `buddy` folder and run `npm install` then `npm run preview` so you can read the error.

**`npm install` fails**  
Make sure you are inside the folder that contains `package.json`. You need internet for the first install.

**No brown icon**  
- Look at other monitors; the icon remembers its last place  
- Check the terminal for errors  
- Run `npm run preview` again from the project folder  

**Buddy did not start after reboot**  
See [Start Buddy automatically at login](#start-buddy-automatically-at-login). Wait about two minutes, then open `%APPDATA%\buddy\autostart.log`. You can always start it with `Start Buddy.bat`.

**Turn off start-at-login**  
See **Turn off Windows autostart** under [Start Buddy automatically at login](#start-buddy-automatically-at-login).

**Fully quit Buddy**  
Task Manager (`Ctrl + Shift + Esc`) → **Electron** or **Buddy** → **End task**.

**Meet: Whisper missing**  

```powershell
pip install faster-whisper
```

**Meet: Ollama missing / empty summary**  
Start the Ollama app, then run `ollama pull llama3.2`.

**Meet: no system audio**  
Allow screen/audio capture when Windows asks. If it still fails, only your microphone is recorded.

**Meet: clip not saved**  
Buddy only skips a note when the recording is silence or junk. Short standups still save; the AI summary may be empty.

**Folder is on OneDrive and installs or autostart break**  
Copy the project to `C:\dev\buddy` and run it from there.

---

## Privacy

- No login  
- No paid API keys  
- Notes and recordings stay on your machine unless you copy the files yourself  

Meeting transcription and summaries run **locally** (Whisper + Ollama on your PC).
