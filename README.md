# k_yrs_go - Golang database for YJS CRDT using Postgres + Redis

`k_yrs_go` is a database server for [YJS](https://docs.yjs.dev/) documents. It works on top of [Postgres](http://postgresql.org/) and [Redis](https://redis.io/).
`k_yrs_go` uses binary redis queues as I/O buffers for YJS document updates, and uses the following PG table to store the updates:

```sql
CREATE TABLE IF NOT EXISTS k_yrs_go_yupdates_store (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    data BYTEA NOT NULL
);

CREATE INDEX IF NOT EXISTS k_yrs_go_yupdates_store_doc_id_idx ON k_yrs_go_yupdates_store (doc_id);
```

Rows in `k_yrs_go_yupdates_store` undergo compaction when fetching the state for a document if the number of
rows of updates for the `doc_id` are > 100 in count. Compaction happens in a serializable transaction, and the
combined-yupdate is inserted in the table only when the number of deleted yupdates is equal to what was fetched
from the db.

Even the Reads and Writes happen in serializable transactions. From what all I have read about databases, Reads, Writes, and Compactions in `k_yrs_go` should be consistent with each other.

Max document size supported is [1 GB](https://www.postgresql.org/docs/7.4/jdbc-binary-data.html#:~:text=The%20bytea%20data%20type%20is,process%20such%20a%20large%20value.).

## Usage:

```ts
import axios from 'axios';

const api = axios.create({ baseURL: env.SERVER_URL }); // `env.SERVER_URL is where `k_yrs_go/server` is deployed

const docId = uuid();
const ydoc = new Y.Doc();

// WRITE
ydoc.on('update', async (update: Uint8Array, origin: any, doc: Y.Doc) => {
    api.post<Uint8Array>(`/docs/${docId}/updates`, update, {headers: {'Content-Type': 'application/octet-stream'}})
});

// READ
const response = await api.get<ArrayBuffer>(`/docs/${docId}/updates`, { responseType: 'arraybuffer' });
const update = new Uint8Array(response.data);
const ydoc2 = new Y.Doc();
Y.applyUpdate(ydoc2, update);

```

### Clone

```bash
git clone --recurse-submodules git@github.com:kapv89/k_yrs_go.git
```

### Setup

1. Install [docker](https://docs.docker.com/engine/install/) and [docker-compose](https://docs.docker.com/compose/install/)
1. Make sure you can [run `docker` without `sudo`](https://docs.docker.com/engine/install/linux-postinstall/).
1. [Install go](https://go.dev/doc/install)
1. [Install rust](https://www.rust-lang.org/tools/install)
1. [Install node.js v20.10.0+](https://github.com/nvm-sh/nvm)
1. Install [tsx](https://www.npmjs.com/package/tsx) globally `npm i -g tsx`
1. Install [turbo](https://turbo.build/repo/docs/getting-started/installation) `npm i -g turbo`
1. `cd k_yrs_go`
1. `npm ci`

### Run locally

```bash
turbo run dev
```

### Run test

```bash
turbo run test
```

## 1ms +- x write latencies!

[**latencies.png**](latencies.png) & [**system_config.png**](system_config.png)

Seems to be very fast on my system.

### Testing

Tests are written in typescript with actual YJS docs. They can be found in [`test/test.ts`](test/test.ts).

To run the test on prod binary:

1. First start the dev infra: `turbo run dev#dev`
1. Run the production binary on dev infra: `turbo run server`
1. Run the test suite: `turbo run test`


There are 4 types of tests:

#### Read-Write test

Read-Write test tests for persistence of 2 operations on a simple list, and ensures that reading them back is consistent. Relevant env params (with default values) are:

```ts
{
    RW_ITERS: 1, // number of times the read-write test suite should be run
    RW_Y_OPS_WAIT_MS: 0, // ms of wait between (rw) operations on yjs docs
}
```

#### Compaction test

Compaction test writes a large number of updates to a yjs doc, the performs the following checks:

1. Checks that the number of rows in the `k_yrs_go_yupdates_store` table for the test `doc_id` are > 100
    after the writes.
1. Fetches the yjs update for `doc_id`, loads them in another yjs doc and checks
    that this new yjs doc is consistent with the original yjs doc.
1. Checks that the number of rows in `k_yrs_go_yupdates_store` table for the test `doc_id` are <= 100
1. Fetches the yjs updates for `doc_id` again (this is after compaction) and verifies that the update is same as the previously fetched update.

Relevant env params (with default values) are:

```ts
{
    COMPACTION_ITERS: 1, // number of times the compaction test-suite should be run
    COMPACTION_YDOC_UPDATE_INTERVAL_MS: 0, // ms of wait between performing 2 update operations to the test yjs doc
    COMPACTION_YDOC_UPDATE_ITERS: 10000, // number of updates to be performed on the test yjs doc
    COMPACTION_Y_OPS_WAIT_MS: 0, // ms of wait between different compaction stages
}
```

#### Simple Consistency test

In this test, the following steps happen in sequence in a loop:

1. An update is written to test yjs doc, and gets persisted to the db server
1. State of doc is read back from the db server, and applied to a new yjs doc
1. The new yjs doc is compared to be consistent with the test yjs doc
1. Go back to #1

Relevant env params (with default values) are:

```ts
{
    CONSISTENCY_SIMPLE_ITERS: 1, // number of times the simple consistency test should be run
    CONSISTENCY_SIMPLE_READTIMEOUT_MS: 0, // ms to wait before reading yjs doc state from db server after a write to test yjs doc
    CONSISTENCY_SIMPLE_YDOC_UPDATE_ITERS: 10000, // number of updates to be applied to the test yjs doc
}
```

#### Load Consistency test

This test tries to get to the limits of how consistent writes and reads are for a frequently updated document which is also frequently fetched. This is important for scenarios where new user can try to request a document which is being frequently updated by multiple other users and you need to ensure that they get the latest state.

Relevant env params (with default values) are:

```ts
{
    CONSISTENCY_LOAD_TEST_ITERS: 1, // number of times the load consistency test should be run
    CONSISTENCY_LOAD_YDOC_UPDATE_ITERS: 10000, // number of updates to be applied to the test yjs doc
    CONSISTENCY_LOAD_YDOC_UPDATE_TIMEOUT_MS: 2, // ms to wait before applying an update to the test yjs doc
    CONSISTENCY_LOAD_READ_PER_N_WRITES: 5, // number of writes after which consistency of a read from the db server should be checked
    CONSISTENCY_LOAD_YDOC_READ_TIMEOUT_MS: 3, // ms to wait after an update before reading yjs doc state from db server and verifying its consistency
}
```

I wasn't able to reach a better (and stable) consistency under load numbers than this on my local machine.

### Build

If you are running the dev setup, stop it. It's gonna be useless after `build` runs because the C ffi files will get refreshed.

```bash
turbo run build
```

Server binary will be available at `server/server`. You can deploy this server binary in a horizontally scalable manner
like a normal API server over a Postgres DB and a Redis DB and things will work correctly.

#### Run prod binary

You can see an example of running in prod in [server/server.sh](server/server.sh). Tweak it however you like.
You'll also need the following generated files co-located with the `server` binary in a directory named `db`

1. `server/db/libyrs.a`
1. `server/db/libyrs.h`
1. `server/db/libyrs.so`

Directory structure for running prod binary using `server.sh` should look something like this:

```
deployment/
    |- .env
    |- server
    |- server.sh
    |- db/
        |- libyrs.a
        |- libyrs.h
        |- libyrs.so
```


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

### Configuration
See the file [`server/.env`](server/.env). You can tweak it however you want.

To make sure tests run after your tweaking `server/.env`, you'd need to tweak [`test/.env`](test/.env).

Relevant ones are:

```bash
SERVER_PORT=3000

PG_URL=postgres://dev:dev@localhost:5432/k_yrs_dev?sslmode=disable

REDIS_URL=redis://localhost:6379

DEBUG=true

REDIS_QUEUE_MAX_SIZE=1000
```

# USE WITH [`yjs-scalable-ws-backend`](https://github.com/kapv89/yjs-scalable-ws-backend)