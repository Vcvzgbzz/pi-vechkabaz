# pi-vechkabaz

Connects [pi](https://github.com/earendil-works/pi) to ai.vechkabaz.com.

## Install

```bash
pi install git:github.com/Vcvzgbzz/pi-vechkabaz
```

Start `pi`. The first time, it asks for your API key (the site → Settings → API access).
Paste it and you're done: the default model becomes `vechkabaz/coder-max`.

Already had this server set up by hand in `~/.pi/agent/models.json`? The first start
replaces that entry with this one, keeps your key, and saves a backup next to the file.

## What you get

- **Models**, listed live from the server: `coder-max` (careful, the default), `coder`
  (fast), and whatever else your account can use. Switch with `/model`.
- **`web_search`** and **`web_fetch`**: the model can look things up and read pages.
  Limited to 60 an hour.
- `/vechkabaz-key` to change your key later.

**Screenshots:** paste with **Ctrl+V** (Cmd+V only pastes text in a terminal), or drag
the image file onto the pi window.

## Good to know

- Your key is stored in `~/.pi/agent/vechkabaz.json`, readable only by you.
- Every request made with your key is logged by the server, including each search and
  each page fetched.
- `VECHKABAZ_URL` points the extension at a different deployment.
