# k_yrs_go - Golang database for YJS CRDT using postgres + redis

### Clone

```bash
git clone --recurse-submodules git@github.com:kapv89/k_yrs_go.git
```

### Setup

1. Install [docker](https://docs.docker.com/engine/install/) and [docker-compose](https://docs.docker.com/compose/install/)
1. Make sure you can run `docker` without `sudo`.
1. [Install go](https://go.dev/doc/install)
1. [Install rust](https://www.rust-lang.org/tools/install)
1. [Install node.js v20.10.0+](https://github.com/nvm-sh/nvm)
1. Install [tsx](https://www.npmjs.com/package/tsx) globally `npm i -g tsx`
1. `cd k_yrs_go`
1. `npm ci`

### Run locally

```bash
turbo run dev
```

### Run test

Make sure you are running locally:

```bash
turbo run dev
```

Then run tests:

```bash
turbo run test
```

### Build

```bash
turbo run build
```

Server binary will be available as `k_yrs_go/server/server`.

#### Run in prod

You can see an example of running in prod in [server/server.sh](server/server.sh). Tweak it however you like.


If you want to run the prod binary with default dev infra, you can do the following:

1. Spin up dev infra:
    ```bash
    turbo run dev#dev
    ```
1. Run the prod server binary
    ```bash
    turbo run server
    ```
1. Optionally, run the test-suite
    ```bash
    turbo run test
    ```

