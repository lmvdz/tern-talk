# Tern Talk

Send a prompt to another [omp](https://github.com/can1357/oh-my-pi) session in Tern by block name. The recipient works in its own session; the sender can keep working while omp shows that a reply is pending. A plain reply is displayed without starting another model turn.

## Install

The `v0.1.0` rollout targets omp 19.1.1 and Tern 0.9.13. Authenticate Git on each machine with access to this private repository. For GitHub CLI users, `gh auth login` followed by `gh auth setup-git` configures HTTPS Git access.

```sh
omp install 'github:lmvdz/tern-talk#v0.1.0'
```

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
