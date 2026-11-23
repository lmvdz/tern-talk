# Tern Talk

Send a prompt to another [omp](https://github.com/can1357/oh-my-pi) session in Tern by block name. The recipient works in its own session; the sender can keep working while omp shows that a reply is pending. A plain reply is displayed without starting another model turn.

## Install

Tern Talk v0.2.0 targets omp 19.1.1 and Tern 0.9.13. Each machine needs [Tailscale](https://tailscale.com) on your tailnet and Tern. From any one of them, run:

```sh
git clone https://github.com/lmvdz/tern-talk && cd tern-talk
bun setup.ts [-i IDENTITY_FILE] [user@]host ...
```

This sets up this machine and every listed host over SSH, then checks that they can all reach each other. On each host it:

- installs bun and omp if they are missing;
- copies this package to `~/.omp/tern-talk-releases/<version>` and runs `omp install` on it (the other machines need no GitHub login);
- if Tern is missing, runs `tern remote setup` from this machine to install it;
- on Windows, adds an inbound firewall rule for TCP 7470 from `100.64.0.0/10`, when the SSH user is an admin.

When it finishes it prints one `ok`/`FAIL` line per host. Target hosts need an SSH server: Linux has one; on macOS turn on **System Settings › General › Sharing › Remote Login**; on Windows enable OpenSSH Server. Run it again to upgrade every host. Restart omp sessions afterwards so they load the new version.

## Use

In an omp session inside Tern, type `@` in an empty composer and pick a block. Other machines appear as `@host/`; pick one to see its blocks.

```text
@ZKAPI Review the API error handling
@ip-172-31-19-172/ZKAPI Review the API error handling; then here: fix anything the review finds
```

The `; then here:` clause runs only in the sender after a reply. Agents can hand work off with `tern_send` and resume from a correlated reply. Every omp session in Tern listens automatically under its tab or block name; `/tern-talk listen NAME` sets an explicit address and `/tern-talk stop` pauses it. Requests from this machine and from your other machines run automatically when the recipient is idle, under its usual tool approvals, and the final answer goes back to the sender. `/tern-talk reply ID TEXT` answers by hand instead.

## How cross-host delivery works

The first omp session on a machine starts `daemon.ts`, a small HTTP service bound only to that machine's Tailscale IPv4 address on port 7470 (`TERN_TALK_PORT` overrides it). It exits two minutes after the last omp session stops listening. The sending machine's name comes from Tailscale: the service maps the WireGuard source address to a tailnet node. It accepts only nodes that belong to the same Tailscale user and are untagged, so there is no separate allowlist. A request to an unknown or stopped alias fails immediately. Messages are limited to 60 KiB.

Versions before 0.2.0 delivered through tern-link and a switchboard window. That transport is gone, so v0.1.x and v0.2.x hosts cannot talk to each other.

## Credit

Local agent discovery takes its approach from Wolfgang Schoenberger's [tern-control](https://github.com/wolfiesch/tern-control): look up Tern panes and classify their foreground processes. Tern Talk's address picker, mailboxes, and reply protocol are separate. See [THIRD_PARTY_NOTICES](./THIRD_PARTY_NOTICES) for the upstream MIT notice.
