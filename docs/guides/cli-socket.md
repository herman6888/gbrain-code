# Warm CLI socket (Postgres)

Agents usually call gbrain by running the CLI once per question. On a Postgres
brain each of those calls opens its own database connection, reads config and
runs schema checks before it answers, and behind a transaction-mode pooler
every one of those steps is a network round trip. A long-running
`gbrain serve` already has all of that warm. The warm CLI socket lets that
serve answer this user's CLI reads directly, so `gbrain search` costs about
what the same search costs over MCP.

It is **off by default**. Nothing listens until you turn it on.

**Say to your agent:** *"Turn on gbrain's warm CLI socket for my running
serve so CLI searches stop paying a cold database connection each time."*

**Say to your agent:** *"Check whether my gbrain CLI reads are going through
the warm serve socket or the cold path."*

## Turn it on

Start the serve with the flag:

```bash
gbrain serve --cli-socket
```

or set the config key once and restart the serve:

```bash
gbrain config set serve.cli_socket true
```

The serve logs one line on stderr: `cli-socket: listening on …/run/cli.sock`,
or `cli-socket: not started: <reason>` when it cannot open the socket safely.
A serve on a mount brain (`gbrain serve --brain <mount>`, `GBRAIN_BRAIN_ID`, a
`.gbrain-mount` file or a mount path) never opens it: the socket serves the
host brain only.
Turn it off by removing the flag or running
`gbrain config set serve.cli_socket false`, then restarting the serve.
The serve reads the key from the config it already loaded when it connected,
so a serve with the socket off does no work for it: it loads none of the
socket's code and sends the database nothing extra. A serve that started
degraded (database unreachable at boot) does not see the key; pass
`--cli-socket` there.

## What goes through it

Only reads: `gbrain search`, `gbrain query` (and `ask`), `gbrain get`, and the
`gbrain recall` forms that run the recall operation (`--query`,
`--budget-tokens`, `--question`, `--budget-policy`). The serve runs them
through the same operation handlers with the same trusted local-CLI context,
using your CLI's working directory and `GBRAIN_SOURCE` for source resolution,
and the CLI prints the result with its usual renderer: the same stdout, stderr
notices, `--json` documents and exit codes. Everything else, every write
included, keeps the normal path.

Some calls take the normal path even with the socket on: `--explain`,
`--brain <mount>`, `query --image`, input piped on stdin, the briefing,
watch, cursor and rollup forms of `recall`, and a page large enough that
`get` streams it.

## When it is not used

The CLI falls back to its normal path, silently, when:

- no serve has the socket open, or the serve died and left a stale socket;
- the serve does not accept the request within about a second (a wedged serve
  never stalls the CLI);
- the answer takes longer than 30 seconds, or than the call's `--timeout` when
  that is shorter, the serve's own read deadline passes, or the serve dies in
  the middle of the request: the CLI then runs the call itself, once, with its
  usual timeout and exit codes (it can only be a read, so running it again is
  safe). A warm read that runs past 30 seconds therefore runs a second time
  cold, so a slow LLM-backed query (`query`, `recall --question`) can cost
  twice; pass a shorter `--timeout` or set `GBRAIN_CLI_SOCKET=0` for those;
- the serve answers with a frame the CLI cannot fully read or render (nothing
  is printed from it);
- the serve was started for a different brain or environment: the CLI sends a
  token built from the brain (host or mount), the database target (without
  the password), the config home, the config file (path and content), the
  gbrain version and a digest of the environment that changes answers or
  where query text is sent (every `GBRAIN_*` setting except
  `GBRAIN_CLI_SOCKET`, `GBRAIN_DEBUG`, `GBRAIN_SQL_TRACE` and
  `GBRAIN_SOURCE`, which every request carries and the serve resolves for that
  call; which provider API keys are set, never their values; and the values of
  the provider routing settings: base URLs, endpoints, deployments, API
  versions, org, project and group ids), and the serve answers only an
  identical one. Editing
  `config.json`, changing those variables or upgrading gbrain while a serve
  runs sends CLI calls to the normal path until the serve restarts with the
  same settings;
- the CLI targets a mount brain (`--brain <mount>` and the other mount tiers).

`GBRAIN_DEBUG=1` prints one `[cli-socket] cold path: <reason>` line on stderr
whenever a call falls back. `GBRAIN_CLI_SOCKET=0` makes a CLI call skip the
socket entirely, for comparisons and benchmarks.

## Security

- **Unix domain socket only**, at `$GBRAIN_HOME/.gbrain/run/cli.sock`; never TCP.
- The `run` directory is created `0700` and must be owned by your uid; the
  socket is `0600`. Both the serve (before binding) and the CLI (before
  connecting) refuse a symlink, a directory or socket owned by another uid, or
  open permissions. `GBRAIN_HOME` and `.gbrain` above it must be yours too and
  writable by no one else (a sticky directory excepted); the serve refuses
  otherwise and never repairs them. The serve binds under umask `0177`, so the
  kernel creates the socket `0600`; it then checks the path is its own private
  socket and never changes permissions through it.
- On every connection the serve reads the peer's uid from the kernel
  (`SO_PEERCRED` on Linux, `getpeereid` on macOS) and drops any other uid
  before reading the request. The CLI checks the serve's uid the same way.
  Where peer credentials cannot be read (another operating system, or a
  runtime that hides the socket descriptor), the serve refuses to open the
  socket and says why, and the CLI never connects.
- One serve per `GBRAIN_HOME` holds the socket; requests and responses are
  size-bounded and each connection carries exactly one request. At most 8
  requests run at once; a request that timed out keeps its slot until its work
  actually finishes, so slow requests cannot pile up.
- Postgres brains only. A PGLite brain's CLI calls already reach its running
  serve through the persistence socket.

## Differences from a cold call

A warm call skips the cold path's connect-time work, so one-time startup
notices (pending-migration warnings, upgrade disclosures) appear only on cold
calls. Each warm request reads the DB-plane config once, in one statement, and
answers every later config read in that request from it; nothing carries over
to the next request, so a `gbrain config set` reaches the next warm call.
