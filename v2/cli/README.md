# App AI Gateway CLI, version 2

`agw` manages an [App AI Gateway](https://appaigateway.com/) v2 from a
terminal or a coding agent: providers, apps, their keys, limits and end
users. It needs Node.js 22.19 or newer.

agw 2 manages v2 gateways only. For a v1 gateway, keep using agw 1.x.

## Sign in

```sh
agw account login
```

With a browser on this machine, `agw` opens the console, you approve, and the
browser comes back to the terminal. Over SSH, without a display, or with
`--device`, it prints a link and a short code instead: open the link in any
browser, check the code matches, and approve. The sign-in renews itself;
`agw account logout` ends it. It is listed on the console's **Access** page,
where you can also revoke it.

For your own gateway, connect first:

```sh
agw deployment connect --url https://console.example.com
```

The URL is the gateway's console address. In CI and scripts, set
`AGW_MANAGEMENT_KEY` to a management key instead; nothing is stored then.

## Commands

```sh
agw --help                          # every command, including the gateway's
agw provider add --type openai      # the key goes in a hidden prompt
agw provider add --type openai --browser   # a person types the key in the console
agw app add --type ios --name "My App" --team-id ABCDE12345 --bundle-id com.example.app
agw app add --type server --name "Backend"  # its first key goes to a private file
agw app key add <app> --name ci             # another key, also to a private file
agw app update <app> --status disabled
agw app list
```

Most commands come from the gateway itself, as its tools, so a new gateway
release brings its commands without an `agw` update. `--json` prints one
document for agents and scripts.

What newer gateways promise to an installed `agw` is in
[COMPATIBILITY.md](./COMPATIBILITY.md).
