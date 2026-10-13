# @kyomel/pi-prime-devin

Use your Devin (devin.ai) subscription's model catalog inside **pi** and **Prime Agent**.

Connect one Devin key. The package lists every model that account can run,
excluding the `fusion` family, and serves those models to both agents. Calls go
to the same endpoint the Devin CLI uses, so usage draws on your Devin quota.

Unofficial project. Not affiliated with or endorsed by Cognition.

## Connect a key

The key is resolved in this order, and the chat calls and the model catalog
always use the same one:

1. `DEVIN_API_KEY` - for one process, nothing written to disk.
2. `~/.config/devin-pi-prime/credentials.json` - written by `pi-prime-devin auth`, mode 600.
3. `~/.local/share/devin/credentials.toml` - the Devin CLI's own sign-in, so a
   machine that already ran `devin auth login` needs no extra step.

```sh
cd /path/to/devin-pi-prime
bun src/cli.ts auth          # paste the key on stdin, checks it, then stores it
bun src/cli.ts status        # key source, catalog, bridge, service
```

Run the CLI as `bun src/cli.ts <command>` from the checkout, or install it once
with `npm i -g .` and use `pi-prime-devin <command>`. The LaunchAgent does not
depend on `PATH`: it runs the CLI through bun by absolute path.

The Devin CLI is optional. Only source 3 needs it.

## How it works

```text
key (env | stored file | Devin CLI sign-in)
  |
  +-> GetUserJwt                     src/auth.ts
  |
  +-> GetCliModelConfigs             src/catalogApi.ts
  |     -> drop family "fusion" and fusion-* uids
  |     -> cache: $XDG_CACHE_HOME/devin-pi-prime/models.json
  |
  +-> pi                             index.ts
  |     registerProvider("devin", { models, refreshModels, streamSimple })
  |     -> streamDevin()             src/devin.ts - GetChatMessage, Connect-RPC over HTTP/1.1
  |     -> /devin-refresh  /devin-status
  |
  +-> Prime Agent                    src/install.ts + src/service.ts
        ~/.prime/agent/models.json   provider "devin", api: openai-completions
        -> http://127.0.0.1:18737/v1 src/proxy.ts - localhost OpenAI bridge
        -> kept alive by a macOS LaunchAgent

fallbacks: `devin models list` when the catalog API fails, then the last good cache
```

Prime Agent speaks only fixed wire formats, so it cannot call Devin directly.
The bridge presents the same models as an `openai-completions` provider, and the
LaunchAgent keeps it running across logins and crashes.

## Requirements

- One Devin key (see above)
- Bun (pi extensions and the CLI run on it)
- pi >= 1.1.0 and/or Prime Agent >= 0.10.0
- macOS for automatic bridge startup; on other systems run `serve` yourself

## pi

```sh
pi install /path/to/devin-pi-prime       # or npm:@kyomel/pi-prime-devin once published
pi --list-models devin
pi -p "hello" --provider devin --model claude-haiku-5-5-low
```

Commands inside pi:

- `/devin-refresh` - refetch the catalog and swap it in
- `/devin-status` - key source, model count, last refresh, cache path

The catalog loads from cache at startup and refreshes in the background. pi needs
no bridge.

## Prime Agent

```sh
bun src/cli.ts install                   # catalog + models.json + LaunchAgent
prime-agent model list devin
prime-agent -p "hello" --provider devin --model claude-haiku-5-5-low
```

```sh
bun src/cli.ts install --no-service      # write models.json only
bun src/cli.ts serve --port 9000         # run the bridge in the foreground
bun src/cli.ts uninstall                 # remove the provider entry and the service
```

`install` also proves the bridge answers on the port. If another process already
holds that port, it says so instead of reporting a bridge that never started.

## Model selection

Every Devin variant is registered under its exact `model_uid`
(`claude-haiku-5-5-low`, `swe-2-medium`, `gpt-5-6-sol-high`). Reasoning effort is
baked into the uid (`-low/-medium/-high/-xhigh/-max`), so the agents'
thinking-level selector does not apply. Some catalog entries expose raw enum
names such as `MODEL_GPT_5_2_HIGH`; those are Devin's own uids, passed through
unchanged.

## Notes and limits

- The wire protocol is Devin's internal model API (protobuf Connect-RPC). It is
  undocumented and can change; the package sends the same client version strings
  as the Devin CLI.
- `fusion` family models are excluded by design.
- The catalog API reports no dollar rates, so models show token counts with a
  zero price. The `devin models list` fallback carries rates when it is used.
- Image input is declared only for variants where Devin reports `supportsImages`.
- Model calls need network access to `server.codeium.com`, or to the deployment
  URL in your credentials.
- Cognition's OpenAI-compatible gateway at `server.codeium.com/api/v1` is not
  used: it needs an account permission ("AI Gateway") that this package cannot
  assume. The bridge exists for that reason.

## Development

```sh
npm install
npm run typecheck
bun test tests/
```

Layout: `src/credentials.ts` (key chain), `src/auth.ts` (GetUserJwt),
`src/catalog.ts` (model shape, fusion rule, cache), `src/catalogApi.ts` +
`src/catalogCli.ts` (catalog sources), `src/models.ts` (source order),
`src/devin.ts` (chat client), `src/proxy.ts` (OpenAI bridge), `src/install.ts` +
`src/service.ts` (Prime Agent provider and LaunchAgent), `src/cli.ts`,
`index.ts` (pi extension entry).

Protobuf schema files come from `jeopi-catalog` (MIT) via `@bufbuild/protobuf`.
The Connect client is adapted from `jeopi-ai`'s devin provider (MIT, Can Boluk).
