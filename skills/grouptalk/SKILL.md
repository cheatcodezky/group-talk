---
name: grouptalk
description: Share a local Codex conversation as a GroupTalk room. Use when the user wants to open a LAN group chat or generate its invite so others can join the conversation and use shared Side Chat.
---

# GroupTalk

Start a browser room on the machine hosting the selected Codex conversation. Members on the same LAN can chat and open Side Chat in a browser. The host's Codex account handles model calls.

Use the `server/cli.mjs` bundled beside this file. Get the absolute path from this skill's installed location. Run with Node.js 22.13 or newer and a signed-in, local Codex runtime. The bundle has no npm dependencies.

1. Start the server from the source chat's project directory. Use a persistent terminal session so the server remains available after you return the link.

   ```sh
   node "/absolute/path/to/grouptalk/server/cli.mjs" --share
   ```

   The command uses `CODEX_THREAD_ID`. If the user names another local thread, pass `--thread <id>` and use its project directory. If the current ID is unavailable, ask for the ID from Codex `/status`. Never pick another chat by recency.
2. Wait for `GroupTalk 已启动` and a successful `/api/health` response on the printed local port. Then return the full owner link and the full LAN invite link, including their URL fragments. Keep the owner link for the host. If multiple physical interfaces are plausible, label the available LAN addresses.
3. Keep the server running. Tell the host to share the member link with people on the same network and use Ctrl+C in the hosting terminal to stop it. The room inherits the source conversation in a separate Codex branch. The host can open the same room again from the source chat to resume it after stopping.

Opening the room makes the source history available to members who join. The invitation link grants room access. Use a trusted LAN where the intended members can reach the host. On startup failure, show the concrete error and resolve the missing prerequisite before providing an invite.
