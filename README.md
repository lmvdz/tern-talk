# Tern Talk

Send a prompt to another [omp](https://github.com/can1357/oh-my-pi) session in Tern by block name. The recipient works in its own session; the sender can keep working while omp shows that a reply is pending. A plain reply is displayed without starting another model turn.

## Install

The `v0.1.1` rollout targets omp 19.1.1 and Tern 0.9.13. Sign in with `gh auth login` on each machine using an account with access to this private repository. Download the pinned release with `gh`, then link the extracted package into omp. Bun's `github:` installer requests the GitHub tarball without the Git credential helper and cannot install this private repo directly.

**Linux / macOS**

```sh
tag=v0.1.1
dest="$HOME/.omp/tern-talk-releases/$tag"
mkdir -p "$dest"
gh release download "$tag" --repo lmvdz/tern-talk --archive=tar.gz --output "$dest/source.tar.gz"
tar -xzf "$dest/source.tar.gz" --strip-components=1 -C "$dest"
rm "$dest/source.tar.gz"
omp install "$dest"
```

**Windows (PowerShell)**

```powershell
$tag = 'v0.1.1'
$dest = Join-Path $HOME ".omp\tern-talk-releases\$tag"
New-Item -ItemType Directory -Force $dest | Out-Null
$archive = Join-Path $dest 'source.zip'
gh release download $tag --repo lmvdz/tern-talk --archive=zip --output $archive
tar.exe -xf $archive --strip-components=1 -C $dest
Remove-Item -LiteralPath $archive
omp install $dest
```

Keep the extracted version directory: omp links to it rather than copying it.

If migrating from a loose `tern-talk` extension in your omp agent's `extensions/` directory, move the old copy outside that directory before restarting omp. In each new omp session inside Tern, type `@` in an empty composer and select a block. No relay or separate opt-in is needed for same-machine messaging.

```text
@ZKAPI Review the API error handling
@ZKAPI Review the API error handling; then here: fix anything the review finds
```

The `; then here:` clause runs only in the sender after a reply. Agents can hand work off with `tern_send` and resume from a correlated reply. `/tern-talk listen NAME` sets an explicit address for the current omp session; `/tern-talk stop` pauses its listener. Only listening omp sessions can receive a Tern Talk request. Other detected agents may appear in the picker but are not addressable.

## Enable cross-host messaging

1. Install the same Tern Talk tag on each machine. Have `tern`, `tern-link`, and `bun` on `PATH`, and enroll both `tern-link` ports with the same switchboard. `tern-link ls` should show the expected host names. Tern Talk does not provision the switchboard.
2. On each host, append one rule per trusted peer to the port's existing `policy.toml`. The directory is `TERN_LINK_HOME` if set, otherwise `~/.tern-link` on Linux/macOS and `%LOCALAPPDATA%\tern-link` on Windows. Use the same `TERN_LINK_HOME` in the port and in Tern/omp if overriding it.

   ```toml
   [[allow]]
   origin = "trusted-peer-host"
   to = ["omp-talk"]
   rights = ["send"]
   ```

   Allow both directions for request and reply. A host allowed to contact the relay can discover its listening omp addresses. Keep this allowlist narrow.
3. With the `tern-link` port running, run `/tern-talk relay` from any omp composer in Tern. Leave the dedicated relay tab running. `tern-link ls` should show the `omp-talk` alias on each participating host once the directory updates.
4. Send `@host/ZKAPI Review the API error handling`. The recipient gets a request card and can use `/tern-talk accept ID` to run it as a prompt, or `/tern-talk reply ID TEXT` to send a reply without running the agent. Remote requests are never auto-run.

Cross-host delivery on Windows requires a working Windows `tern-link` port and has not been verified for this release.

## Credit

Local agent discovery takes its approach from Wolfgang Schoenberger's [tern-control](https://github.com/wolfiesch/tern-control): look up Tern panes and classify their foreground processes. Tern Talk's address picker, mailboxes, and reply protocol are separate. See [THIRD_PARTY_NOTICES](./THIRD_PARTY_NOTICES) for the upstream MIT notice.
